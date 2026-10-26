/**
 * @file The Confluence Cloud connector: signs in with Atlassian OAuth 2.0 (3LO), like Jira, and reads the pages of
 * a space as group **documents**, read-only. The framework (lib/connectors.ts) handles tokens, syncing, health
 * and indexing; this file only knows Confluence.
 *
 * Concepts
 * - **Sign-in**: the same Atlassian authorization code flow as Jira (lib/connector-jira.ts), with Confluence's
 *   read-only scopes (`read:confluence-content.all`, `read:confluence-space.summary`, `search:confluence`,
 *   `read:confluence-user` for the name of whoever signed in) plus `offline_access`; refresh tokens rotate. It uses **the same Atlassian app as Jira** where possible:
 *   `CONFLUENCE_CLIENT_ID` / `CONFLUENCE_CLIENT_SECRET` when set, otherwise `JIRA_CLIENT_ID` / `JIRA_CLIENT_SECRET`
 *   (the app then needs the Confluence API and scopes added: docs/RUNBOOKS.md → Connector apps). It is still its
 *   own connector (its own sign-in, health and plan slot), because people connect the two separately.
 * - **Site**: one Atlassian cloud site with Confluence, from "accessible resources" (only sites whose grant
 *   includes a Confluence scope). API calls go to `https://api.atlassian.com/ex/confluence/<cloud id>/wiki/...`;
 *   links go to the site's own address.
 * - **Space** (the framework's "project"): what gets linked to a group, by its key (e.g. "CUT"). Spaces come from
 *   the v2 API in pages (`_links.next`).
 * - **Pages**: each current page of the space with its text (storage format → plain text), labels, where it sits
 *   (ancestors) and who changed it last. Indexed as source type `page` like an uploaded document and cited with a
 *   link (lib/connector-text.ts `pageText`). Attachments, comments and blog posts aren't read.
 * - **Incremental sync** by last-modified: CQL `space = "KEY" AND type = page AND lastmodified >= "<cursor>"`
 *   oldest first, pages of 25 through `_links.next`. CQL times are in the signing-in person's own time zone and
 *   only to the minute, so (like Jira) the cursor goes back a day; unchanged pages are skipped by text hash.
 * - **Each person signs in** (`personal`, docs/ARCHITECTURE.md → Connectors): a member's own Atlassian sign-in must
 *   open the connection's site (same cloud id); before an answer uses pages, `canOpen` runs CQL
 *   `id in (…) AND type = page` with that person's token, up to `CHECK_BATCH` ids a call. Confluence search only
 *   returns pages the person may view (space permissions **and** page restrictions, inherited from parent pages),
 *   so a page that doesn't come back (restricted, deleted, not indexed yet) is closed.
 *
 * Tests and the demo world point `CONFLUENCE_AUTH_BASE` and `CONFLUENCE_API_BASE` at a fake Confluence
 * (scripts/fake-tools.mjs); both overrides are ignored in production.
 */
import "server-only";
import { ConnectorError, htmlToText, isoOf, type WorkItem } from "./connector-text";
import { jqlSince } from "./connector-jira";
import type { Provider } from "./connectors";

const SCOPE = "read:confluence-content.all read:confluence-space.summary search:confluence read:confluence-user offline_access";
/** How many page ids one "who can open these" CQL search asks about. */
export const CHECK_BATCH = 50;
/** At most this many changed pages per sync (pages of 25); the rest come on the next run. */
export const MAX_PER_SYNC = 1000;
const PAGE = 25;

const dev = (v: string | undefined, real: string) => (process.env.NODE_ENV !== "production" && v ? v.replace(/\/$/, "") : real);
const authBase = () => dev(process.env.CONFLUENCE_AUTH_BASE, "https://auth.atlassian.com");
const apiBase = () => dev(process.env.CONFLUENCE_API_BASE, "https://api.atlassian.com");
/** The Atlassian app: Confluence's own when set, otherwise the Jira one (same app, see the file comment). */
const conf = () => (process.env.CONFLUENCE_CLIENT_ID && process.env.CONFLUENCE_CLIENT_SECRET
  ? { id: process.env.CONFLUENCE_CLIENT_ID, secret: process.env.CONFLUENCE_CLIENT_SECRET }
  : { id: process.env.JIRA_CLIENT_ID ?? "", secret: process.env.JIRA_CLIENT_SECRET ?? "" });

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

/**
 * A Confluence `_links.next` (a path on the site, e.g. "/wiki/rest/api/content/search?cursor=…" or one without
 * the "/wiki" prefix) as a full API address under `base`; null when there is none or it isn't a plain path.
 */
export function confluenceNext(next: unknown, base: string): string | null {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return null;
  return `${base}${next.startsWith("/wiki/") ? next : `/wiki${next}`}`;
}

type CfPage = {
  id: string;
  title?: string;
  status?: string;
  body?: { storage?: { value?: string } };
  version?: { when?: string; by?: { displayName?: string } };
  ancestors?: { title?: string }[];
  metadata?: { labels?: { results?: { name?: string }[] } };
  _links?: { webui?: string };
};

