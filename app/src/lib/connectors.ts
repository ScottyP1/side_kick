/**
 * @file Connectors to outside tools: the framework that lets an organization connect Azure DevOps Boards or Jira
 * once, link projects to groups, and keep those projects' work items in each group's knowledge, **read-only**.
 * The tools themselves are in lib/connector-ado.ts and lib/connector-jira.ts (`Provider`); the text Sidekick
 * indexes for each item is in lib/connector-text.ts.
 *
 * Concepts
 * - **Connector** (`connectors` table): one per organization and tool. An Org Owner or Org Admin connects it
 *   with the tool's own sign-in (OAuth authorization code flow; Microsoft Entra ID for Azure DevOps, Atlassian
 *   for Jira). No passwords are ever stored. The access and refresh tokens are **sealed** (encrypted at rest with
 *   the `SIDEKICK_ENCRYPTION_KEY` envelope setup, lib/secret-box.ts) and refreshed shortly before they run out.
 *   When a refresh is refused (revoked, expired after long disuse) the connector turns **expired** and someone
 *   must reconnect; nothing is deleted.
 * - **Link** (`connector_links`): one project (ADO) or project key (Jira) feeding one group. Org Owners/Admins
 *   and that group's Team Lead link and unlink (`requireManage`). Each link has an audience like documents
 *   (internal by default; shareable ones may be used when client guests are present).
 * - **Items** (`connector_items`): the work items read from a linked project (title, type, state, assignee, due
 *   date, link, what blocks it, description, comments summary). Each is indexed through lib/search.ts as source
 *   type `workitem`, so Ask cites it ("what's blocking the cutover?" → "Azure DevOps Bug #4821 …" with a link),
 *   the knowledge map (Memory & gaps) and meeting notes see the group's open items.
 * - **Incremental sync** (`syncLink`): only what changed since the link's cursor (the latest change time seen),
 *   in pages; the cursor is saved after every page, so a failure resumes where it stopped. Unchanged items
 *   (same text) aren't re-indexed. Runs on link, on "Sync now", and every `SYNC_EVERY_MINUTES` from the
 *   scheduler (`runDueConnectorSyncs`, called by the reminder tick today; the job queue can call the same
 *   function). Every sync is a trace step (kind "connector") with counts only, never item text.
 * - **Health** (`connectorHealth` for the Connectors page, `brokenConnectors` for the "broken connector"
 *   watcher): last sync, last success, the last error in plain words, and whether the sign-in expired. A link
 *   with no successful sync for `STALE_HOURS` counts as broken too.
 * - **Plan limits**: the plan's `connectors` limit (lib/plans.ts: none, one tool, or all) is checked before
 *   a *new* tool is connected (`assertCanAdd(org, "connectors")`); reconnecting one never counts again, and a
 *   smaller plan keeps what's connected.
 * - **Disconnect** removes the tokens, every link and every imported item with its search entries (local and
 *   Azure). Unlinking a project removes that project's items. Deleting a group or organization does too.
 *
 * Walls: every query is scoped to the organization, and every group-level call goes through
 * `requireWorkspace`/`requireManage` first. Tokens never leave the server (never in a response, log or trace).
 */
import "server-only";
import crypto from "node:crypto";
import { all, get, newId, now, run, tx } from "./db";
import { audit, auditAsSidekick, HttpError, isAdmin, requireManage, workspaceIdsFor, type User } from "./auth";
import { openSecret, sealSecret } from "./secret-box";
import { indexText, removeIndexedMany } from "./search";
import { span, spanAttrs, withTrace } from "./trace";
import { assertCanAdd } from "./limits";
import { BRAND } from "./brand";
import { ado, MAX_PER_SYNC as ADO_MAX } from "./connector-ado";
import { jira } from "./connector-jira";
import { adoOrgName, ConnectorError, CONNECTOR_KINDS, isDoneState, KIND_LABEL, workItemText, workItemTitle, type ConnectorKind, type WorkItem } from "./connector-text";

