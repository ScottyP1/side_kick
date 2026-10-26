/**
 * @file The GitHub Issues connector: signs in through a **GitHub App** and reads issues and pull requests,
 * read-only. The framework (lib/connectors.ts) handles tokens, syncing, health and indexing; this file only knows
 * GitHub.
 *
 * Concepts
 * - **Sign-in**: the GitHub App's user authorization flow (OAuth authorization code with PKCE). A GitHub App has
 *   fine-grained permissions set on the app itself instead of OAuth scopes: Sidekick's needs only **Issues: read**,
 *   **Pull requests: read** and **Metadata: read**, so the token can never write. User tokens last 8 hours and
 *   come with a refresh token that **rotates** (each refresh returns a new one; the framework saves it). If the
 *   app has token expiry switched off, the token has no refresh token and simply doesn't run out.
 *   App: `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` (created by Cody: docs/RUNBOOKS.md → Connector apps).
 * - **Account**: the GitHub user who connected (their numeric id; their login is shown). **Repositories** come
 *   from the app's installations that person can see (`/user/installations` → each installation's
 *   repositories), so only repositories an owner installed the app on can be linked.
 * - **Repository** (the framework's "project"): what gets linked to a group, by its full name ("northwind/store-pos").
 * - **Items**: issues and pull requests (GitHub's issues list returns both), with state (Open, Closed, Merged),
 *   assignees, labels, the milestone (as "Part of", with its due date as the item's due date), the body and the
 *   latest comments. `externalId` is "<repo name>#<number>", e.g. "store-pos#12".
 * - **Incremental sync**: `GET /repos/{repo}/issues?state=all&sort=updated&direction=asc&since=<cursor>`, pages of
 *   100 through the `Link` header (only links back to the GitHub API are followed), at most `MAX_PER_SYNC` per
 *   run. `since` includes the cursor itself, so the last item is seen again and skipped (unchanged text).
 *   Comments cost one call per item, so at most `COMMENT_CALLS` items per sync get theirs read.
 * - **Each person signs in** (`personal`, docs/ARCHITECTURE.md → Connectors): each member authorizes the same GitHub
 *   App with their own GitHub account (a user-to-server token; it can only reach repositories the app is installed on
 *   **and** that person may open). GitHub permissions are per repository, so `canOpen` asks
 *   `GET /repos/{owner}/{repo}` once per repository among the candidates: 200 = all its issues are open to that
 *   person, 404/403 = closed (GitHub answers 404 for a private repository you can't see), anything else throws (fail
 *   closed). **Public repositories** are open to everyone: `openToAll` asks the same with the connection's own token
 *   and counts a repository GitHub reports as `visibility: "public"` (not private, not an enterprise's "internal"),
 *   so people who haven't connected GitHub, and guests in a Teams chat, still get those issues.
 * - **Rate limits**: GitHub answers 403 or 429 with `Retry-After` or `x-ratelimit-remaining: 0`; the framework's
 *   API helper (lib/connectors.ts `makeApi`) waits briefly or stops the sync with a plain "busy" message and the
 *   cursor saved, so the next run carries on.
 *
 * Tests and the demo world point `GITHUB_LOGIN_BASE`, `GITHUB_API_BASE` and `GITHUB_WEB_BASE` at a fake GitHub
 * (scripts/fake-tools.mjs); these overrides are ignored in production.
 */
import "server-only";
import { ConnectorError, dayOf, isoOf, type WorkItem } from "./connector-text";
import type { ConnectorRow, Provider, ToolApi } from "./connectors";

/** At most this many changed issues and pull requests per sync (pages of 100); the rest come on the next run. */
export const MAX_PER_SYNC = 2000;
/** At most this many items per sync get their latest comments read (one API call each). */
const COMMENT_CALLS = 300;
const PAGE = 100;
/** Not set on 8-hour tokens: a token from an app with expiry switched off never runs out (10 years here). */
const NO_EXPIRY = 10 * 365 * 86400;

const dev = (v: string | undefined, real: string) => (process.env.NODE_ENV !== "production" && v ? v.replace(/\/$/, "") : real);
const loginBase = () => dev(process.env.GITHUB_LOGIN_BASE, "https://github.com");
const apiBase = () => dev(process.env.GITHUB_API_BASE, "https://api.github.com");
const webBase = () => dev(process.env.GITHUB_WEB_BASE, "https://github.com");
const conf = () => ({ id: process.env.GITHUB_CLIENT_ID ?? "", secret: process.env.GITHUB_CLIENT_SECRET ?? "" });

type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };

/** GitHub's token endpoint. Note it answers most errors with **200** and an `error` field. */
async function token(form: Record<string, string>): Promise<TokenReply & { status: number }> {
  const c = conf();
  const res = await fetch(`${loginBase()}/login/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...form }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, ...((await res.json().catch(() => ({}))) as TokenReply) };
}

/**
 * The `rel="next"` address in a GitHub `Link` header, but only when it points back at the GitHub API (so a
 * tampered header can never send the token elsewhere); otherwise null.
 */
export function nextLink(link: string | null, base: string): string | null {
  if (!link) return null;
  const m = link.split(",").map((p) => p.match(/<([^>]+)>\s*;\s*rel="next"/)).find(Boolean);
  const url = m?.[1];
  return url && url.startsWith(`${base}/`) ? url : null;
}

/** A repository's full name as GitHub writes it ("owner/name"), or null. */
const repoName = (s: string) => (/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(s) ? s : null);

type GhUser = { login?: string };
type GhIssue = {
  number: number;
  title?: string;
  state?: string;
  html_url?: string;
  updated_at?: string;
  body?: string | null;
  comments?: number;
  assignee?: GhUser | null;
  assignees?: GhUser[];
  labels?: (string | { name?: string })[];
  milestone?: { title?: string; due_on?: string | null; state?: string } | null;
  pull_request?: { merged_at?: string | null; html_url?: string };
  draft?: boolean;
};

/** Every page of a GitHub list (`key` = the array's field, or null when the reply is the array itself). */
async function* pages<T>(api: ToolApi, first: string, key: string | null, what?: string, maxPages = 50): AsyncGenerator<T[]> {
  let url: string | null = first;
  for (let n = 0; url && n < maxPages; n++) {
    const r = await api(url, {}, { what });
    const json = r.json as Record<string, unknown> | unknown[] | null;
    yield ((key ? (json as Record<string, unknown> | null)?.[key] : json) as T[] | undefined) ?? [];
    url = nextLink(r.headers.get("link"), apiBase());
  }
}

/** GitHub's markdown body as plain-ish text: HTML comments (issue templates) dropped, whitespace tidied. */
const bodyText = (s: string | null | undefined) => (s ?? "").replace(/<!--[\s\S]*?-->/g, " ").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();

/** The candidate ids grouped by their repository ("owner/name", from `where`); ids whose repository doesn't match are left out. */
function byRepo(ids: string[], where: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of ids) {
    const repo = repoName(where.get(id) ?? "");
    // The id is "<repo name>#<number>": it must belong to that repository.
    if (!repo || !id.toLowerCase().startsWith(`${repo.split("/")[1].toLowerCase()}#`)) continue;
    const key = repo.toLowerCase();
    out.set(key, [...(out.get(key) ?? []), id]);
  }
  return out;
}

/**
 * One repository as the token sees it: its visibility, or null when GitHub says it can't be opened (404, or 403
 * without a rate limit). Anything else (busy, down, a sign-in problem) throws, so nothing is decided.
 */
async function repoFor(api: ToolApi, conn: ConnectorRow, repo: string): Promise<{ private: boolean; visibility: string | null } | null> {
  try {
    const j = (await api(`${conn.api_base}/repos/${repo}`, {}, { what: `the repository “${repo}”` })).json as { full_name?: string; private?: boolean; visibility?: string } | null;
    if (!j?.full_name || j.full_name.toLowerCase() !== repo.toLowerCase()) return null; // renamed or an answer about something else: closed
    return { private: j.private !== false, visibility: j.visibility ?? null };
  } catch (e) {
    if (e instanceof ConnectorError && (e.reason === "notfound" || e.reason === "access")) return null;
    throw e;
  }
}