export const confluence: Provider = {
  kind: "confluence",
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
    return { access: r.access_token, refresh: r.refresh_token ?? refreshToken, expiresIn: r.expires_in ?? 3600 };
  },

  async account(api, site) {
    const r = await api(`${apiBase()}/oauth/token/accessible-resources`);
    const sites = ((r.json as { id: string; url: string; name: string; scopes?: string[] }[]) ?? [])
      .filter((s) => s.id && s.url && (!s.scopes || s.scopes.some((x) => /confluence/i.test(x))));
    const want = site?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\.atlassian\.net.*$/, "");
    const pick = (want && sites.find((s) => s.name.toLowerCase() === want || s.url.toLowerCase().includes(`//${want}.`))) || (!want ? sites[0] : undefined);
    if (!pick) {
      throw new ConnectorError("notfound", want ? `This Atlassian account can't open Confluence on a site called “${site}”.` : "This Atlassian account can't open any Confluence site.");
    }
    return { account: pick.id, accountName: pick.name, apiBase: `${apiBase()}/ex/confluence/${encodeURIComponent(pick.id)}`, webBase: pick.url.replace(/\/$/, "") };
  },

  async projects(api, conn) {
    const out: { key: string; name: string }[] = [];
    let url: string | null = `${conn.api_base}/wiki/api/v2/spaces?limit=250&status=current`;
    for (let page = 0; url && page < 40; page++) {
      const j = (await api(url)).json as { results?: { key: string; name: string }[]; _links?: { next?: string } } | null;
      for (const s of j?.results ?? []) if (s.key) out.push({ key: s.key, name: s.name ?? s.key });
      url = confluenceNext(j?._links?.next, conn.api_base);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },

  personal: {
    /** The person's Atlassian account must open the connection's own site; their name comes from Confluence. */
    async account(api, conn) {
      const r = await api(`${apiBase()}/oauth/token/accessible-resources`);
      const sites = ((r.json as { id: string }[]) ?? []).filter((s) => s?.id);
      if (!sites.some((s) => s.id === conn.account)) {
        throw new ConnectorError("access", `This Atlassian account can't open Confluence on the site ${conn.account_name ?? conn.account}. Sign in with the account the client gave you for that site.`, 403);
      }
      const me = (await api(`${conn.api_base}/wiki/rest/api/user/current`)).json as { displayName?: string; publicName?: string; email?: string } | null;
      return { accountName: me?.displayName || me?.publicName || me?.email || "Confluence user" };
    },
    /** Which pages the person can view: CQL `id in (…)` with their own token (see the file comment). */
    async canOpen(api, conn, ids) {
      const open = new Set<string>();
      const nums = ids.filter((x) => /^\d{1,20}$/.test(x));
      for (let i = 0; i < nums.length; i += CHECK_BATCH) {
        const part = nums.slice(i, i + CHECK_BATCH);
        const wanted = new Set(part);
        const cql = `id in (${part.join(",")}) AND type = page`;
        let url: string | null = `${conn.api_base}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${CHECK_BATCH}`;
        // One page of results is normal; follow `next` a few times in case the site caps the page size lower.
        for (let n = 0; url && n < 5; n++) {
          const j = (await api(url, {}, { what: "who can open the pages" })).json as { results?: { id?: string | number; status?: string }[]; _links?: { next?: string } } | null;
          if (!j || !Array.isArray(j.results)) throw new ConnectorError("tool", "Confluence didn't say who can open the pages just now.");
          // Only ids asked for count; anything else in the reply is ignored.
          for (const p of j.results) if (p?.id !== undefined && wanted.has(String(p.id)) && (!p.status || p.status === "current")) open.add(String(p.id));
          url = j.results.length ? confluenceNext(j._links?.next, conn.api_base) : null;
        }
      }
      return open;
    },
  },

  async *changes(api, conn, project, cursor) {
    if (!/^[A-Za-z0-9~_-]{1,255}$/.test(project)) throw new ConnectorError("notfound", `“${project}” isn't a Confluence space key.`);
    const since = jqlSince(cursor);
    const cql = `space = "${project}" AND type = page${since ? ` AND lastmodified >= "${since}"` : ""} ORDER BY lastmodified ASC`;
    const expand = "body.storage,version,ancestors,metadata.labels";
    let url: string | null = `${conn.api_base}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${PAGE}&expand=${encodeURIComponent(expand)}`;
    for (let seen = 0; url && seen < MAX_PER_SYNC; ) {
      const j = (await api(url, {}, { what: `the space “${project}”` })).json as { results?: CfPage[]; _links?: { next?: string } } | null;
      const results = (j?.results ?? []).filter((p) => !p.status || p.status === "current");
      seen += j?.results?.length ?? 0;
      yield results.map((p): WorkItem => ({
        externalId: String(p.id),
        type: "Page",
        title: p.title ?? `Page ${p.id}`,
        state: null,
        // Who changed it last (shown on the page's card; pages have no assignee).
        assignee: p.version?.by?.displayName ?? null,
        dueOn: null,
        url: p._links?.webui?.startsWith("/") ? `${conn.web_base}/wiki${p._links.webui}` : `${conn.web_base}/wiki/spaces/${encodeURIComponent(project)}/pages/${encodeURIComponent(p.id)}`,
        changedAt: isoOf(p.version?.when, new Date().toISOString()),
        description: htmlToText(p.body?.storage?.value),
        blockedBy: [],
        parent: p.ancestors?.length ? p.ancestors.map((a) => a.title).filter(Boolean).join(" › ") : null,
        tags: (p.metadata?.labels?.results ?? []).map((l) => l.name ?? "").filter(Boolean),
        commentCount: 0,
        comments: [],
      }));
      if (!j?.results?.length) break;
      url = confluenceNext(j?._links?.next, conn.api_base);
    }
  },
};