export { CONNECTOR_KINDS, KIND_LABEL, type ConnectorKind } from "./connector-text";

/** How often the scheduler syncs each linked project. */
export const SYNC_EVERY_MINUTES = 15;
/** A link with no successful sync for this long counts as broken (health, watcher). */
export const STALE_HOURS = 6;
/** A sync claimed longer ago than this is assumed to have died and may be claimed again. */
const SYNC_CLAIM_MINUTES = 15;
const STATE_MINUTES = 10;
/** Browser cookie tying a connector sign-in to the browser that started it (like Microsoft sign-in's). */
export const CONNECTOR_COOKIE = "sk_connector";

/** A `connectors` row. Tokens are sealed; use `toolApi` to call the tool. */
export type ConnectorRow = {
  id: string; org_id: string; kind: ConnectorKind; status: "connected" | "expired"; account: string; account_name: string | null;
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
 * being read ("the project “Wave 2”") for those messages.
 */
export type ToolApi = (url: string, init?: { method?: string; body?: unknown }, opts?: { what?: string }) => Promise<{ json: unknown; headers: Headers }>;

/** What each tool (lib/connector-ado.ts, lib/connector-jira.ts) provides to the framework. */
export type Provider = {
  kind: ConnectorKind;
  /** True when connecting needs a site typed first (ADO: the organization name). */
  needsSite: boolean;
  /** True when the tool's app id and secret are set on this server. */
  configured(): boolean;
  authorizeUrl(o: { state: string; challenge: string; redirectUri: string }): string;
  exchange(code: string, verifier: string, redirectUri: string): Promise<Tokens | { error: string }>;
  refresh(refreshToken: string): Promise<Tokens | { error: string; revoked: boolean }>;
  /** Which account/site the signed-in person's token opens (checks access). */
  account(api: ToolApi, site: string | null): Promise<{ account: string; accountName: string; apiBase: string; webBase: string }>;
  projects(api: ToolApi, conn: ConnectorRow): Promise<{ key: string; name: string }[]>;
  /** The items changed since `cursor` (null = everything), oldest first, one page at a time. */
  changes(api: ToolApi, conn: ConnectorRow, project: string, cursor: string | null): AsyncGenerator<WorkItem[]>;
};

const PROVIDERS: Record<ConnectorKind, Provider> = { ado, jira };

/** Checks a tool name from a request ("ado" or "jira"), or 400. */
export function kindOf(value: unknown): ConnectorKind {
  if (typeof value === "string" && (CONNECTOR_KINDS as readonly string[]).includes(value)) return value as ConnectorKind;
  throw new HttpError(400, `Pick a tool: ${CONNECTOR_KINDS.join(" or ")}.`);
}

/** Whether each tool's app is set up on this server (the Connectors page says "not set up yet" otherwise). */
export const configuredKinds = (): Record<ConnectorKind, boolean> => ({ ado: ado.configured(), jira: jira.configured() });

const expiredMessage = (kind: ConnectorKind) =>
  `The ${KIND_LABEL[kind]} sign-in has expired or was revoked. An Org Owner or Org Admin needs to reconnect it on Connectors.`;

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

function makeApi(kind: ConnectorKind, token: (force: boolean) => Promise<string>): ToolApi {
  const label = KIND_LABEL[kind];
  return async (url, init = {}, opts = {}) => {
    for (let attempt = 0; ; attempt++) {
      const tok = await token(attempt > 0);
      let res: Response;
      try {
        res = await fetch(url, {
          method: init.method ?? "GET",
          headers: { Authorization: `Bearer ${tok}`, Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
          signal: AbortSignal.timeout(30_000),
          redirect: "manual",
        });
      } catch {
        throw new ConnectorError("network", `${BRAND.name} couldn't reach ${label}. It will try again on the next sync.`);
      }
      // ADO answers an unusable token with 203 and a sign-in page (or a redirect) instead of 401.
      const unauthorized = res.status === 401 || res.status === 203 || (res.status >= 300 && res.status < 400);
      if (unauthorized && attempt === 0) continue; // the token may have just run out: refresh once and retry
      if (res.ok && !unauthorized) return { json: await res.json().catch(() => null), headers: res.headers };
      if (unauthorized) throw new ConnectorError("auth", expiredMessage(kind));
      if (res.status === 403) throw new ConnectorError("access", `${label} refused access${opts.what ? ` to ${opts.what}` : ""}: the account that connected it may have lost access. Reconnect with an account that can open it, or unlink it.`);
      if (res.status === 404) throw new ConnectorError("notfound", `${label} couldn't find ${opts.what ?? "what was asked for"}. It may have been renamed or deleted.`);
      if (res.status === 429 || res.status >= 500) throw new ConnectorError("busy", `${label} is busy or unavailable right now (${res.status}). ${BRAND.name} will try again on the next sync.`);
      throw new ConnectorError("tool", `${label} answered ${res.status}.`);
    }
  };
}

const refreshing = new Map<string, Promise<string>>();

/** Marks a connector expired (once), with the plain reason, and tells the audit log. */
async function markExpired(c: Pick<ConnectorRow, "id" | "org_id" | "kind">) {
  const msg = expiredMessage(c.kind);
  const r = await run("UPDATE connectors SET status = 'expired', last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status <> 'expired'", msg, now(), now(), c.id, c.org_id);
  if (r.changes) await auditAsSidekick(c.org_id, `The ${KIND_LABEL[c.kind]} sign-in expired or was revoked; syncing paused until someone reconnects it`, "Connectors");
}

/**
 * A valid access token for the connector: the stored one while it has over a minute left (and `force` is off),
 * otherwise a refreshed one (saved sealed, with Atlassian's rotated refresh token). One refresh at a time per
 * connector in this process. A refused refresh marks the connector expired.
 */
async function connectorToken(c: Pick<ConnectorRow, "id" | "org_id" | "kind">, force: boolean): Promise<string> {
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
 * Starts connecting a tool for the person's organization (Org Owner/Admin; the route checks the role). Refuses
 * when the tool's app isn't set up here (503), when a new tool would go past the plan's `connectors` limit
 * (402 with the upgrade message), and for ADO without a valid organization name. Saves a one-time state with
 * a PKCE verifier and returns the tool's sign-in address plus the state for the browser cookie.
 */
export async function startConnect(req: Request, user: User, kindRaw: unknown, siteRaw: unknown): Promise<{ url: string; state: string }> {
  const kind = kindOf(kindRaw);
  const p = PROVIDERS[kind];
  if (!p.configured()) throw new HttpError(503, `Connecting ${KIND_LABEL[kind]} isn't set up on this ${BRAND.name} yet. The ${BRAND.name} team adds it (docs/RUNBOOKS.md).`);
  let site: string | null = typeof siteRaw === "string" && siteRaw.trim() ? siteRaw.trim().slice(0, 200) : null;
  if (kind === "ado") {
    site = adoOrgName(siteRaw);
    if (!site) throw new HttpError(400, "Type your Azure DevOps organization: the name after dev.azure.com/ (for example “northwind”).");
  }
  const existing = await get<{ id: string }>("SELECT id FROM connectors WHERE org_id = ? AND kind = ?", user.org_id, kind);
  if (!existing) await assertCanAdd(user.org_id, "connectors");
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  await run("DELETE FROM connector_states WHERE expires_at < ?", now());
  await run(
    "INSERT INTO connector_states (state, org_id, user_id, kind, verifier, site, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    state, user.org_id, user.id, kind, verifier, site, new Date(Date.now() + STATE_MINUTES * 60_000).toISOString(),
  );
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { url: p.authorizeUrl({ state, challenge, redirectUri: connectorRedirectUri(req) }), state };
}

/**
 * Finishes connecting: checks the state against the browser cookie (used once, 10 minutes), swaps the code for
 * tokens, checks which account/site they open, and saves the connector with the tokens sealed. Reconnecting the
 * same account replaces the tokens and resumes syncing; a different account is refused (disconnect first, so
 * the old account's items don't mix with the new). Only the person who started may finish, and only while
 * they're still an Org Owner/Admin. Audited.
 * @returns the tool that was connected
 */
export async function finishConnect(req: Request, cookieState: string | undefined): Promise<ConnectorKind> {
  const q = new URL(req.url).searchParams;
  const state = q.get("state") ?? "";
  const saved = state ? await get<{ state: string; org_id: string; user_id: string; kind: ConnectorKind; verifier: string; site: string | null; expires_at: string }>("SELECT * FROM connector_states WHERE state = ?", state) : undefined;
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
  if (!user || !isAdmin(user)) throw new HttpError(403, "Only Org Owners and Org Admins can connect tools.");
  const kind = saved.kind;
  const p = PROVIDERS[kind];
  return span("connector", `Connect ${KIND_LABEL[kind]}`, async () => {
    const tokens = await p.exchange(code, saved.verifier, connectorRedirectUri(req)).catch(() => ({ error: "unreachable" }));
    if ("error" in tokens) {
      console.error(`Connector sign-in: ${kind} token exchange failed`, tokens.error);
      throw new HttpError(502, `${KIND_LABEL[kind]} didn't confirm the sign-in. Try again; if it keeps happening, the app's secret may have expired.`);
    }
    const api = makeApi(kind, async () => tokens.access);
    const acct = await p.account(api, saved.site).catch(asHttp);
    const existing = await get<ConnectorRow>("SELECT * FROM connectors WHERE org_id = ? AND kind = ?", saved.org_id, kind);
    if (existing && existing.account !== acct.account) {
      throw new HttpError(409, `${KIND_LABEL[kind]} is already connected to ${existing.account_name ?? existing.account}. Disconnect it first to switch to ${acct.accountName}.`);
    }
    if (!existing) await assertCanAdd(saved.org_id, "connectors");
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
        `INSERT INTO connectors (id, org_id, kind, status, account, account_name, api_base, web_base, access_token, refresh_token, token_expires_at, connected_by, connected_at, updated_at)
         VALUES (?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, saved.org_id, kind, acct.account, acct.accountName, acct.apiBase, acct.webBase, sealedAccess, sealedRefresh, expires, user.name, now(), now(),
      );
    }
    spanAttrs({ kind, reconnect: Boolean(existing) });
    await audit(user, `${existing ? "Reconnected" : "Connected"} ${KIND_LABEL[kind]} (${acct.accountName}), read-only`, "Connectors");
    return kind;
  });
}

/** The organization's connector, or 404 (also for another organization's id). */
async function ownConnector(orgId: string, id: unknown): Promise<ConnectorRow> {
  const c = typeof id === "string" ? await get<ConnectorRow>("SELECT * FROM connectors WHERE id = ? AND org_id = ?", id, orgId) : undefined;
  if (!c) throw new HttpError(404, "Connector not found.");
  return c;
}

/**
 * Disconnects a tool (Org Owner/Admin; the route checks the role): removes its tokens, every link and every
 * imported item with its search entries (local and Azure). Audited with the counts.
 */
export async function disconnect(user: User, id: unknown): Promise<{ links: number; items: number }> {
  const c = await ownConnector(user.org_id, id);
  return span("connector", `Disconnect ${KIND_LABEL[c.kind]}`, async () => {
    const items = await all<{ id: string }>("SELECT id FROM connector_items WHERE org_id = ? AND link_id IN (SELECT id FROM connector_links WHERE connector_id = ? AND org_id = ?)", user.org_id, c.id, user.org_id);
    const links = await all<{ id: string }>("SELECT id FROM connector_links WHERE connector_id = ? AND org_id = ?", c.id, user.org_id);
    await removeIndexedMany(user.org_id, items.map((i) => i.id));
    await tx(async () => {
      await run("DELETE FROM connector_items WHERE org_id = ? AND link_id IN (SELECT id FROM connector_links WHERE connector_id = ? AND org_id = ?)", user.org_id, c.id, user.org_id);
      await run("DELETE FROM connector_links WHERE connector_id = ? AND org_id = ?", c.id, user.org_id);
      await run("DELETE FROM connectors WHERE id = ? AND org_id = ?", c.id, user.org_id);
    });
    spanAttrs({ kind: c.kind, links: links.length, items: items.length });
    await audit(user, `Disconnected ${KIND_LABEL[c.kind]} (${c.account_name ?? c.account}): removed its sign-in, ${links.length} linked project${links.length === 1 ? "" : "s"} and ${items.length} imported item${items.length === 1 ? "" : "s"}`, "Connectors");
    return { links: links.length, items: items.length };
  });
}

/* ---------------------------------------------------------------- */
/* Linking projects to groups                                        */
/* ---------------------------------------------------------------- */

/**
 * The projects the connected account can read in a tool (Org Owners/Admins and Team Leads: the people who may
 * link them). A tool problem becomes a plain 409/502.
 */
export async function listProjects(user: User, connectorId: unknown): Promise<{ key: string; name: string }[]> {
  if (!isAdmin(user) && user.role !== "Team Lead") throw new HttpError(403, "Only Org Owners, Org Admins and Team Leads can link projects to groups.");
  const c = await ownConnector(user.org_id, connectorId);
  return span("connector", `List ${KIND_LABEL[c.kind]} projects`, async () => {
    const list = await PROVIDERS[c.kind].projects(toolApi(c), c).catch(asHttp);
    spanAttrs({ kind: c.kind, projects: list.length });
    return list;
  });
}

/**
 * Links a project to a group (Org Owner/Admin, or the group's Team Lead: `requireManage`), then runs its first
 * sync straight away. The project must be one the connected account can read (checked against the tool's own
 * list, so a typo or a made-up key is refused). The same project can feed several groups (each keeps its own
 * copy, walled to that group). Audited. A failing first sync doesn't undo the link: its health shows why.
 */
export async function linkProject(user: User, body: { connector?: unknown; ws?: unknown; project?: unknown; audience?: unknown }) {
  const ws = await requireManage(user, typeof body.ws === "string" ? body.ws : null);
  const c = await ownConnector(user.org_id, body.connector);
  if (c.status === "expired") throw new HttpError(409, expiredMessage(c.kind));
  if (typeof body.project !== "string" || !body.project.trim()) throw new HttpError(400, "Pick a project to link.");
  const audience = body.audience === "shareable" ? "shareable" : "internal";
  const projects = await PROVIDERS[c.kind].projects(toolApi(c), c).catch(asHttp);
  const p = projects.find((x) => x.key === body.project || x.key.toLowerCase() === String(body.project).trim().toLowerCase());
  if (!p) throw new HttpError(404, `${KIND_LABEL[c.kind]} has no project “${String(body.project).slice(0, 80)}” that the connected account can read.`);
  if (await get("SELECT id FROM connector_links WHERE connector_id = ? AND workspace_id = ? AND project = ? AND org_id = ?", c.id, ws, p.key, user.org_id)) {
    throw new HttpError(409, `${p.name} is already linked to this group.`);
  }
  const id = newId();
  await run(
    "INSERT INTO connector_links (id, org_id, connector_id, workspace_id, project, project_name, audience, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, user.org_id, c.id, ws, p.key, p.name, audience, user.name, now(),
  );
  await audit(user, `Linked ${KIND_LABEL[c.kind]} project ${p.name} to this group (${audience}, read-only)`, "Connectors", ws);
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
  await audit(user, `Unlinked ${KIND_LABEL[l.kind]} project ${l.project_name} from this group: removed ${items.length} imported item${items.length === 1 ? "" : "s"}`, "Connectors", l.workspace_id);
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

/** Saves one item and (re-)indexes it when its text changed. Returns whether it changed. */
async function saveItem(l: LinkRow, kind: ConnectorKind, item: WorkItem): Promise<boolean> {
  const text = workItemText(kind, l.project_name, item);
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
  await indexText({ orgId: l.org_id, workspaceId: l.workspace_id, sourceType: "workitem", sourceId: id, title: workItemTitle(kind, item), audience: l.audience, text });
  return true;
}

/**
 * Syncs one linked project: reads what changed since its cursor, page by page (cursor saved after each page),
 * saves and indexes changed items, and records the link's health (last try, last success, error in plain
 * words). An expired sign-in marks the connector expired. Traced with counts only. Throws the problem after
 * recording it, so callers can tell; scheduled runs just move on.
 */
export async function syncLink(orgId: string, linkId: string): Promise<{ changed: number; seen: number }> {
  const l = await get<LinkRow>("SELECT * FROM connector_links WHERE id = ? AND org_id = ?", linkId, orgId);
  if (!l) throw new HttpError(404, "Linked project not found.");
  const c = await get<ConnectorRow>("SELECT * FROM connectors WHERE id = ? AND org_id = ?", l.connector_id, orgId);
  if (!c) throw new HttpError(404, "Connector not found.");
  return span("connector", `Sync ${KIND_LABEL[c.kind]} project`, async () => {
    let seen = 0, changed = 0, pages = 0;
    let cursor = l.sync_cursor;
    try {
      if (c.status === "expired") throw new ConnectorError("auth", expiredMessage(c.kind));
      for await (const page of PROVIDERS[c.kind].changes(toolApi(c), c, l.project, l.sync_cursor)) {
        pages++;
        for (const item of page) {
          seen++;
          if (await saveItem(l, c.kind, item)) changed++;
          if (!cursor || item.changedAt > cursor) cursor = item.changedAt;
        }
        await run("UPDATE connector_links SET sync_cursor = ? WHERE id = ? AND org_id = ?", cursor, l.id, orgId);
      }
      const count = Number((await get<{ n: number | string }>("SELECT COUNT(*) AS n FROM connector_items WHERE link_id = ? AND org_id = ?", l.id, orgId))?.n ?? 0);
      const at = now();
      await run("UPDATE connector_links SET item_count = ?, last_sync_at = ?, last_ok_at = ?, last_error = NULL WHERE id = ? AND org_id = ?", count, at, at, l.id, orgId);
      spanAttrs({ kind: c.kind, pages, seen, changed, items: count, full: !l.sync_cursor, capped: seen >= ADO_MAX });
      return { changed, seen };
    } catch (e) {
      const message = e instanceof ConnectorError ? e.message : `The sync failed unexpectedly. ${BRAND.name} will try again.`;
      if (!(e instanceof ConnectorError)) console.error("Connector sync failed", e);
      if (e instanceof ConnectorError && e.reason === "auth") await markExpired(c);
      await run("UPDATE connector_links SET last_sync_at = ?, last_error = ? WHERE id = ? AND org_id = ?", now(), message, l.id, orgId);
      spanAttrs({ kind: c.kind, pages, seen, changed, reason: e instanceof ConnectorError ? e.reason : "unexpected" });
      throw e;
    }
  });
}

/**
 * The scheduler's step: syncs every linked project that is due (not synced for `SYNC_EVERY_MINUTES`), whose
 * connector is connected, whose organization isn't paused and whose group isn't ending; at most `limit` per run,
 * longest-waiting first. Each runs as its own trace for its organization (Activity page). Returns how many synced.
 *
 * Who calls it: POST /api/reminders/tick (the in-app timer) today. The job queue can call it instead (or
 * `syncLink` per link as one job each): it needs nothing else.
 */
export async function runDueConnectorSyncs(at = new Date(), limit = 10): Promise<number> {
  const due = new Date(at.getTime() - SYNC_EVERY_MINUTES * 60_000).toISOString();
  const stale = new Date(at.getTime() - SYNC_CLAIM_MINUTES * 60_000).toISOString();
  const rows = await all<{ id: string; org_id: string; workspace_id: string; kind: ConnectorKind }>(
    `SELECT l.id, l.org_id, l.workspace_id, c.kind FROM connector_links l
       JOIN connectors c ON c.id = l.connector_id AND c.org_id = l.org_id
       JOIN orgs o ON o.id = l.org_id
      WHERE c.status = 'connected' AND COALESCE(o.status, 'Active') <> 'Suspended'
        AND (l.last_sync_at IS NULL OR l.last_sync_at < ?) AND (l.sync_started_at IS NULL OR l.sync_started_at < ?)
        AND NOT EXISTS (SELECT 1 FROM rolloffs r WHERE r.org_id = l.org_id AND r.workspace_id = l.workspace_id AND r.status IN ('scheduled', 'running'))
      ORDER BY COALESCE(l.last_sync_at, '') LIMIT ?`,
    due, stale, limit,
  );
  let done = 0;
  for (const r of rows) {
    const ok = await withTrace({ name: `Sync ${KIND_LABEL[r.kind]} project`, channel: "system", kind: "connector", orgId: r.org_id, workspaceId: r.workspace_id, actor: BRAND.name, detached: true }, () =>
      claimAndSync(r.org_id, r.id),
    ).catch(() => false);
    if (ok) done++;
  }
  return done;
}

/* ---------------------------------------------------------------- */
/* Health                                                            */
/* ---------------------------------------------------------------- */

/** One linked project's health, as the Connectors page shows it. `problem` is null when all is well. */
export type LinkHealth = {
  id: string; connectorId: string; kind: ConnectorKind; workspaceId: string; workspaceName: string; project: string; projectName: string;
  audience: "internal" | "shareable"; items: number; lastSyncAt: string | null; lastOkAt: string | null; syncing: boolean; problem: string | null;
};
/** One connected tool's health. `status`: ok, expired (reconnect), error (a project fails or is stale), waiting (no sync yet). */
export type ConnectorHealth = {
  id: string; kind: ConnectorKind; label: string; account: string; accountName: string | null; status: "ok" | "expired" | "error" | "waiting";
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

type LinkJoin = LinkRow & { kind: ConnectorKind; workspace_name: string };
const toLinkHealth = (l: LinkJoin, at: Date): LinkHealth => ({
  id: l.id, connectorId: l.connector_id, kind: l.kind, workspaceId: l.workspace_id, workspaceName: l.workspace_name, project: l.project, projectName: l.project_name,
  audience: l.audience, items: Number(l.item_count), lastSyncAt: l.last_sync_at, lastOkAt: l.last_ok_at,
  syncing: Boolean(l.sync_started_at && l.sync_started_at > new Date(at.getTime() - SYNC_CLAIM_MINUTES * 60_000).toISOString()), problem: linkProblem(l, at),
});

const LINK_SELECT = `SELECT l.*, c.kind, w.name AS workspace_name FROM connector_links l
  JOIN connectors c ON c.id = l.connector_id AND c.org_id = l.org_id
  JOIN workspaces w ON w.id = l.workspace_id AND w.org_id = l.org_id`;

async function linkHealth(orgId: string, linkId: string): Promise<LinkHealth> {
  const l = await get<LinkJoin>(`${LINK_SELECT} WHERE l.id = ? AND l.org_id = ?`, linkId, orgId);
  if (!l) throw new HttpError(404, "Linked project not found.");
  return toLinkHealth(l, new Date());
}

/**
 * The organization's connected tools with their health and linked projects, for the Connectors page and the
 * group page. `workspaceIds` limits the projects shown to those groups (pass the person's own groups; admins
 * see every group). Never includes tokens.
 */
export async function connectorHealth(orgId: string, workspaceIds: string[] | null, at = new Date()): Promise<ConnectorHealth[]> {
  const conns = await all<ConnectorRow>("SELECT * FROM connectors WHERE org_id = ? ORDER BY kind", orgId);
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
      id: c.id, kind: c.kind, label: KIND_LABEL[c.kind], account: c.account, accountName: c.account_name, status, problem,
      connectedBy: c.connected_by, connectedAt: c.connected_at, lastSyncAt: tries.at(-1) ?? null, lastOkAt: okTimes.at(-1) ?? null, links: mine,
    };
  });
}

/** The Connectors page's view for one person: tools (health), their visible links, and what this server and plan allow. */
export async function connectorsFor(user: User) {
  const ids = isAdmin(user) ? null : await workspaceIdsFor(user);
  return { connectors: await connectorHealth(user.org_id, ids), configured: configuredKinds() };
}

/** One broken connector or linked project, for the "broken connector" watcher (see `brokenConnectors`). */
export type BrokenConnector = {
  orgId: string; connectorId: string; kind: ConnectorKind; linkId: string | null; workspaceId: string | null;
  /** expired = the sign-in ran out or was revoked; error = the last sync failed; stale = no success for STALE_HOURS. */
  reason: "expired" | "error" | "stale"; problem: string;
  /** Since when (the last success, or when it was connected/linked). */
  since: string;
};

/**
 * Every broken connector across all organizations (system use only: the job queue's "broken connector" watcher,
 * or the Owner Console). One entry per expired connector (its links aren't listed separately) and per failing or
 * stale link of a connected one. Pure read: deduplicate on (connectorId, linkId, reason) when notifying.
 */
export async function brokenConnectors(at = new Date()): Promise<BrokenConnector[]> {
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

/** The tool links of cited work items (source id → URL), scoped to the organization. */
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
 * The group's open work items (not done/closed), most recently changed first, as inventory lines for the
 * knowledge map and meeting notes: `- "<title as indexed>": State · assignee · due · blocked by …`. At most `limit`.
 */
export async function openWorkItemLines(orgId: string, workspaceId: string, limit = 60): Promise<string[]> {
  const rows = await all<{ kind: ConnectorKind; external_id: string; item_type: string | null; title: string; state: string | null; assignee: string | null; due_on: string | null; blocked_by: string | null; changed_at: string | null }>(
    `SELECT c.kind, i.external_id, i.item_type, i.title, i.state, i.assignee, i.due_on, i.blocked_by, i.changed_at FROM connector_items i
       JOIN connector_links l ON l.id = i.link_id AND l.org_id = i.org_id JOIN connectors c ON c.id = l.connector_id AND c.org_id = l.org_id
      WHERE i.org_id = ? AND i.workspace_id = ? ORDER BY i.changed_at DESC LIMIT 400`,
    orgId, workspaceId,
  );
  return rows.filter((r) => !isDoneState(r.state)).slice(0, limit).map((r) => {
    const title = workItemTitle(r.kind, { externalId: r.external_id, title: r.title, type: r.item_type });
    const bits = [r.state, r.assignee ? `assigned to ${r.assignee}` : "unassigned", r.due_on ? `due ${r.due_on}` : null, r.blocked_by ? `blocked by ${r.blocked_by}` : null, r.changed_at ? `changed ${r.changed_at.slice(0, 10)}` : null];
    return `- "${title}": ${bits.filter(Boolean).join(" · ")}`;
  });
}
