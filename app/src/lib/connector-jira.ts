/**
 * @file The Jira Cloud connector: signs in with Atlassian OAuth 2.0 (3LO) and reads issues, read-only. The
 * framework (lib/connectors.ts) handles tokens, syncing, health and indexing; this file only knows Jira.
 *
 * Concepts
 * - **Sign-in**: Atlassian's OAuth 2.0 authorization code flow ("3LO") with the read-only scopes
 *   `read:jira-work` and `read:jira-user`, plus `offline_access` for a refresh token. Atlassian **rotates**
 *   refresh tokens: every refresh returns a new one, which replaces the old (the framework saves it).
 *   App: `JIRA_CLIENT_ID` / `JIRA_CLIENT_SECRET` from the Atlassian developer console (created by Cody:
 *   docs/RUNBOOKS.md → Connector apps).
 * - **Site**: one Atlassian cloud site (`<name>.atlassian.net`), found through "accessible resources" after
 *   sign-in. If the account can open several, the one typed when connecting is used (otherwise the first).
 *   API calls go to `https://api.atlassian.com/ex/jira/<cloud id>/...`; links to the site's own address.
 * - **Project**: what gets linked to a group, by its key (e.g. "CUT").
 * - **Incremental sync**: JQL `project = KEY AND updated >= "<cursor>"` oldest first through the enhanced search
 *   (`/rest/api/3/search/jql`, pages of 50 with `nextPageToken`). JQL times are in the signing-in person's own
 *   time zone and only to the minute, so the cursor goes back a day to be safe; unchanged issues are skipped
 *   (text hash) so the overlap costs no re-indexing.
 * - **Each person signs in** (`personal`, docs/ARCHITECTURE.md → Connectors): a member's own Atlassian sign-in must
 *   open the connection's site (same cloud id); before an answer uses issues, `canOpen` asks Jira which of the
 *   candidate keys that person can open (`POST /rest/api/3/issue/bulkfetch`, up to 100 keys a call). Jira only
 *   returns issues the person may browse (project permissions, issue security levels), so anything missing is closed.
 *
 * Tests and the demo world point `JIRA_AUTH_BASE` and `JIRA_API_BASE` at a fake Jira (scripts/fake-tools.mjs);
 * both overrides are ignored in production.
 */
import "server-only";
import { adfToText, ConnectorError, dayOf, isoOf, type WorkItem } from "./connector-text";
import type { Provider } from "./connectors";

const SCOPE = "read:jira-work read:jira-user offline_access";
/** At most this many changed issues per sync (pages of 50); the rest come on the next run. */
export const MAX_PER_SYNC = 2000;
const PAGE = 50;
const FIELDS = ["summary", "status", "assignee", "duedate", "issuetype", "updated", "issuelinks", "comment", "description", "labels", "parent"];

const dev = (v: string | undefined, real: string) => (process.env.NODE_ENV !== "production" && v ? v.replace(/\/$/, "") : real);
const authBase = () => dev(process.env.JIRA_AUTH_BASE, "https://auth.atlassian.com");
const apiBase = () => dev(process.env.JIRA_API_BASE, "https://api.atlassian.com");
const conf = () => ({ id: process.env.JIRA_CLIENT_ID ?? "", secret: process.env.JIRA_CLIENT_SECRET ?? "" });

type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };

async function token(body: Record<string, string>): Promise<TokenReply & { status: number }> {
  const c = conf();
  const res = await fetch(`${authBase()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: c.id, client_secret: c.secret, ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, ...((await res.json().catch(() => ({}))) as TokenReply) };
}

/** A JQL time ("yyyy/MM/dd HH:mm") one day before the cursor (see the file comment), or null without one. */
export function jqlSince(cursor: string | null): string | null {
  if (!cursor) return null;
  const t = new Date(cursor);
  if (Number.isNaN(t.getTime())) return null;
  const d = new Date(t.getTime() - 86400_000).toISOString();
  return `${d.slice(0, 10).replace(/-/g, "/")} ${d.slice(11, 16)}`;
}

type JiraIssue = {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    assignee?: { displayName?: string } | null;
    duedate?: string | null;
    issuetype?: { name?: string };
    updated?: string;
    description?: unknown;
    labels?: string[];
    parent?: { key: string; fields?: { summary?: string } };
    issuelinks?: { type?: { inward?: string }; inwardIssue?: { key: string; fields?: { summary?: string; status?: { name?: string } } } }[];
    comment?: { total?: number; comments?: { author?: { displayName?: string }; created?: string; body?: unknown }[] };
  };
};

export const jira: Provider = {
  kind: "jira",
  needsSite: false,
  configured: () => Boolean(conf().id && conf().secret),

  authorizeUrl({ state, redirectUri }) {
    const url = new URL(`${authBase()}/authorize`);
    url.search = new URLSearchParams({
      audience: "api.atlassian.com", client_id: conf().id, scope: SCOPE, redirect_uri: redirectUri, state, response_type: "code", prompt: "consent",
    }).toString();
    return url.toString();
  },

  async exchange(code, _verifier, redirectUri) {
    const r = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    if (!r.access_token) return { error: r.error ?? `status ${r.status}` };
    return { access: r.access_token, refresh: r.refresh_token ?? null, expiresIn: r.expires_in ?? 3600 };
  },

  async refresh(refreshToken) {
    const r = await token({ grant_type: "refresh_token", refresh_token: refreshToken });
    if (!r.access_token) return { error: r.error ?? `status ${r.status}`, revoked: r.status === 400 || r.status === 401 || r.status === 403 };
    // Rotating refresh tokens: the new one replaces the old.
    return { access: r.access_token, refresh: r.refresh_token ?? refreshToken, expiresIn: r.expires_in ?? 3600 };
  },

  async account(api, site) {
    const r = await api(`${apiBase()}/oauth/token/accessible-resources`);
    const sites = ((r.json as { id: string; url: string; name: string }[]) ?? []).filter((s) => s.id && s.url);
    const want = site?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\.atlassian\.net.*$/, "");
    const pick = (want && sites.find((s) => s.name.toLowerCase() === want || s.url.toLowerCase().includes(`//${want}.`))) || (!want ? sites[0] : undefined);
    if (!pick) {
      throw new ConnectorError("notfound", want ? `This Atlassian account can't open a Jira site called “${site}”.` : "This Atlassian account can't open any Jira site.");
    }
    return { account: pick.id, accountName: pick.name, apiBase: `${apiBase()}/ex/jira/${encodeURIComponent(pick.id)}`, webBase: pick.url.replace(/\/$/, "") };
  },

  async projects(api, conn) {
    const out: { key: string; name: string }[] = [];
    for (let startAt = 0, page = 0; page < 50; page++) {
      const r = await api(`${conn.api_base}/rest/api/3/project/search?startAt=${startAt}&maxResults=50`);
      const j = r.json as { values?: { key: string; name: string }[]; isLast?: boolean };
      const values = j.values ?? [];
      for (const p of values) out.push({ key: p.key, name: p.name });
      if (j.isLast !== false || !values.length) break;
      startAt += values.length;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },

  personal: {
    async account(api, conn) {
      const r = await api(`${apiBase()}/oauth/token/accessible-resources`);
      const sites = ((r.json as { id: string }[]) ?? []).filter((s) => s?.id);
      if (!sites.some((s) => s.id === conn.account)) {
        throw new ConnectorError("access", `This Atlassian account can't open the Jira site ${conn.account_name ?? conn.account}. Sign in with the account the client gave you for that site.`, 403);
      }
      const me = (await api(`${conn.api_base}/rest/api/3/myself`)).json as { displayName?: string; emailAddress?: string } | null;
      return { accountName: me?.displayName || me?.emailAddress || "Jira user" };
    },
    async canOpen(api, conn, keys) {
      const open = new Set<string>();
      for (let i = 0; i < keys.length; i += 100) {
        const part = keys.slice(i, i + 100);
        const r = await api(`${conn.api_base}/rest/api/3/issue/bulkfetch`, { method: "POST", body: { issueIdsOrKeys: part, fields: ["summary"] } });
        const wanted = new Set(part);
        // Only keys asked for count: an issue moved meanwhile comes back under a new key and stays closed.
        for (const it of ((r.json as { issues?: { key?: string }[] } | null)?.issues ?? [])) if (it?.key && wanted.has(it.key)) open.add(it.key);
      }
      return open;
    },
  },

  async *changes(api, conn, project, cursor) {
    if (!/^[A-Z][A-Z0-9_]{0,49}$/i.test(project)) throw new ConnectorError("notfound", `“${project}” isn't a Jira project key.`);
    const since = jqlSince(cursor);
    const jql = `project = "${project}"${since ? ` AND updated >= "${since}"` : ""} ORDER BY updated ASC`;
    let next: string | undefined;
    for (let seen = 0; seen < MAX_PER_SYNC; ) {
      const r = await api(`${conn.api_base}/rest/api/3/search/jql`, {
        method: "POST",
        body: { jql, fields: FIELDS, maxResults: PAGE, ...(next ? { nextPageToken: next } : {}) },
      }, { what: `the project “${project}”` });
      const j = r.json as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean };
      const issues = j.issues ?? [];
      seen += issues.length;
      yield issues.map((it): WorkItem => {
        const f = it.fields;
        const blockers = (f.issuelinks ?? []).filter((l) => /blocked by/i.test(l.type?.inward ?? "") && l.inwardIssue);
        const comments = [...(f.comment?.comments ?? [])].reverse().slice(0, 3)
          .map((c) => ({ author: c.author?.displayName ?? "Someone", at: c.created ?? null, text: adfToText(c.body) }));
        return {
          externalId: it.key,
          type: f.issuetype?.name ?? null,
          title: f.summary ?? it.key,
          state: f.status?.name ?? null,
          assignee: f.assignee?.displayName ?? null,
          dueOn: dayOf(f.duedate),
          url: `${conn.web_base}/browse/${encodeURIComponent(it.key)}`,
          changedAt: isoOf(f.updated, new Date().toISOString()),
          description: adfToText(f.description),
          blockedBy: blockers.map((l) => `${l.inwardIssue!.key}${l.inwardIssue!.fields?.summary ? ` ${l.inwardIssue!.fields.summary}` : ""}${l.inwardIssue!.fields?.status?.name ? ` (${l.inwardIssue!.fields.status.name})` : ""}`),
          parent: f.parent ? `${f.parent.key}${f.parent.fields?.summary ? ` ${f.parent.fields.summary}` : ""}` : null,
          tags: f.labels ?? [],
          commentCount: Number(f.comment?.total ?? f.comment?.comments?.length ?? 0),
          comments,
        };
      });
      next = j.nextPageToken;
      if (!next || j.isLast || !issues.length) break;
    }
  },
};
