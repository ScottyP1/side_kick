/**
 * @file Connectors to outside tools: the framework that lets each group connect Azure DevOps Boards, Jira,
 * GitHub Issues, Confluence or Microsoft 365 files (SharePoint, OneDrive) with the account its client gave it, link
 * projects (GitHub: repositories, Confluence: spaces, Microsoft 365: libraries or folders), and keep their work
 * items, pages and files in that group's knowledge, **read-only**. The tools themselves are in lib/connector-ado.ts,
 * lib/connector-jira.ts, lib/connector-github.ts, lib/connector-confluence.ts and lib/connector-m365.ts
 * (`Provider`); the text Sidekick indexes for each item is in lib/connector-text.ts.
 *
 * Concepts
 * - **Allowed tool types** (`connector_kinds`): the Org Owner switches each tool type on or off for the
 *   organization (`setKindAllowed`; no sign-in at this level). Turning one off disconnects every group's connection of
 *   that type. Team Leads and Org Admins who need a type that's off **ask** for it (lib/connector-requests.ts);
 *   allowing a type approves every pending request for it.
 * - **Connector** (`connectors` table): one per **group** and allowed tool, connected by the group's Team Lead (or an
 *   Org Owner/Admin, for any group) with the account the client provided, through the tool's own sign-in (OAuth
 *   authorization code flow with PKCE; Microsoft Entra ID for Azure DevOps and Microsoft 365, Atlassian for Jira and
 *   Confluence, a GitHub App for GitHub; one app registration per tool serves every group). Two groups using Jira
 *   have two separate connections, usually to two different client sites. Members and Viewers never sign in to
 *   tools: everyone in the group sees what the group's connection can read. No passwords are ever stored. The access and refresh tokens are **sealed** (encrypted at rest with
 *   the `SIDEKICK_ENCRYPTION_KEY` envelope setup, lib/secret-box.ts, bound to the connector's id) and refreshed shortly before they run out.
 *   When a refresh is refused (revoked, expired after long disuse) the connector turns **expired** and the group's
 *   Team Lead or an admin must reconnect; nothing is deleted.
 * - **Link** (`connector_links`): one project (ADO), project key (Jira), repository (GitHub, "owner/name"),
 *   space key (Confluence) or SharePoint library / folder (Microsoft 365, "<drive id>[/<folder id>]") read through a
 *   group's connector into that same group. Org Owners/Admins and that group's Team Lead link and unlink (`requireManage`). Each link has an audience like documents
 *   (internal by default; shareable ones may be used when client guests are present).
 * - **Items** (`connector_items`): the work items read from a linked project (title, type, state, assignee, due
 *   date, link, what blocks it, description, comments summary). Each is indexed through lib/search.ts as source
 *   type `workitem`, so Ask cites it ("what's blocking the cutover?" → "Azure DevOps Bug #4821 …" with a link),
 *   the knowledge map (Memory & gaps) and meeting notes see the group's open items. Confluence **pages** are
 *   kept in the same table but indexed whole as source type `page`, searched and cited like documents (with a
 *   link), and never listed as open work (lib/connector-text.ts `isPageKind`). Microsoft 365 **files** are
 *   documents too (source type `page`, read through lib/extract.ts like uploads, `fileText`).
 * - **Incremental sync** (`syncLink`): only what changed since the link's cursor (the latest change time seen),
 *   in pages; the cursor is saved after every page, so a failure resumes where it stopped. Unchanged items
 *   (same text) aren't re-indexed. A tool may hand back its own cursor and the items that went away
 *   (`ChangePage`: Microsoft Graph's delta links and deleted files). Runs on link, on "Sync now", and every `SYNC_EVERY_MINUTES` on the job queue
 *   (lib/job-kinds.ts: the recurring `connectors.schedule` job queues one `connector.sync` job per due link,
 *   `dueConnectorLinks` / `syncDueLink`). Every sync is a trace step (kind "connector") with counts only.
 * - **Health**: on the Connectors page (`connectorHealth`: last sync, last success, the last error in plain words,
 *   an expired sign-in; a link with no success for `STALE_HOURS` shows a problem), and for the "broken connector"
 *   watcher through lib/connector-health.ts: every sync reports its group's result (`reportConnectorHealth`, id
 *   "azure-devops", "jira", "github", "confluence" or "microsoft-365-files"), an expired sign-in is reported for its group, and reconnecting, unlinking or
 *   disconnecting clears it. `connectorProblems` lists everything broken across organizations (operators).
 * - **Rate limits**: a tool that says "slow down" (429, GitHub's 403 with `Retry-After` / `x-ratelimit-remaining:
 *   0`, or a 503 with `Retry-After` as Microsoft Graph sends) is waited for when the wait is short (`RATE_WAIT_MAX_SECONDS`, once per call); otherwise the sync stops
 *   with a plain "busy" problem saying when it may continue, the cursor already saved, and the next run resumes.
 * - **Plan limits**: the plan's `connectors` limit (lib/plans.ts: none, one tool type, or all) counts the allowed
 *   tool types and is checked before a *new* type is allowed (`assertCanAdd(org, "connectors")`); how many groups
 *   connect it doesn't matter, and a smaller plan keeps what's allowed.
 * - **Disconnect** removes the tokens, every link and every imported item with its search entries (local and
 *   Azure). Unlinking a project removes that project's items. Deleting a group or organization does too.
 *
 * Walls: every query is scoped to the organization, and every connector-level call checks the person may manage the
 * connector's own group (`requireManage`), so one group's sign-in can never list, link, sync or feed another
 * group. Tokens never leave the server (never in a response, log or trace).
 */
import "server-only";
import crypto from "node:crypto";
import { all, get, newId, now, run, tx } from "./db";
import { audit, auditAsSidekick, HttpError, isAdmin, requireManage, workspaceIdsFor, type User } from "./auth";
import { openSecret, sealSecret } from "./secret-box";
import { indexText, removeIndexedMany } from "./search";
import { span, spanAttrs } from "./trace";
import { removeConnectorHealth, reportConnectorHealth } from "./connector-health";
import { BRAND } from "./brand";
import { ado, MAX_PER_SYNC as ADO_MAX } from "./connector-ado";
import { jira } from "./connector-jira";
import { github } from "./connector-github";
import { confluence } from "./connector-confluence";
import { m365 } from "./connector-m365";
import { allowKind, requestsFor } from "./connector-requests";
import { adoOrgName, ConnectorError, CONNECTOR_KINDS, fileText, isDoneState, isPageKind, KIND_LABEL, pageText, PROJECT_WORD, rateLimitWait, workItemText, workItemTitle, type ConnectorKind, type WorkItem } from "./connector-text";

export { CONNECTOR_KINDS, KIND_LABEL, type ConnectorKind } from "./connector-text";

/** How often the scheduler syncs each linked project. */
export const SYNC_EVERY_MINUTES = 15;
/** A link with no successful sync for this long counts as broken (health, watcher). */
export const STALE_HOURS = 6;
/** A sync claimed longer ago than this is assumed to have died and may be claimed again. */
const SYNC_CLAIM_MINUTES = 15;
const STATE_MINUTES = 10;
/** A "slow down" from a tool asking for at most this long is waited out inside the call; longer ends the sync. */
export const RATE_WAIT_MAX_SECONDS = 5;
/** Browser cookie tying a connector sign-in to the browser that started it (like Microsoft sign-in's). */
export const CONNECTOR_COOKIE = "sk_connector";