export const github: Provider = {
  kind: "github",
  needsSite: false,
  configured: () => Boolean(conf().id && conf().secret),
  headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Sidekick-connector" },

  authorizeUrl({ state, challenge, redirectUri }) {
    const url = new URL(`${loginBase()}/login/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: conf().id, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256", allow_signup: "false",
    }).toString();
    return url.toString();
  },

  async exchange(code, verifier, redirectUri) {
    const r = await token({ code, redirect_uri: redirectUri, code_verifier: verifier });
    if (!r.access_token) return { error: r.error ?? `status ${r.status}` };
    return { access: r.access_token, refresh: r.refresh_token ?? null, expiresIn: r.expires_in ?? NO_EXPIRY };
  },

  async refresh(refreshToken) {
    const r = await token({ grant_type: "refresh_token", refresh_token: refreshToken });
    if (!r.access_token) return { error: r.error ?? `status ${r.status}`, revoked: r.error === "bad_refresh_token" || r.status === 400 || r.status === 401 };
    // Rotating refresh tokens: the new one replaces the old.
    return { access: r.access_token, refresh: r.refresh_token ?? refreshToken, expiresIn: r.expires_in ?? NO_EXPIRY };
  },

  async account(api) {
    const me = (await api(`${apiBase()}/user`)).json as { id?: number; login?: string } | null;
    if (!me?.id || !me.login) throw new ConnectorError("tool", "GitHub didn't say which account signed in. Try again.");
    return { account: String(me.id), accountName: me.login, apiBase: apiBase(), webBase: webBase() };
  },

  async projects(api, conn) {
    const out = new Map<string, { key: string; name: string }>();
    for await (const installs of pages<{ id: number }>(api, `${conn.api_base}/user/installations?per_page=100`, "installations", undefined, 10)) {
      for (const inst of installs) {
        for await (const repos of pages<{ full_name: string; archived?: boolean }>(api, `${conn.api_base}/user/installations/${inst.id}/repositories?per_page=100`, "repositories")) {
          for (const r of repos) if (r.full_name && !r.archived) out.set(r.full_name.toLowerCase(), { key: r.full_name, name: r.full_name });
        }
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  },

  personal: {
    /** Any GitHub account may sign in: what it can open is decided per repository by `canOpen`. */
    async account(api) {
      const me = (await api(`${apiBase()}/user`)).json as { id?: number; login?: string; name?: string | null } | null;
      if (!me?.id || !me.login) throw new ConnectorError("tool", "GitHub didn't say which account signed in. Try again.");
      return { accountName: me.login };
    },
    /** The issues of repositories the person can open (one `GET /repos/{repo}` per repository, see the file comment). */
    async canOpen(api, conn, ids, where) {
      const open = new Set<string>();
      for (const [repo, list] of byRepo(ids, where)) if (await repoFor(api, conn, repo)) for (const id of list) open.add(id);
      return open;
    },
    /** The issues of public repositories, asked with the connection's own token. */
    async openToAll(api, conn, ids, where) {
      const open = new Set<string>();
      for (const [repo, list] of byRepo(ids, where)) {
        const r = await repoFor(api, conn, repo);
        if (r && !r.private && (r.visibility ?? "public") === "public") for (const id of list) open.add(id);
      }
      return open;
    },
  },

  async *changes(api, conn, project, cursor) {
    const repo = repoName(project);
    if (!repo) throw new ConnectorError("notfound", `“${project}” isn't a GitHub repository name.`);
    const short = repo.split("/")[1];
    const since = cursor && !Number.isNaN(new Date(cursor).getTime()) ? `&since=${encodeURIComponent(new Date(cursor).toISOString())}` : "";
    const first = `${conn.api_base}/repos/${repo}/issues?state=all&sort=updated&direction=asc&per_page=${PAGE}${since}`;
    let seen = 0, commentCalls = 0;
    for await (const list of pages<GhIssue>(api, first, null, `the repository “${repo}”`, Math.ceil(MAX_PER_SYNC / PAGE))) {
      const page: WorkItem[] = [];
      for (const it of list) {
        seen++;
        const pr = Boolean(it.pull_request);
        const state = pr && it.pull_request?.merged_at ? "Merged" : it.state === "closed" ? "Closed" : pr && it.draft ? "Draft" : "Open";
        const count = Number(it.comments ?? 0);
        let comments: WorkItem["comments"] = [];
        if (count > 0 && commentCalls < COMMENT_CALLS) {
          commentCalls++;
          // Comments come oldest first: read the last page's worth and keep the newest three.
          const perPage = Math.min(100, count);
          const lastPage = Math.max(1, Math.ceil(count / perPage));
          const r = await api(`${conn.api_base}/repos/${repo}/issues/${it.number}/comments?per_page=${perPage}&page=${lastPage}`);
          comments = ((r.json as { user?: GhUser; created_at?: string; body?: string }[] | null) ?? []).slice(-3).reverse()
            .map((c) => ({ author: c.user?.login ?? "Someone", at: c.created_at ?? null, text: bodyText(c.body) }));
        }
        const assignees = (it.assignees?.length ? it.assignees : it.assignee ? [it.assignee] : []).map((a) => a.login).filter((x): x is string => !!x);
        const m = it.milestone;
        page.push({
          externalId: `${short}#${it.number}`,
          type: pr ? "Pull request" : "Issue",
          title: it.title ?? `#${it.number}`,
          state,
          assignee: assignees.length ? assignees.join(", ") : null,
          dueOn: dayOf(m?.due_on),
          url: it.html_url && /^https?:\/\//.test(it.html_url) ? it.html_url : `${conn.web_base}/${repo}/${pr ? "pull" : "issues"}/${it.number}`,
          changedAt: isoOf(it.updated_at, new Date().toISOString()),
          description: bodyText(it.body),
          blockedBy: [],
          parent: m?.title ? `Milestone ${m.title}${m.due_on ? ` (due ${m.due_on.slice(0, 10)})` : ""}` : null,
          tags: (it.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
          commentCount: count,
          comments,
        });
      }
      yield page;
      if (seen >= MAX_PER_SYNC) break;
    }
  },
};
