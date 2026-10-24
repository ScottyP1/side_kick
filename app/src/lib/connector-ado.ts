/**
 * @file The Azure DevOps Boards connector: signs in with Microsoft Entra ID and reads work items, read-only.
 * The framework (lib/connectors.ts) handles tokens, syncing, health and indexing; this file only knows ADO.
 *
 * Concepts
 * - **Sign-in**: Microsoft Entra ID (Azure DevOps' own OAuth apps are deprecated). The authorization code flow
 *   with PKCE asks for the delegated scope `vso.work` (read work items) on Azure DevOps' resource id
 *   `499b84ac-1321-427f-aa17-267ca6975798`, plus `offline_access` for a refresh token. Sidekick only ever reads.
 *   App: `ADO_CLIENT_ID` / `ADO_CLIENT_SECRET` (an Entra app for "accounts in any organizational directory",
 *   created by Cody: docs/RUNBOOKS.md → Connector apps), authority `ADO_TENANT` (default "organizations").
 * - **ADO organization**: the `dev.azure.com/<name>` part. The Org Owner types it when turning the tool on; Sidekick checks
 *   the signed-in account can open it. **Project**: what gets linked to a group (its whole board).
 * - **Incremental sync**: a WIQL query for items changed since the cursor (`[System.ChangedDate] > cursor`, with
 *   time precision), oldest first, at most `MAX_PER_SYNC` per run; then the items in batches of 200 (with their
 *   links, to find what blocks them), and the latest 3 comments of items that have any. Project lists come in
 *   pages (`x-ms-continuationtoken`).
 *
 * Tests and the demo world point `ADO_LOGIN_BASE`, `ADO_API_BASE` and `ADO_WEB_BASE` at a fake ADO
 * (scripts/fake-tools.mjs); these overrides are ignored in production.
 */
import "server-only";
import { LOGIN_BASE } from "./entra";
import { dayOf, htmlToText, isoOf, type WorkItem } from "./connector-text";
import type { Provider } from "./connectors";

/** Azure DevOps' resource id in Entra ID, and the read-only work items scope on it. */
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const SCOPE = `${ADO_RESOURCE}/vso.work offline_access`;
const API = "api-version=7.1";
/** At most this many changed items per sync; the rest come on the next run (the cursor has moved). */
export const MAX_PER_SYNC = 2000;
const BATCH = 200;

const dev = (v: string | undefined, real: string) => (process.env.NODE_ENV !== "production" && v ? v.replace(/\/$/, "") : real);
const loginBase = () => dev(process.env.ADO_LOGIN_BASE, LOGIN_BASE);
/** Where the ADO REST API lives (`https://dev.azure.com`). */
export const adoApiBase = () => dev(process.env.ADO_API_BASE, "https://dev.azure.com");
/** Where ADO's web pages are (links to work items). */
const adoWebBase = () => dev(process.env.ADO_WEB_BASE, "https://dev.azure.com");
const conf = () => ({ id: process.env.ADO_CLIENT_ID ?? "", secret: process.env.ADO_CLIENT_SECRET ?? "", tenant: process.env.ADO_TENANT || "organizations" });

type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };

async function token(form: Record<string, string>): Promise<TokenReply & { status: number }> {
  const c = conf();
  const res = await fetch(`${loginBase()}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, scope: SCOPE, ...form }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, ...((await res.json().catch(() => ({}))) as TokenReply) };
}

/** ADO's "Fields" bag on a work item (only the ones Sidekick reads). */
type AdoFields = Record<string, unknown> & {
  "System.Title"?: string;
  "System.State"?: string;
  "System.WorkItemType"?: string;
  "System.AssignedTo"?: { displayName?: string } | string;
  "System.ChangedDate"?: string;
  "System.Description"?: string;
  "System.Tags"?: string;
  "System.CommentCount"?: number;
  "Microsoft.VSTS.Scheduling.DueDate"?: string;
  "Microsoft.VSTS.Scheduling.TargetDate"?: string;
};
type AdoItem = { id: number; fields: AdoFields; relations?: { rel: string; url: string }[] };

const idFromUrl = (url: string) => url.match(/workItems\/(\d+)$/i)?.[1] ?? null;
const who = (a: AdoFields["System.AssignedTo"]) => (typeof a === "string" ? a.replace(/\s*<[^>]+>$/, "") : a?.displayName ?? null);

export const ado: Provider = {
  kind: "ado",
  needsSite: true,
  configured: () => Boolean(conf().id && conf().secret),

  authorizeUrl({ state, challenge, redirectUri }) {
    const c = conf();
    const url = new URL(`${loginBase()}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/authorize`);
    url.search = new URLSearchParams({
      client_id: c.id, response_type: "code", redirect_uri: redirectUri, response_mode: "query", scope: SCOPE, state,
      code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
    }).toString();
    return url.toString();
  },

  async exchange(code, verifier, redirectUri) {
    const r = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
    if (!r.access_token) return { error: r.error ?? `status ${r.status}` };
    return { access: r.access_token, refresh: r.refresh_token ?? null, expiresIn: r.expires_in ?? 3600 };
  },

  async refresh(refreshToken) {
    const r = await token({ grant_type: "refresh_token", refresh_token: refreshToken });
    if (!r.access_token) return { error: r.error ?? `status ${r.status}`, revoked: r.status === 400 || r.status === 401 };
    return { access: r.access_token, refresh: r.refresh_token ?? refreshToken, expiresIn: r.expires_in ?? 3600 };
  },

  async account(api, site) {
    const apiBase = `${adoApiBase()}/${encodeURIComponent(site!)}`;
    // Opening the organization's project list proves this account can read it.
    await api(`${apiBase}/_apis/projects?$top=1&${API}`, {}, { what: `the Azure DevOps organization “${site}”` });
    return { account: site!, accountName: site!, apiBase, webBase: `${adoWebBase()}/${encodeURIComponent(site!)}` };
  },

  async projects(api, conn) {
    const out: { key: string; name: string }[] = [];
    let token: string | null = null;
    for (let page = 0; page < 50; page++) {
      const r = await api(`${conn.api_base}/_apis/projects?$top=100${token ? `&continuationToken=${encodeURIComponent(token)}` : ""}&${API}`);
      for (const p of (r.json as { value?: { id: string; name: string }[] }).value ?? []) out.push({ key: p.name, name: p.name });
      token = r.headers.get("x-ms-continuationtoken");
      if (!token) break;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },

  async *changes(api, conn, project, cursor) {
    const base = `${conn.api_base}/${encodeURIComponent(project)}/_apis/wit`;
    const since = cursor && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(cursor) ? ` AND [System.ChangedDate] > '${cursor}'` : "";
    const safeProject = project.replace(/'/g, "''");
    const q = await api(`${base}/wiql?timePrecision=true&$top=${MAX_PER_SYNC}&${API}`, {
      method: "POST",
      body: { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${safeProject}'${since} ORDER BY [System.ChangedDate] ASC` },
    }, { what: `the project “${project}”` });
    const ids = ((q.json as { workItems?: { id: number }[] }).workItems ?? []).map((w) => w.id).slice(0, MAX_PER_SYNC);
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = await api(`${base}/workitemsbatch?${API}`, { method: "POST", body: { ids: ids.slice(i, i + BATCH), $expand: "Relations" } });
      const items = ((batch.json as { value?: AdoItem[] }).value ?? []);
      // The titles of what blocks these items (predecessors), fetched together when not in this batch.
      const blockerIds = new Set<string>();
      for (const it of items) for (const r of it.relations ?? []) if (r.rel === "System.LinkTypes.Dependency-Reverse") { const id = idFromUrl(r.url); if (id) blockerIds.add(id); }
      const known = new Map(items.map((it) => [String(it.id), it.fields]));
      const missing = [...blockerIds].filter((id) => !known.has(id)).slice(0, BATCH);
      if (missing.length) {
        const extra = await api(`${base}/workitemsbatch?${API}`, { method: "POST", body: { ids: missing.map(Number), fields: ["System.Title", "System.State"] } });
        for (const it of ((extra.json as { value?: AdoItem[] }).value ?? [])) known.set(String(it.id), it.fields);
      }
      const page: WorkItem[] = [];
      for (const it of items) {
        const f = it.fields;
        const rel = (name: string) => (it.relations ?? []).filter((r) => r.rel === name).map((r) => idFromUrl(r.url)).filter((x): x is string => !!x);
        const label = (id: string) => {
          const k = known.get(id);
          return `#${id}${k?.["System.Title"] ? ` ${k["System.Title"]}` : ""}${k?.["System.State"] ? ` (${k["System.State"]})` : ""}`;
        };
        let comments: WorkItem["comments"] = [];
        const count = Number(f["System.CommentCount"] ?? 0);
        if (count > 0) {
          const c = await api(`${base}/workItems/${it.id}/comments?$top=3&order=desc&api-version=7.1-preview.4`);
          comments = ((c.json as { comments?: { text?: string; createdBy?: { displayName?: string }; createdDate?: string }[] }).comments ?? [])
            .map((x) => ({ author: x.createdBy?.displayName ?? "Someone", at: x.createdDate ?? null, text: htmlToText(x.text) }));
        }
        const parent = rel("System.LinkTypes.Hierarchy-Reverse")[0];
        page.push({
          externalId: String(it.id),
          type: f["System.WorkItemType"] ?? null,
          title: f["System.Title"] ?? `Work item ${it.id}`,
          state: f["System.State"] ?? null,
          assignee: who(f["System.AssignedTo"]),
          dueOn: dayOf(f["Microsoft.VSTS.Scheduling.DueDate"]) ?? dayOf(f["Microsoft.VSTS.Scheduling.TargetDate"]),
          url: `${conn.web_base}/${encodeURIComponent(project)}/_workitems/edit/${it.id}`,
          changedAt: isoOf(f["System.ChangedDate"], new Date().toISOString()),
          description: htmlToText(f["System.Description"]),
          blockedBy: rel("System.LinkTypes.Dependency-Reverse").map(label),
          parent: parent ? label(parent) : null,
          tags: (f["System.Tags"] ?? "").split(";").map((t) => t.trim()).filter(Boolean),
          commentCount: count,
          comments,
        });
      }
      yield page;
    }
  },
};