/** A `connectors` row. Tokens are sealed; use `toolApi` to call the tool. */
export type ConnectorRow = {
  id: string; org_id: string; workspace_id: string; kind: ConnectorKind; status: "connected" | "expired"; account: string; account_name: string | null;
  api_base: string; web_base: string; access_token: string | null; refresh_token: string | null; token_expires_at: string | null;
  connected_by: string | null; connected_at: string; last_error: string | null; last_error_at: string | null; updated_at: string;
};
/** A `connector_links` row. */
export type LinkRow = {
  id: string; org_id: string; connector_id: string; workspace_id: string; project: string; project_name: string; audience: "internal" | "shareable";
  sync_cursor: string | null; item_count: number; last_sync_at: string | null; last_ok_at: string | null; last_error: string | null;
  sync_started_at: string | null; created_by: string | null; created_at: string;
};

/** Tokens from a sign-in or refresh. `expiresIn` is in seconds. */
export type Tokens = { access: string; refresh: string | null; expiresIn: number };

/**
 * Calls the tool's API with the connector's token: JSON in and out, the token refreshed and the call retried
 * once on 401, and every failure turned into a `ConnectorError` with a plain message. `what` names the thing
 * being read ("the project “Wave 2”") for those messages. With `binary` the answer is a file (`body`, at most
 * `maxBytes`, else a `ConnectorError` with status 413); a redirect to a download address (Microsoft Graph's
 * `/content`) is followed **without** the token (`downloadFrom`).
 */
export type ToolApi = (url: string, init?: { method?: string; body?: unknown }, opts?: { what?: string; binary?: boolean; maxBytes?: number }) => Promise<{ json: unknown; headers: Headers; body?: Buffer }>;

/**
 * One page of changes from a tool. A plain array is just the items (the cursor becomes the latest `changedAt`).
 * Otherwise `cursor` is the tool's own resume point (saved as it is; Microsoft Graph's next or delta link) and
 * `removed` the external ids of items that went away (deleted, moved out, no longer readable): their copies and
 * search entries are deleted.
 */
export type ChangePage = { items: WorkItem[]; removed?: string[]; cursor?: string };

/** What each tool (lib/connector-ado.ts, -jira.ts, -github.ts, -confluence.ts, -m365.ts) provides to the framework. */
export type Provider = {
  kind: ConnectorKind;
  /** True when connecting needs a site typed first (ADO: the organization name). */
  needsSite: boolean;
  /** True when the tool's app id and secret are set on this server. */
  configured(): boolean;
  /** Extra headers on every API call (GitHub: its media type, API version and a User-Agent). */
  headers?: Record<string, string>;
  authorizeUrl(o: { state: string; challenge: string; redirectUri: string }): string;
  exchange(code: string, verifier: string, redirectUri: string): Promise<Tokens | { error: string }>;
  refresh(refreshToken: string): Promise<Tokens | { error: string; revoked: boolean }>;
  /** Which account/site the signed-in person's token opens (checks access). */
  account(api: ToolApi, site: string | null): Promise<{ account: string; accountName: string; apiBase: string; webBase: string }>;
  projects(api: ToolApi, conn: ConnectorRow): Promise<{ key: string; name: string }[]>;
  /** The items changed since `cursor` (null = everything), oldest first, one page at a time (see `ChangePage`). */
  changes(api: ToolApi, conn: ConnectorRow, project: string, cursor: string | null): AsyncGenerator<WorkItem[] | ChangePage>;
};

const PROVIDERS: Record<ConnectorKind, Provider> = { ado, jira, github, confluence, m365 };

/** Checks a tool name from a request ("ado", "jira", "github", "confluence" or "m365"), or 400. */
export function kindOf(value: unknown): ConnectorKind {
  if (typeof value === "string" && (CONNECTOR_KINDS as readonly string[]).includes(value)) return value as ConnectorKind;
  throw new HttpError(400, `Pick a tool: ${CONNECTOR_KINDS.join(", ")}.`);
}

/** Whether each tool's app is set up on this server (the Connectors page says "not set up yet" otherwise). */
export const configuredKinds = (): Record<ConnectorKind, boolean> =>
  Object.fromEntries(CONNECTOR_KINDS.map((k) => [k, PROVIDERS[k].configured()])) as Record<ConnectorKind, boolean>;

/** The ids and names the broken-connector watcher knows each tool by (lib/connector-health.ts). */
const HEALTH: Record<ConnectorKind, { id: string; label: string }> = {
  ado: { id: "azure-devops", label: "Azure DevOps Boards" }, jira: { id: "jira", label: "Jira" },
  github: { id: "github", label: "GitHub Issues" }, confluence: { id: "confluence", label: "Confluence" },
  m365: { id: "microsoft-365-files", label: "Microsoft 365 files (SharePoint, OneDrive)" },
};

const expiredMessage = (kind: ConnectorKind) =>
  `The ${KIND_LABEL[kind]} sign-in has expired or was revoked. The group's Team Lead (or an admin) needs to reconnect it on Connectors.`;

/** Why a tool type that's off can't be connected. */
const notAllowedMessage = (kind: ConnectorKind) => `${KIND_LABEL[kind]} isn't allowed in your organization yet. Ask the Org Owner for it on Connectors.`;

/** The tool types the organization allows (lib/connector-requests.ts `allowKind`, `setKindAllowed`). */
export async function allowedKinds(orgId: string): Promise<ConnectorKind[]> {
  return (await all<{ kind: ConnectorKind }>("SELECT kind FROM connector_kinds WHERE org_id = ? ORDER BY kind", orgId)).map((r) => r.kind).filter((k) => (CONNECTOR_KINDS as readonly string[]).includes(k));
}
const isAllowed = async (orgId: string, kind: ConnectorKind) => Boolean(await get("SELECT kind FROM connector_kinds WHERE org_id = ? AND kind = ?", orgId, kind));

/** Seal-context per column and connector, so a sealed token copied onto another row won't open. */
const ctx = (id: string, col: "access_token" | "refresh_token") => `connectors.${col}:${id}`;

/**
 * The address the tools send the browser back to. Production: from SIDEKICK_PUBLIC_URL; laptop: the address
 * the browser used. It must be registered on each tool's app (docs/RUNBOOKS.md → Connector apps).
 */
export function connectorRedirectUri(req: Request): string {
  const base = process.env.NODE_ENV === "production" && process.env.SIDEKICK_PUBLIC_URL ? process.env.SIDEKICK_PUBLIC_URL : new URL(req.url).origin;
  return `${base.replace(/\/$/, "")}/api/connectors/callback`;
}

/* ---------------------------------------------------------------- */
/* Calling a tool: tokens, refresh, errors                           */
/* ---------------------------------------------------------------- */

const tooBig = (label: string) => new ConnectorError("tool", `The file is larger than ${BRAND.name} reads from ${label}.`, 413);

/** Reads a response body as bytes, stopping (413) once it passes `max`. */
async function readCapped(res: Response, max: number, label: string): Promise<Buffer> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig(label);
  }
  const parts: Buffer[] = [];
  let n = 0;
  const reader = res.body?.getReader();
  for (;;) {
    const { done, value } = reader ? await reader.read() : { done: true, value: undefined };
    if (done || !value) break;
    n += value.length;
    if (n > max) {
      await reader!.cancel().catch(() => undefined);
      throw tooBig(label);
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

/**
 * Fetches a file from the short-lived download address a tool redirected to (Microsoft Graph's pre-authenticated
 * SharePoint address). Never sends the token there; only https (plain http on this machine outside production,
 * for the fake tools).
 */
async function downloadFrom(location: string, max: number, label: string): Promise<Buffer> {
  let u: URL;
  try {
    u = new URL(location);
  } catch {
    throw new ConnectorError("tool", `${label} sent a download address ${BRAND.name} can't use.`);
  }
  const local = process.env.NODE_ENV !== "production" && u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname);
  if (u.protocol !== "https:" && !local) throw new ConnectorError("tool", `${label} sent a download address ${BRAND.name} can't use.`);
  let res: Response;
  try {
    res = await fetch(u, { signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new ConnectorError("network", `${BRAND.name} couldn't download a file from ${label}. It will try again on the next sync.`);
  }
  if (res.status === 404) throw new ConnectorError("notfound", `${label} couldn't find the file. It may have been deleted.`, 404);
  if (!res.ok) throw new ConnectorError(res.status === 429 || res.status >= 500 ? "busy" : "tool", `${label} didn't hand over a file (${res.status}). ${BRAND.name} will try again on the next sync.`, res.status);
  return readCapped(res, max, label);
}

function makeApi(kind: ConnectorKind, token: (force: boolean) => Promise<string>): ToolApi {
  const label = KIND_LABEL[kind];
  const extra = PROVIDERS[kind].headers ?? {};
  return async (url, init = {}, opts = {}) => {
    let waited = false, refreshed = false, force = false;
    for (;;) {
      const tok = await token(force);
      force = false;
      let res: Response;
      try {
        res = await fetch(url, {
          method: init.method ?? "GET",
          headers: { Accept: "application/json", ...extra, Authorization: `Bearer ${tok}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(30_000),
          redirect: "manual",
        });
      } catch {
        throw new ConnectorError("network", `${BRAND.name} couldn't reach ${label}. It will try again on the next sync.`);
      }
      // A file download: Graph answers 302 to a pre-authenticated address (fetched without the token).
      const location = res.headers.get("location");
      if (opts.binary && res.status >= 300 && res.status < 400 && location) {
        return { json: null, headers: res.headers, body: await downloadFrom(new URL(location, url).toString(), opts.maxBytes ?? Infinity, label) };
      }
      // ADO answers an unusable token with 203 and a sign-in page (or a redirect) instead of 401.
      const unauthorized = res.status === 401 || res.status === 203 || (res.status >= 300 && res.status < 400);
      if (unauthorized && !refreshed) {
        refreshed = force = true; // the token may have just run out: refresh once and retry
        continue;
      }
      const wait = rateLimitWait(res.status, res.headers);
      if (wait !== null) {
        if (!waited && wait <= RATE_WAIT_MAX_SECONDS) {
          waited = true;
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        const when = new Date(Date.now() + wait * 1000).toISOString().slice(11, 16);
        throw new ConnectorError("busy", `${label} asked ${BRAND.name} to slow down (rate limit). It will carry on from where it stopped after ${when} UTC.`);
      }
      if (res.ok && !unauthorized) {
        if (opts.binary) return { json: null, headers: res.headers, body: await readCapped(res, opts.maxBytes ?? Infinity, label) };
        return { json: await res.json().catch(() => null), headers: res.headers };
      }
      if (unauthorized) throw new ConnectorError("auth", expiredMessage(kind), res.status);
      if (res.status === 403) throw new ConnectorError("access", `${label} refused access${opts.what ? ` to ${opts.what}` : ""}: the account that connected it may have lost access. Reconnect with an account that can open it, or unlink it.`, 403);
      if (res.status === 404) throw new ConnectorError("notfound", `${label} couldn't find ${opts.what ?? "what was asked for"}. It may have been renamed or deleted.`, 404);
      if (res.status === 429 || res.status >= 500) throw new ConnectorError("busy", `${label} is busy or unavailable right now (${res.status}). ${BRAND.name} will try again on the next sync.`, res.status);
      throw new ConnectorError("tool", `${label} answered ${res.status}.`, res.status);
    }
  };
}

const refreshing = new Map<string, Promise<string>>();

/** Marks a connector expired (once), with the plain reason, and tells the audit log. */
async function markExpired(c: Pick<ConnectorRow, "id" | "org_id" | "kind" | "workspace_id">) {
  const msg = expiredMessage(c.kind);
  const r = await run("UPDATE connectors SET status = 'expired', last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status <> 'expired'", msg, now(), now(), c.id, c.org_id);
  if (r.changes) await auditAsSidekick(c.org_id, `The ${KIND_LABEL[c.kind]} sign-in expired or was revoked; syncing paused until someone reconnects it`, "Connectors", c.workspace_id);
  // For the group's watcher finding: its Team Lead (and the admins) are the ones who can reconnect.
  await reportConnectorHealth({ orgId: c.org_id, workspaceId: c.workspace_id, connector: HEALTH[c.kind].id, label: HEALTH[c.kind].label, ok: false, message: msg, fixHref: "/connectors" });
}

/**
 * A valid access token for the connector: the stored one while it has over a minute left (and `force` is off),
 * otherwise a refreshed one (saved sealed, with Atlassian's rotated refresh token). One refresh at a time per
 * connector in this process. A refused refresh marks the connector expired.
 */
async function connectorToken(c: Pick<ConnectorRow, "id" | "org_id" | "kind" | "workspace_id">, force: boolean): Promise<string> {
  const cur = await get<ConnectorRow>("SELECT * FROM connectors WHERE id = ? AND org_id = ?", c.id, c.org_id);
  if (!cur || cur.status === "expired") throw new ConnectorError("auth", expiredMessage(c.kind));
  const soon = new Date(Date.now() + 60_000).toISOString();
  if (!force && cur.access_token && cur.token_expires_at && cur.token_expires_at > soon) return openSecret(cur.access_token, ctx(cur.id, "access_token"));
  const pending = refreshing.get(cur.id);
  if (pending) return pending;
  const p = (async () => {
    if (!cur.refresh_token) {
      await markExpired(cur);
      throw new ConnectorError("auth", expiredMessage(cur.kind));
    }
    const r = await span("connector", `Refresh the ${KIND_LABEL[cur.kind]} sign-in`, () => PROVIDERS[cur.kind].refresh(openSecret(cur.refresh_token!, ctx(cur.id, "refresh_token"))))
      .catch((e) => {
        if (e instanceof ConnectorError) throw e;
        throw new ConnectorError("network", `${BRAND.name} couldn't reach ${KIND_LABEL[cur.kind]} to renew its sign-in. It will try again on the next sync.`);
      });
    if ("error" in r) {
      if (r.revoked) {
        await markExpired(cur);
        throw new ConnectorError("auth", expiredMessage(cur.kind));
      }
      throw new ConnectorError("busy", `${KIND_LABEL[cur.kind]} didn't renew the sign-in right now. ${BRAND.name} will try again on the next sync.`);
    }
    await run(
      "UPDATE connectors SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ? WHERE id = ? AND org_id = ?",
      sealSecret(r.access, ctx(cur.id, "access_token")), r.refresh ? sealSecret(r.refresh, ctx(cur.id, "refresh_token")) : cur.refresh_token,
      new Date(Date.now() + r.expiresIn * 1000).toISOString(), now(), cur.id, cur.org_id,
    );
    return r.access;
  })().finally(() => refreshing.delete(cur.id));
  refreshing.set(cur.id, p);
  return p;
}

/** The tool API for a stored connector (see `ToolApi`). */
const toolApi = (c: ConnectorRow): ToolApi => makeApi(c.kind, (force) => connectorToken(c, force));

/** A `ConnectorError` for a person's request: 409 (reconnect / access / gone), 502 for the tool being down. */
function asHttp(e: unknown): never {
  if (e instanceof ConnectorError) {
    throw new HttpError(e.reason === "busy" || e.reason === "network" || e.reason === "tool" ? 502 : 409, e.message);
  }
  throw e;
}

/* ---------------------------------------------------------------- */
/* Connecting: the OAuth round trip                                  */
/* ---------------------------------------------------------------- */

const b64url = (b: Buffer) => b.toString("base64url");

/**
 * Starts connecting an allowed tool **for one group** (`ws`): its Team Lead, or an Org Owner/Admin for any group
 * (`requireManage`). Refuses when the tool type isn't allowed in the organization (403: ask the Org Owner), when
 * the tool's app isn't set up here (503), and for ADO without a valid organization name. Reconnecting the group's
 * existing connection is the same call. Saves a one-time state with a PKCE verifier and the group, and returns the
 * tool's sign-in address plus the state for the browser cookie.
 */
export async function startConnect(req: Request, user: User, kindRaw: unknown, siteRaw: unknown, wsRaw: unknown): Promise<{ url: string; state: string }> {
  const ws = await requireManage(user, typeof wsRaw === "string" ? wsRaw : null);
  const kind = kindOf(kindRaw);
  const p = PROVIDERS[kind];
  if (!(await isAllowed(user.org_id, kind))) throw new HttpError(403, notAllowedMessage(kind));
  if (!p.configured()) throw new HttpError(503, `Connecting ${KIND_LABEL[kind]} isn't set up on this ${BRAND.name} yet. The ${BRAND.name} team adds it (docs/RUNBOOKS.md).`);
  // GitHub has no site to pick: the repositories come from the GitHub App's installations. Microsoft 365: nothing to
  // type either; the client's own Microsoft organization is whichever one the account signs in to.
  let site: string | null = kind !== "github" && kind !== "m365" && typeof siteRaw === "string" && siteRaw.trim() ? siteRaw.trim().slice(0, 200) : null;
  if (kind === "ado") {
    site = adoOrgName(siteRaw);
    if (!site) throw new HttpError(400, "Type your Azure DevOps organization: the name after dev.azure.com/ (for example “northwind”).");
  }
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  await run("DELETE FROM connector_states WHERE expires_at < ?", now());
  await run(
    "INSERT INTO connector_states (state, org_id, user_id, kind, verifier, site, expires_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    state, user.org_id, user.id, kind, verifier, site, new Date(Date.now() + STATE_MINUTES * 60_000).toISOString(), ws,
  );
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { url: p.authorizeUrl({ state, challenge, redirectUri: connectorRedirectUri(req) }), state };
}

/**
 * Finishes connecting: checks the state against the browser cookie (used once, 10 minutes), swaps the code for
 * tokens, checks which account/site they open, and saves the **group's** connector with the tokens sealed.
 * Reconnecting the same account replaces the tokens and resumes syncing; a different account is refused (disconnect
 * first, so the old account's items don't mix with the new). Only the person who started may finish, only while
 * they may still manage that group and the tool type is still allowed. Audited in the group.
 * @returns the tool that was connected and the group
 */
export async function finishConnect(req: Request, cookieState: string | undefined): Promise<{ kind: ConnectorKind; ws: string }> {
  const q = new URL(req.url).searchParams;
  const state = q.get("state") ?? "";
  const saved = state ? await get<{ state: string; org_id: string; user_id: string; kind: ConnectorKind; verifier: string; site: string | null; expires_at: string; workspace_id: string | null }>("SELECT * FROM connector_states WHERE state = ?", state) : undefined;
  if (saved) await run("DELETE FROM connector_states WHERE state = ?", state);
  if (q.get("error")) {
    // Only the tool's error code is shown (never its free text: anyone can make a link to this address).
    const code = (q.get("error") ?? "").replace(/[^a-z_]/gi, "").slice(0, 40);
    throw new HttpError(400, code === "access_denied" ? "Connecting was cancelled." : `The tool didn't connect${code ? ` (${code})` : ""}. Try again; if it keeps happening, your IT team may need to approve ${BRAND.name}.`);
  }
  const code = q.get("code") ?? "";
  if (!saved || !code || !cookieState || cookieState !== state) throw new HttpError(400, "That link expired or was opened in a different browser. Start connecting again from Connectors.");
  if (saved.expires_at < now()) throw new HttpError(400, "Connecting took too long. Try again.");
  const user = await get<User>("SELECT * FROM users WHERE id = ? AND org_id = ?", saved.user_id, saved.org_id);
  if (!user) throw new HttpError(403, "Only the group's Team Lead or an admin can connect tools.");
  const ws = await requireManage(user, saved.workspace_id);
  const kind = saved.kind;
  if (!(await isAllowed(saved.org_id, kind))) throw new HttpError(403, notAllowedMessage(kind));
  const p = PROVIDERS[kind];
  return span("connector", `Connect ${KIND_LABEL[kind]}`, async () => {
    const tokens = await p.exchange(code, saved.verifier, connectorRedirectUri(req)).catch(() => ({ error: "unreachable" }));
    if ("error" in tokens) {
      console.error(`Connector sign-in: ${kind} token exchange failed`, tokens.error);
      throw new HttpError(502, `${KIND_LABEL[kind]} didn't confirm the sign-in. Try again; if it keeps happening, the app's secret may have expired.`);
    }
    const api = makeApi(kind, async () => tokens.access);
    const acct = await p.account(api, saved.site).catch(asHttp);
    const existing = await get<ConnectorRow>("SELECT * FROM connectors WHERE org_id = ? AND workspace_id = ? AND kind = ?", saved.org_id, ws, kind);
    if (existing && existing.account !== acct.account) {
      throw new HttpError(409, `${KIND_LABEL[kind]} is already connected to ${existing.account_name ?? existing.account} for this group. Disconnect it first to switch to ${acct.accountName}.`);
    }
    const id = existing?.id ?? newId();
    const sealedAccess = sealSecret(tokens.access, ctx(id, "access_token"));
    const sealedRefresh = tokens.refresh ? sealSecret(tokens.refresh, ctx(id, "refresh_token")) : null;
    const expires = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
    if (existing) {
      await run(
        "UPDATE connectors SET status = 'connected', access_token = ?, refresh_token = ?, token_expires_at = ?, connected_by = ?, connected_at = ?, last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ? AND org_id = ?",
        sealedAccess, sealedRefresh, expires, user.name, now(), now(), id, saved.org_id,
      );
      // Links that failed only because the sign-in ran out sync again on the next run.
      await run("UPDATE connector_links SET last_sync_at = NULL WHERE connector_id = ? AND org_id = ?", id, saved.org_id);
    } else {
      await run(
        `INSERT INTO connectors (id, org_id, workspace_id, kind, status, account, account_name, api_base, web_base, access_token, refresh_token, token_expires_at, connected_by, connected_at, updated_at)
         VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, saved.org_id, ws, kind, acct.account, acct.accountName, acct.apiBase, acct.webBase, sealedAccess, sealedRefresh, expires, user.name, now(), now(),
      );
    }
    spanAttrs({ kind, reconnect: Boolean(existing) });
    await reportConnectorHealth({ orgId: saved.org_id, workspaceId: ws, connector: HEALTH[kind].id, label: HEALTH[kind].label, ok: true, fixHref: "/connectors" });
    await audit(user, `${existing ? "Reconnected" : "Connected"} ${KIND_LABEL[kind]} (${acct.accountName}) for this group, read-only`, "Connectors", ws);
    return { kind, ws };
  });
}

/**
 * A connector the person may manage: in their organization, and its group one they manage (`requireManage`:
 * 403 for Members and Viewers, 404 for another organization's id or a group they aren't in).
 */
async function ownConnector(user: User, id: unknown): Promise<ConnectorRow> {
  if (!isAdmin(user) && user.role !== "Team Lead") throw new HttpError(403, "Only the group's Team Lead or an admin can do this.");
  const c = typeof id === "string" ? await get<ConnectorRow>("SELECT * FROM connectors WHERE id = ? AND org_id = ?", id, user.org_id) : undefined;
  if (!c) throw new HttpError(404, "Connector not found.");
  await requireManage(user, c.workspace_id).catch(() => { throw new HttpError(404, "Connector not found."); });
  return c;
}

/**
 * Disconnects one group's connection (its Team Lead, or an Org Owner/Admin): removes its tokens, every linked
 * project and every imported item with its search entries (local and Azure). Audited in the group with the counts.
 */
export async function disconnect(user: User, id: unknown): Promise<{ links: number; items: number }> {
  return removeConnector(user, await ownConnector(user, id));
}

/** Removes a connector with its links, items, search entries and health (see `disconnect`). Audited. */
async function removeConnector(user: User, c: ConnectorRow): Promise<{ links: number; items: number }> {
  return span("connector", `Disconnect ${KIND_LABEL[c.kind]}`, async () => {
    const items = await all<{ id: string }>("SELECT id FROM connector_items WHERE org_id = ? AND link_id IN (SELECT id FROM connector_links WHERE connector_id = ? AND org_id = ?)", user.org_id, c.id, user.org_id);
    const links = await all<{ id: string }>("SELECT id FROM connector_links WHERE connector_id = ? AND org_id = ?", c.id, user.org_id);
    await removeIndexedMany(user.org_id, items.map((i) => i.id));
    await tx(async () => {
      await run("DELETE FROM connector_items WHERE org_id = ? AND link_id IN (SELECT id FROM connector_links WHERE connector_id = ? AND org_id = ?)", user.org_id, c.id, user.org_id);
      await run("DELETE FROM connector_links WHERE connector_id = ? AND org_id = ?", c.id, user.org_id);
      await run("DELETE FROM connectors WHERE id = ? AND org_id = ?", c.id, user.org_id);
      // Disconnected on purpose: nothing for the broken-connector watcher to report any more.
      await run("DELETE FROM connector_health WHERE org_id = ? AND workspace_id = ? AND connector = ?", user.org_id, c.workspace_id, HEALTH[c.kind].id);
    });
    spanAttrs({ kind: c.kind, links: links.length, items: items.length });
    await audit(user, `Disconnected ${KIND_LABEL[c.kind]} (${c.account_name ?? c.account}) from this group: removed its sign-in, ${links.length} linked project${links.length === 1 ? "" : "s"} and ${items.length} imported item${items.length === 1 ? "" : "s"}`, "Connectors", c.workspace_id);
    return { links: links.length, items: items.length };
  });
}

/**
 * The Org Owner switches a tool type on or off for the organization (no sign-in at this level). On: within the
 * plan's connectors limit (402 with the upgrade message), approving every pending request for it
 * (lib/connector-requests.ts `allowKind`). Off: disconnects **every group's** connection of that type (tokens,
 * links, imported items, search entries) and returns the groups affected. Audited, traced.
 */
export async function setKindAllowed(user: User, kindRaw: unknown, allowed: unknown): Promise<{ allowed: ConnectorKind[]; removed: { groups: string[]; links: number; items: number } }> {
  if (user.role !== "Org Owner") throw new HttpError(403, "Only the Org Owner chooses which tools the organization allows.");
  const kind = kindOf(kindRaw);
  if (typeof allowed !== "boolean") throw new HttpError(400, "Say whether to allow it (true) or not (false).");
  const removed = { groups: [] as string[], links: 0, items: 0 };
  if (allowed) await allowKind(user, kind);
  else {
    await span("connector", `Stop allowing ${KIND_LABEL[kind]}`, async () => {
      const conns = await all<ConnectorRow & { workspace_name: string }>(
        "SELECT c.*, w.name AS workspace_name FROM connectors c JOIN workspaces w ON w.id = c.workspace_id AND w.org_id = c.org_id WHERE c.org_id = ? AND c.kind = ? ORDER BY w.name", user.org_id, kind,
      );
      for (const c of conns) {
        const r = await removeConnector(user, c);
        removed.groups.push(c.workspace_name);
        removed.links += r.links;
        removed.items += r.items;
      }
      // A connection whose group is gone can't remain either.
      await run("DELETE FROM connectors WHERE org_id = ? AND kind = ?", user.org_id, kind);
      const r = await run("DELETE FROM connector_kinds WHERE org_id = ? AND kind = ?", user.org_id, kind);
      spanAttrs({ kind, groups: conns.length, links: removed.links, items: removed.items });
      if (r.changes) await audit(user, `Stopped allowing ${KIND_LABEL[kind]} in the organization${conns.length ? `: disconnected it from ${conns.length} group${conns.length === 1 ? "" : "s"} (${removed.items} imported item${removed.items === 1 ? "" : "s"} removed)` : ""}`, "Connectors");
    });
  }
  return { allowed: await allowedKinds(user.org_id), removed };
}

/* ---------------------------------------------------------------- */
/* Linking projects to groups                                        */
/* ---------------------------------------------------------------- */

/**
 * The projects a group's connected account can read in a tool (that group's Team Lead, or an Org Owner/Admin: the
 * people who may link them). A tool problem becomes a plain 409/502.
 */
export async function listProjects(user: User, connectorId: unknown): Promise<{ key: string; name: string }[]> {
  const c = await ownConnector(user, connectorId);
  return span("connector", `List ${KIND_LABEL[c.kind]} projects`, async () => {
    const list = await PROVIDERS[c.kind].projects(toolApi(c), c).catch(asHttp);
    spanAttrs({ kind: c.kind, projects: list.length });
    return list;
  });
}

/**
 * Links a project to the group of the connector it's read through (Org Owner/Admin, or that group's Team Lead:
 * `requireManage`), then runs its first sync straight away. `ws`, when given, must be the connector's own group: a
 * group's sign-in never feeds another group (404). The project must be one the connected account can read (checked
 * against the tool's own list, so a typo or a made-up key is refused). Audited. A failing first sync doesn't undo
 * the link: its health shows why.
 */
export async function linkProject(user: User, body: { connector?: unknown; ws?: unknown; project?: unknown; audience?: unknown }) {
  if (body.ws !== undefined) await requireManage(user, typeof body.ws === "string" ? body.ws : null);
  const c = await ownConnector(user, body.connector);
  if (body.ws !== undefined && body.ws !== c.workspace_id) throw new HttpError(404, "Connector not found.");
  const ws = c.workspace_id;
  if (c.status === "expired") throw new HttpError(409, expiredMessage(c.kind));
  if (typeof body.project !== "string" || !body.project.trim()) throw new HttpError(400, `Pick a ${PROJECT_WORD[c.kind]} to link.`);
  const audience = body.audience === "shareable" ? "shareable" : "internal";
  const projects = await PROVIDERS[c.kind].projects(toolApi(c), c).catch(asHttp);
  const p = projects.find((x) => x.key === body.project || x.key.toLowerCase() === String(body.project).trim().toLowerCase());
  if (!p) throw new HttpError(404, `${KIND_LABEL[c.kind]} has no ${PROJECT_WORD[c.kind]} “${String(body.project).slice(0, 80)}” that the connected account can read.`);
  if (await get("SELECT id FROM connector_links WHERE connector_id = ? AND workspace_id = ? AND project = ? AND org_id = ?", c.id, ws, p.key, user.org_id)) {
    throw new HttpError(409, `${p.name} is already linked to this group.`);
  }
  const id = newId();
  await run(
    "INSERT INTO connector_links (id, org_id, connector_id, workspace_id, project, project_name, audience, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, user.org_id, c.id, ws, p.key, p.name, audience, user.name, now(),
  );
  await audit(user, `Linked ${KIND_LABEL[c.kind]} ${PROJECT_WORD[c.kind]} ${p.name} to this group (${audience}, read-only)`, "Connectors", ws);
  await claimAndSync(user.org_id, id).catch(() => undefined); // the link's health records any problem
  return linkHealth(user.org_id, id);
}

/** The organization's link, or 404. With `manage`, also checks the person may manage its group. */
async function ownLink(user: User, id: unknown): Promise<LinkRow & { kind: ConnectorKind }> {
  const l = typeof id === "string"
    ? await get<LinkRow & { kind: ConnectorKind }>("SELECT l.*, c.kind FROM connector_links l JOIN connectors c ON c.id = l.connector_id AND c.org_id = l.org_id WHERE l.id = ? AND l.org_id = ?", id, user.org_id)
    : undefined;
  if (!l) throw new HttpError(404, "Linked project not found.");
  await requireManage(user, l.workspace_id);
  return l;
}

/** Unlinks a project from its group (same people as linking): its items and their search entries go. Audited. */
export async function unlinkProject(user: User, id: unknown): Promise<{ items: number }> {
  const l = await ownLink(user, id);
  const items = await all<{ id: string }>("SELECT id FROM connector_items WHERE link_id = ? AND org_id = ?", l.id, user.org_id);
  await removeIndexedMany(user.org_id, items.map((i) => i.id));
  await tx(async () => {
    await run("DELETE FROM connector_items WHERE link_id = ? AND org_id = ?", l.id, user.org_id);
    await run("DELETE FROM connector_links WHERE id = ? AND org_id = ?", l.id, user.org_id);
  });
  // The group's health entry goes with its last project of this tool.
  if (!(await get("SELECT id FROM connector_links WHERE connector_id = ? AND workspace_id = ? AND org_id = ?", l.connector_id, l.workspace_id, user.org_id))) {
    await removeConnectorHealth(user.org_id, HEALTH[l.kind].id, l.workspace_id);
  }
  await audit(user, `Unlinked ${KIND_LABEL[l.kind]} ${PROJECT_WORD[l.kind]} ${l.project_name} from this group: removed ${items.length} imported item${items.length === 1 ? "" : "s"}`, "Connectors", l.workspace_id);
  return { items: items.length };
}

/** "Sync now" on a link (same people as linking). 409 while a sync of it is already running. Returns its health. */
export async function syncNow(user: User, id: unknown) {
  const l = await ownLink(user, id);
  const ran = await claimAndSync(user.org_id, l.id).catch(() => true);
  if (!ran) throw new HttpError(409, "A sync of this project is already running. Try again in a minute.");
  return linkHealth(user.org_id, l.id);
}

/* ---------------------------------------------------------------- */
/* Syncing                                                           */
/* ---------------------------------------------------------------- */

/** Claims the link (so two copies of the app never sync it at once), syncs it, and lets go. False if it was taken. */
async function claimAndSync(orgId: string, linkId: string): Promise<boolean> {
  const stale = new Date(Date.now() - SYNC_CLAIM_MINUTES * 60_000).toISOString();
  const claimed = await run("UPDATE connector_links SET sync_started_at = ? WHERE id = ? AND org_id = ? AND (sync_started_at IS NULL OR sync_started_at < ?)", now(), linkId, orgId, stale);
  if (!claimed.changes) return false;
  try {
    await syncLink(orgId, linkId);
  } finally {
    await run("UPDATE connector_links SET sync_started_at = NULL WHERE id = ? AND org_id = ?", linkId, orgId);
  }
  return true;
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * Saves one item and (re-)indexes it when its text changed: work items as source type `workitem`, Confluence
 * pages and Microsoft 365 files whole as source type `page` (like documents). Returns whether it changed.
 */
async function saveItem(l: LinkRow, kind: ConnectorKind, item: WorkItem): Promise<boolean> {
  const page = isPageKind(kind);
  const text = kind === "m365" ? fileText(l.project_name, item) : page ? pageText(kind, l.project_name, item) : workItemText(kind, l.project_name, item);
  const hash = sha(`${l.audience}\n${text}`);
  const cur = await get<{ id: string; text_hash: string | null }>("SELECT id, text_hash FROM connector_items WHERE link_id = ? AND external_id = ? AND org_id = ?", l.id, item.externalId, l.org_id);
  if (cur?.text_hash === hash) return false;
  const id = cur?.id ?? newId();
  const blocked = item.blockedBy.length ? item.blockedBy.join("; ").slice(0, 1000) : null;
  if (cur) {
    await run(
      "UPDATE connector_items SET item_type = ?, title = ?, state = ?, assignee = ?, due_on = ?, url = ?, changed_at = ?, blocked_by = ?, comment_count = ?, text_hash = ?, synced_at = ? WHERE id = ? AND org_id = ?",
      item.type, item.title.slice(0, 500), item.state, item.assignee, item.dueOn, item.url, item.changedAt, blocked, item.commentCount, hash, now(), id, l.org_id,
    );
    await removeIndexedMany(l.org_id, [id]);
  } else {
    await run(
      `INSERT INTO connector_items (id, org_id, workspace_id, link_id, external_id, item_type, title, state, assignee, due_on, url, changed_at, blocked_by, comment_count, text_hash, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, l.org_id, l.workspace_id, l.id, item.externalId, item.type, item.title.slice(0, 500), item.state, item.assignee, item.dueOn, item.url, item.changedAt, blocked, item.commentCount, hash, now(),
    );
  }
  await indexText({ orgId: l.org_id, workspaceId: l.workspace_id, sourceType: page ? "page" : "workitem", sourceId: id, title: workItemTitle(kind, item), audience: l.audience, text });
  return true;
}

/** Deletes a link's items that went away in the tool (by external id) with their search entries. Returns how many. */
async function removeItems(l: LinkRow, externalIds: string[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < externalIds.length; i += 100) {
    const part = externalIds.slice(i, i + 100);
    const gone = await all<{ id: string }>(`SELECT id FROM connector_items WHERE link_id = ? AND org_id = ? AND external_id IN (${part.map(() => "?").join(", ")})`, l.id, l.org_id, ...part);
    if (!gone.length) continue;
    await removeIndexedMany(l.org_id, gone.map((g) => g.id));
    await run(`DELETE FROM connector_items WHERE link_id = ? AND org_id = ? AND id IN (${gone.map(() => "?").join(", ")})`, l.id, l.org_id, ...gone.map((g) => g.id));
    n += gone.length;
  }
  return n;
}

/**
 * Syncs one linked project: reads what changed since its cursor, page by page (cursor saved after each page),
 * saves and indexes changed items, deletes the ones that went away, and records the link's health (last try, last success, error in plain
 * words). An expired sign-in marks the connector expired. Traced with counts only. Throws the problem after
 * recording it, so callers can tell; scheduled runs just move on.
 */
export async function syncLink(orgId: string, linkId: string): Promise<{ changed: number; seen: number }> {
  const l = await get<LinkRow>("SELECT * FROM connector_links WHERE id = ? AND org_id = ?", linkId, orgId);
  if (!l) throw new HttpError(404, "Linked project not found.");
  const c = await get<ConnectorRow>("SELECT * FROM connectors WHERE id = ? AND org_id = ?", l.connector_id, orgId);
  if (!c) throw new HttpError(404, "Connector not found.");
  return span("connector", `Sync ${KIND_LABEL[c.kind]} project`, async () => {
    let seen = 0, changed = 0, pages = 0, removed = 0, skipped = 0;
    let cursor = l.sync_cursor;
    try {
      if (c.status === "expired") throw new ConnectorError("auth", expiredMessage(c.kind));
      for await (const raw of PROVIDERS[c.kind].changes(toolApi(c), c, l.project, l.sync_cursor)) {
        const page: ChangePage = Array.isArray(raw) ? { items: raw } : raw;
        pages++;
        for (const item of page.items) {
          seen++;
          if (item.state === "Skipped") skipped++;
          if (await saveItem(l, c.kind, item)) changed++;
          if (page.cursor === undefined && (!cursor || item.changedAt > cursor)) cursor = item.changedAt;
        }
        if (page.removed?.length) removed += await removeItems(l, page.removed);
        if (page.cursor !== undefined) cursor = page.cursor;
        await run("UPDATE connector_links SET sync_cursor = ? WHERE id = ? AND org_id = ?", cursor, l.id, orgId);
      }
      const count = Number((await get<{ n: number | string }>("SELECT COUNT(*) AS n FROM connector_items WHERE link_id = ? AND org_id = ?", l.id, orgId))?.n ?? 0);
      const at = now();
      await run("UPDATE connector_links SET item_count = ?, last_sync_at = ?, last_ok_at = ?, last_error = NULL WHERE id = ? AND org_id = ?", count, at, at, l.id, orgId);
      spanAttrs({ kind: c.kind, pages, seen, changed, removed, skipped, items: count, full: !l.sync_cursor, capped: seen >= ADO_MAX });
      await reportConnectorHealth({ orgId, workspaceId: l.workspace_id, connector: HEALTH[c.kind].id, label: HEALTH[c.kind].label, ok: true, fixHref: "/connectors" });
      return { changed, seen };
    } catch (e) {
      const message = e instanceof ConnectorError ? e.message : `The sync failed unexpectedly. ${BRAND.name} will try again.`;
      if (!(e instanceof ConnectorError)) console.error("Connector sync failed", e);
      if (e instanceof ConnectorError && e.reason === "auth") await markExpired(c); // reported organization-wide
      else await reportConnectorHealth({ orgId, workspaceId: l.workspace_id, connector: HEALTH[c.kind].id, label: HEALTH[c.kind].label, ok: false, message, fixHref: "/connectors" });
      await run("UPDATE connector_links SET last_sync_at = ?, last_error = ? WHERE id = ? AND org_id = ?", now(), message, l.id, orgId);
      spanAttrs({ kind: c.kind, pages, seen, changed, removed, reason: e instanceof ConnectorError ? e.reason : "unexpected" });
      throw e;
    }
  });
}

/**
 * The linked projects due for a scheduled sync: not synced for `SYNC_EVERY_MINUTES`, connector connected,
 * organization not paused, group not ending, not being synced right now; longest-waiting first, at most `limit`.
 * Who calls it: the job queue's recurring `connectors.schedule` job (lib/job-kinds.ts), which queues one
 * `connector.sync` job per link (`syncDueLink`).
 */
export async function dueConnectorLinks(at = new Date(), limit = 50): Promise<{ id: string; org_id: string; workspace_id: string }[]> {
  const due = new Date(at.getTime() - SYNC_EVERY_MINUTES * 60_000).toISOString();
  const stale = new Date(at.getTime() - SYNC_CLAIM_MINUTES * 60_000).toISOString();
  return all<{ id: string; org_id: string; workspace_id: string }>(
    `SELECT l.id, l.org_id, l.workspace_id FROM connector_links l
       JOIN connectors c ON c.id = l.connector_id AND c.org_id = l.org_id
       JOIN orgs o ON o.id = l.org_id
      WHERE c.status = 'connected' AND COALESCE(o.status, 'Active') <> 'Suspended'
        AND (l.last_sync_at IS NULL OR l.last_sync_at < ?) AND (l.sync_started_at IS NULL OR l.sync_started_at < ?)
        AND NOT EXISTS (SELECT 1 FROM rolloffs r WHERE r.org_id = l.org_id AND r.workspace_id = l.workspace_id AND r.status IN ('scheduled', 'running'))
      ORDER BY COALESCE(l.last_sync_at, '') LIMIT ?`,
    due, stale, limit,
  );
}

/**
 * One scheduled sync (the job queue's `connector.sync` job): claims and syncs the link. A tool problem isn't a job
 * failure (it's recorded in the link's health and the next run tries again), so the job never retries in a loop.
 * Returns what happened, for the job's counts.
 */
export async function syncDueLink(orgId: string, linkId: string): Promise<{ synced: number; syncFailed: number; skipped: number }> {
  try {
    return (await claimAndSync(orgId, linkId)) ? { synced: 1, syncFailed: 0, skipped: 0 } : { synced: 0, syncFailed: 0, skipped: 1 };
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return { synced: 0, syncFailed: 0, skipped: 1 }; // unlinked meanwhile
    return { synced: 0, syncFailed: 1, skipped: 0 };
  }
}

/* ---------------------------------------------------------------- */
/* Health                                                            */
/* ---------------------------------------------------------------- */

/**
 * One linked project's health, as the Connectors page shows it. `problem` is null when all is well. `skipped` is
 * how many of its items are notes for files that weren't read (Microsoft 365: too large, or couldn't be opened).
 */
export type LinkHealth = {
  id: string; connectorId: string; kind: ConnectorKind; workspaceId: string; workspaceName: string; project: string; projectName: string;
  audience: "internal" | "shareable"; items: number; skipped: number; lastSyncAt: string | null; lastOkAt: string | null; syncing: boolean; problem: string | null;
};
/** One group's connected tool's health. `status`: ok, expired (reconnect), error (a project fails or is stale), waiting (no sync yet). */
export type ConnectorHealth = {
  id: string; kind: ConnectorKind; label: string; workspaceId: string; workspaceName: string; account: string; accountName: string | null; status: "ok" | "expired" | "error" | "waiting";
  problem: string | null; connectedBy: string | null; connectedAt: string; lastSyncAt: string | null; lastOkAt: string | null; links: LinkHealth[];
};

const staleSince = (at: Date) => new Date(at.getTime() - STALE_HOURS * 3600_000).toISOString();

/** A link's problem in plain words: its last error, or "no successful sync since …" once stale. */
function linkProblem(l: Pick<LinkRow, "last_error" | "last_ok_at" | "created_at">, at: Date): string | null {
  if (l.last_error) return l.last_error;
  const since = l.last_ok_at ?? l.created_at;
  if (since < staleSince(at)) return `No successful sync since ${since.slice(0, 16).replace("T", " ")} UTC.`;
  return null;
}

type LinkJoin = LinkRow & { kind: ConnectorKind; workspace_name: string; skipped: number | string };
const toLinkHealth = (l: LinkJoin, at: Date): LinkHealth => ({
  id: l.id, connectorId: l.connector_id, kind: l.kind, workspaceId: l.workspace_id, workspaceName: l.workspace_name, project: l.project, projectName: l.project_name,
  audience: l.audience, items: Number(l.item_count), skipped: Number(l.skipped ?? 0), lastSyncAt: l.last_sync_at, lastOkAt: l.last_ok_at,
  syncing: Boolean(l.sync_started_at && l.sync_started_at > new Date(at.getTime() - SYNC_CLAIM_MINUTES * 60_000).toISOString()), problem: linkProblem(l, at),
});

const LINK_SELECT = `SELECT l.*, c.kind, w.name AS workspace_name,
    (SELECT COUNT(*) FROM connector_items i WHERE i.link_id = l.id AND i.org_id = l.org_id AND i.state = 'Skipped') AS skipped
  FROM connector_links l
  JOIN connectors c ON c.id = l.connector_id AND c.org_id = l.org_id
  JOIN workspaces w ON w.id = l.workspace_id AND w.org_id = l.org_id`;

async function linkHealth(orgId: string, linkId: string): Promise<LinkHealth> {
  const l = await get<LinkJoin>(`${LINK_SELECT} WHERE l.id = ? AND l.org_id = ?`, linkId, orgId);
  if (!l) throw new HttpError(404, "Linked project not found.");
  return toLinkHealth(l, new Date());
}

/**
 * The groups' connected tools with their health and linked projects, for the Connectors page and the group page.
 * `workspaceIds` limits them to those groups (pass the person's own groups; admins see every group). Never
 * includes tokens.
 */
export async function connectorHealth(orgId: string, workspaceIds: string[] | null, at = new Date()): Promise<ConnectorHealth[]> {
  const conns = (await all<ConnectorRow & { workspace_name: string }>(
    "SELECT c.*, w.name AS workspace_name FROM connectors c JOIN workspaces w ON w.id = c.workspace_id AND w.org_id = c.org_id WHERE c.org_id = ? ORDER BY c.kind, w.name", orgId,
  )).filter((c) => !workspaceIds || workspaceIds.includes(c.workspace_id));
  const links = (await all<LinkJoin>(`${LINK_SELECT} WHERE l.org_id = ? ORDER BY w.name, l.project_name`, orgId))
    .filter((l) => !workspaceIds || workspaceIds.includes(l.workspace_id));
  return conns.map((c) => {
    const mine = links.filter((l) => l.connector_id === c.id).map((l) => toLinkHealth(l, at));
    const okTimes = mine.map((l) => l.lastOkAt).filter((x): x is string => !!x).sort();
    const tries = mine.map((l) => l.lastSyncAt).filter((x): x is string => !!x).sort();
    const broken = mine.filter((l) => l.problem);
    const status: ConnectorHealth["status"] = c.status === "expired" ? "expired" : broken.length ? "error" : mine.length && !okTimes.length ? "waiting" : "ok";
    const problem = c.status === "expired" ? (c.last_error ?? expiredMessage(c.kind))
      : broken.length ? `${broken.length} linked project${broken.length === 1 ? " has" : "s have"} a problem: ${broken[0].problem}` : null;
    return {
      id: c.id, kind: c.kind, label: KIND_LABEL[c.kind], workspaceId: c.workspace_id, workspaceName: c.workspace_name, account: c.account, accountName: c.account_name, status, problem,
      connectedBy: c.connected_by, connectedAt: c.connected_at, lastSyncAt: tries.at(-1) ?? null, lastOkAt: okTimes.at(-1) ?? null, links: mine,
    };
  });
}

/**
 * The Connectors page's view for one person: the tool types the organization allows (`allowed`), the connections
 * of the groups they can see (health and links), what this server has set up (`configured`), the requests they
 * may see (lib/connector-requests.ts `requestsFor`), and what they may do: `canToggle` (Org Owner: allow or stop
 * tool types, approve requests), `canConnect` (Org Owners/Admins for any group, Team Leads for their groups:
 * connect, reconnect, disconnect, link), `canRequest` (Org Admins and Team Leads ask for a type that isn't allowed).
 */
export async function connectorsFor(user: User) {
  const ids = isAdmin(user) ? null : await workspaceIdsFor(user);
  return {
    allowed: await allowedKinds(user.org_id), connectors: await connectorHealth(user.org_id, ids), configured: configuredKinds(), requests: await requestsFor(user),
    canToggle: user.role === "Org Owner", canConnect: isAdmin(user) || user.role === "Team Lead", canRequest: user.role === "Org Admin" || user.role === "Team Lead",
  };
}

/** One broken connector or linked project, across all organizations (see `connectorProblems`). */
export type BrokenConnector = {
  orgId: string; connectorId: string; kind: ConnectorKind; linkId: string | null; workspaceId: string | null;
  /** expired = the sign-in ran out or was revoked; error = the last sync failed; stale = no success for STALE_HOURS. */
  reason: "expired" | "error" | "stale"; problem: string;
  /** Since when (the last success, or when it was connected/linked). */
  since: string;
};

/**
 * Every broken connector across all organizations, including links that went **stale** (no success for
 * `STALE_HOURS`), for operators and scripts (system use only). The watcher itself reads the health each sync
 * reports through lib/connector-health.ts (`reportHealth` below). One entry per expired connector and per failing
 * or stale link of a connected one. Pure read.
 */
export async function connectorProblems(at = new Date()): Promise<BrokenConnector[]> {
  const out: BrokenConnector[] = [];
  for (const c of await all<ConnectorRow>("SELECT * FROM connectors WHERE status = 'expired'")) {
    out.push({ orgId: c.org_id, connectorId: c.id, kind: c.kind, linkId: null, workspaceId: null, reason: "expired", problem: c.last_error ?? expiredMessage(c.kind), since: c.last_error_at ?? c.updated_at });
  }
  const stale = staleSince(at);
  const links = await all<LinkRow & { kind: ConnectorKind }>(
    `SELECT l.*, c.kind FROM connector_links l JOIN connectors c ON c.id = l.connector_id AND c.org_id = l.org_id
      WHERE c.status = 'connected' AND (l.last_error IS NOT NULL OR COALESCE(l.last_ok_at, l.created_at) < ?)`,
    stale,
  );
  for (const l of links) {
    out.push({
      orgId: l.org_id, connectorId: l.connector_id, kind: l.kind, linkId: l.id, workspaceId: l.workspace_id,
      reason: l.last_error ? "error" : "stale", problem: linkProblem(l, at) ?? "", since: l.last_ok_at ?? l.created_at,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* Using the items: citations, knowledge map, meeting notes          */
/* ---------------------------------------------------------------- */

/** The tool links of cited work items and Confluence pages (source id → URL), scoped to the organization. */
export async function workItemLinks(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    for (const r of await all<{ id: string; url: string }>(`SELECT id, url FROM connector_items WHERE org_id = ? AND id IN (${part.map(() => "?").join(", ")})`, orgId, ...part)) {
      if (/^https?:\/\//i.test(r.url)) out.set(r.id, r.url); // only web links, never another scheme
    }
  }
  return out;
}

/**
 * The group's open work items (not done/closed/merged), most recently changed first, as inventory lines for the
 * knowledge map and meeting notes: `- "<title as indexed>": State · assignee · due · blocked by …`. At most `limit`.
 * Confluence pages aren't work, so they're left out (they reach the knowledge map as documents through search).
 */
export async function openWorkItemLines(orgId: string, workspaceId: string, limit = 60): Promise<string[]> {
  const rows = await all<{ kind: ConnectorKind; external_id: string; item_type: string | null; title: string; state: string | null; assignee: string | null; due_on: string | null; blocked_by: string | null; changed_at: string | null }>(
    `SELECT c.kind, i.external_id, i.item_type, i.title, i.state, i.assignee, i.due_on, i.blocked_by, i.changed_at FROM connector_items i
       JOIN connector_links l ON l.id = i.link_id AND l.org_id = i.org_id JOIN connectors c ON c.id = l.connector_id AND c.org_id = l.org_id
      WHERE i.org_id = ? AND i.workspace_id = ? ORDER BY i.changed_at DESC LIMIT 400`,
    orgId, workspaceId,
  );
  return rows.filter((r) => !isPageKind(r.kind) && !isDoneState(r.state)).slice(0, limit).map((r) => {
    const title = workItemTitle(r.kind, { externalId: r.external_id, title: r.title, type: r.item_type });
    const bits = [r.state, r.assignee ? `assigned to ${r.assignee}` : "unassigned", r.due_on ? `due ${r.due_on}` : null, r.blocked_by ? `blocked by ${r.blocked_by}` : null, r.changed_at ? `changed ${r.changed_at.slice(0, 10)}` : null];
    return `- "${title}": ${bits.filter(Boolean).join(" · ")}`;
  });
}
