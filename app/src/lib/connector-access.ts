/**
 * @file "Each person signs in" for connectors: which connector items the people reading an answer may see, and each
 * person's own sign-ins. The design (and why it's a question-time check) is in docs/ARCHITECTURE.md → Connectors.
 *
 * Concepts
 * - **Readers**: who will read the answer. In the portal and a 1:1 Teams chat, the asker (`{ kind: "person" }`). In a
 *   Teams group chat or channel, everyone in it (`{ kind: "chat" }`): the Sidekick people of the group matched from
 *   the chat's roster, plus a count of people who couldn't be matched (client guests, people who never signed in to
 *   Sidekick with Microsoft) or `unknown: true` when the roster couldn't be read.
 * - **Screening** (`screenConnectorSources`): before ranking, every candidate passage from a connection in
 *   **personal** mode (lib/connectors.ts `access_mode`) is checked with each reader's own token
 *   (`Provider.personal.canOpen`, one call per tool and reader). An item stays only if **every** reader can open
 *   it. Items the tool shows to anyone at all (`Provider.personal.openToAll`: GitHub issues in public repositories,
 *   asked with the connection's own token) skip that check. Anything uncertain is left out (fail closed): a reader who hasn't connected, an expired sign-in, an
 *   unmatched person in the chat, a tool that's down or slower than `CHECK_TIMEOUT_MS`. Shared-mode connections
 *   and all other sources pass untouched.
 * - **Notes** (`AccessNote`): when a personal connection had relevant items that were left out, the answer says
 *   why and how to fix it ("Connect your Jira to include its tickets"), once per connection. No item names: the
 *   note only says that something was left out.
 * - **Cache**: each check result (open or closed) is kept in memory for `ACCESS_CACHE_SECONDS` per sign-in row,
 *   its connect time and item, so follow-ups don't call the tool again; reconnecting starts afresh. Per app copy.
 * - **My sign-ins** (`mySignIns`, `disconnectMine`): the personal connections of the groups a person is in, and
 *   whether they've connected (Knowledge page, Connectors page, GET /api/connectors/mine).
 *
 * Walls: everything is scoped to the organization; a reader's token is only used for the connection's own group, and
 * only for readers who passed that group's wall (the asker through `requireWorkspace`, chat readers by being
 * matched to the group's members). Sign-ins of people who left the group are deleted (`pruneLeftSignIns`). Tokens never leave the server; traces carry counts.
 */
import "server-only";
import { all, get, now, run } from "./db";
import { audit, HttpError, requireWorkspace, workspaceIdsFor, type User } from "./auth";
import { span, spanAttrs } from "./trace";
import { connectionApi, personalApi, providerFor, type ConnectorRow, type PersonalTokenRow } from "./connectors";
import { ConnectorError, isPageKind, KIND_LABEL, type ConnectorKind } from "./connector-text";

/** How long one "can this person open this item" answer is reused. */
export const ACCESS_CACHE_SECONDS = 300;
/** A tool that hasn't answered the check within this long counts as "couldn't check": its items are left out. */
export const CHECK_TIMEOUT_MS = 4000;
/** A chat with more people than this isn't checked person by person: personal connections' items are left out. */
export const MAX_CHAT_PEOPLE = 20;

/** Who will read an answer (see the file comment). `userId` null = someone Sidekick doesn't know (a Teams guest). */
export type Readers =
  | { kind: "person"; userId: string | null }
  | { kind: "chat"; userIds: string[]; unmatched: number; unknown?: boolean };

/**
 * Why a personal connection's items were left out of an answer, for the note under it. `connect`: the reader hasn't
 * connected; `reconnect`: their sign-in expired; `chat`: not everyone in the chat could be checked or open them;
 * `unavailable`: the tool didn't answer the check. `connectorId` is what "Connect your …" starts with.
 */
export type AccessNote = { connectorId: string; kind: ConnectorKind; reason: "connect" | "reconnect" | "chat" | "unavailable"; text: string };

/** What a tool's items are called in the notes ("tickets" for Jira, "issues" for GitHub, "pages" for Confluence, "files" for Microsoft 365, "work items" for Azure DevOps). */
const itemsWord = (kind: ConnectorKind) => (kind === "jira" ? "tickets" : kind === "github" ? "issues" : kind === "m365" ? "files" : isPageKind(kind) ? "pages" : "work items");

/** The note's wording for each reason (plain, no item names). */
export function noteText(kind: ConnectorKind, reason: AccessNote["reason"]): string {
  const tool = KIND_LABEL[kind];
  // "Microsoft 365" alone could mean mail or calendars: say which part of it.
  if (reason === "connect" && kind === "m365") return "Connect your Microsoft 365 files to include them in your answers.";
  if (reason === "connect") return `Connect your ${tool} to include its ${itemsWord(kind)} in your answers.`;
  if (reason === "reconnect") return `Your ${tool} sign-in expired. Reconnect it to include its ${itemsWord(kind)} again.`;
  if (reason === "chat") return `${tool} ${itemsWord(kind)} were left out: not everyone in this chat has connected ${tool}, or some people here can't be checked.`;
  return `${tool} didn't confirm who can open its ${itemsWord(kind)} just now, so they were left out. Try again in a minute.`;
}

const cache = new Map<string, { open: boolean; at: number }>();
const cacheKey = (t: Pick<PersonalTokenRow, "id" | "connected_at">, externalId: string) => `${t.id}|${t.connected_at}|${externalId}`;
/** Forgets every cached check (tests and a person disconnecting). */
export function clearAccessCache() {
  cache.clear();
}
function cached(t: Pick<PersonalTokenRow, "id" | "connected_at">, externalId: string, at: number): boolean | undefined {
  const hit = cache.get(cacheKey(t, externalId));
  if (!hit) return undefined;
  if (at - hit.at > ACCESS_CACHE_SECONDS * 1000) {
    cache.delete(cacheKey(t, externalId));
    return undefined;
  }
  return hit.open;
}
function remember(t: Pick<PersonalTokenRow, "id" | "connected_at">, externalId: string, open: boolean, at: number) {
  if (cache.size > 50_000) cache.clear(); // a crude cap: the cache is only a speed-up
  cache.set(cacheKey(t, externalId), { open, at });
}

const timeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new ConnectorError("busy", "timed out")), ms))]);

/** A candidate passage's item: `project` is its link's key (Microsoft 365: the drive a file id belongs to). */
type OpenToAll = NonNullable<NonNullable<ReturnType<typeof providerFor>["personal"]>["openToAll"]>;

/**
 * Which of a personal connection's candidate items anyone may open (`Provider.personal.openToAll`, asked with the
 * connection's own token; cached like the per-person answers, per connection). Anything uncertain (the tool didn't
 * answer in time, the connection's own sign-in expired) counts as not open to all, so the per-person check decides.
 */
async function openToAll(conn: ConnectorRow, check: OpenToAll, list: CandidateItem[], at: number): Promise<Set<string>> {
  const key = { id: `all:${conn.id}`, connected_at: conn.connected_at };
  const out = new Set(list.map((it) => it.external_id).filter((x) => cached(key, x, at) === true));
  const ask = list.map((it) => it.external_id).filter((x) => cached(key, x, at) === undefined);
  if (!ask.length) return out;
  try {
    const yes = await timeout(check(connectionApi(conn), conn, ask, new Map(list.map((it) => [it.external_id, it.project]))), CHECK_TIMEOUT_MS);
    for (const x of ask) {
      remember(key, x, yes.has(x), at);
      if (yes.has(x)) out.add(x);
    }
  } catch (e) {
    if (!(e instanceof ConnectorError)) console.error("Connector open-to-all check failed", e);
  }
  return out;
}

type CandidateItem = { id: string; external_id: string; connector_id: string; kind: ConnectorKind; project: string };

/**
 * Which candidate sources the readers may **not** see, and the notes explaining it (see the file comment). Only
 * sources of type `workitem` / `page` from personal-mode connections of this group are looked at; everything else
 * passes. Traced (kind "connector": counts only).
 *
 * @param candidates the passages search found (their `source_id` and `source_type`)
 * @returns `drop` (source ids to leave out) and `notes` (one per personal connection that lost items)
 */
export async function screenConnectorSources(
  orgId: string, workspaceId: string, readers: Readers, candidates: { source_id: string; source_type: string }[],
): Promise<{ drop: Set<string>; notes: AccessNote[] }> {
  const ids = [...new Set(candidates.filter((c) => c.source_type === "workitem" || c.source_type === "page").map((c) => c.source_id))];
  const drop = new Set<string>();
  const notes: AccessNote[] = [];
  if (!ids.length) return { drop, notes };
  const items: CandidateItem[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    items.push(...await all<CandidateItem>(
      `SELECT i.id, i.external_id, c.id AS connector_id, c.kind, l.project FROM connector_items i
         JOIN connector_links l ON l.id = i.link_id AND l.org_id = i.org_id JOIN connectors c ON c.id = l.connector_id AND c.org_id = l.org_id
        WHERE i.org_id = ? AND i.workspace_id = ? AND c.workspace_id = ? AND c.access_mode = 'personal' AND i.id IN (${part.map(() => "?").join(", ")})`,
      orgId, workspaceId, workspaceId, ...part,
    ));
  }
  if (!items.length) return { drop, notes };
  return span("connector", "Check who can open the cited items", async () => {
    const at = Date.now();
    let checked = 0, fromCache = 0, openToAllCount = 0;
    const byConn = new Map<string, CandidateItem[]>();
    for (const it of items) byConn.set(it.connector_id, [...(byConn.get(it.connector_id) ?? []), it]);
    const people = readers.kind === "person" ? (readers.userId ? [readers.userId] : []) : readers.userIds;
    // A reader Sidekick doesn't know, an unreadable roster or a crowded chat: nobody can vouch for them.
    const unvouched = readers.kind === "person" ? !readers.userId : Boolean(readers.unknown) || readers.unmatched > 0 || readers.userIds.length > MAX_CHAT_PEOPLE || !readers.userIds.length;
    for (const [connectorId, all0] of byConn) {
      const kind = all0[0].kind;
      const conn = await get<ConnectorRow>("SELECT * FROM connectors WHERE id = ? AND org_id = ? AND workspace_id = ?", connectorId, orgId, workspaceId);
      const p = providerFor(kind).personal;
      // Items anyone may open (GitHub: public repositories) need nobody's sign-in; the rest are checked per person.
      const pub = conn && p?.openToAll ? await openToAll(conn, p.openToAll, all0, at) : new Set<string>();
      openToAllCount += pub.size;
      const list = all0.filter((it) => !pub.has(it.external_id));
      if (!list.length) continue;
      const leaveOut = (reason: AccessNote["reason"]) => {
        for (const it of list) drop.add(it.id);
        notes.push({ connectorId, kind, reason, text: noteText(kind, reason) });
      };
      if (unvouched) {
        leaveOut(readers.kind === "chat" ? "chat" : "connect");
        continue;
      }
      // The readers already passed the group's wall (the asker: requireWorkspace; a chat: matched to the group's members).
      const tokens = await all<PersonalTokenRow>(
        `SELECT t.* FROM connector_user_tokens t WHERE t.org_id = ? AND t.connector_id = ? AND t.user_id IN (${people.map(() => "?").join(", ")})`,
        orgId, connectorId, ...people,
      );
      const missing = people.filter((p) => !tokens.some((t) => t.user_id === p && t.status === "connected"));
      if (missing.length) {
        const expired = readers.kind === "person" && tokens.some((t) => t.status === "expired");
        leaveOut(readers.kind === "chat" ? "chat" : expired ? "reconnect" : "connect");
        continue;
      }
      if (!conn || !p) {
        leaveOut("unavailable");
        continue;
      }
      // Each reader's answer, from the cache or one call to the tool; an item stays only if everyone can open it.
      let open = new Set(list.map((it) => it.external_id));
      const where = new Map(list.map((it) => [it.external_id, it.project]));
      let failed: AccessNote["reason"] | null = null;
      for (const t of tokens) {
        const ask = list.map((it) => it.external_id).filter((x) => open.has(x) && cached(t, x, at) === undefined);
        const theirs = new Set(list.map((it) => it.external_id).filter((x) => cached(t, x, at) === true));
        fromCache += list.length - ask.length;
        if (ask.length) {
          try {
            const yes = await timeout(p.canOpen(personalApi(t, kind), conn, ask, where), CHECK_TIMEOUT_MS);
            checked += ask.length;
            for (const x of ask) {
              remember(t, x, yes.has(x), at);
              if (yes.has(x)) theirs.add(x);
            }
            await run("UPDATE connector_user_tokens SET last_used_at = ? WHERE id = ? AND org_id = ?", now(), t.id, orgId);
          } catch (e) {
            // An expired sign-in was marked by personalApi; anything else: the tool couldn't say, so nothing is shown.
            const expiredNow = e instanceof ConnectorError && e.reason === "auth" && (await get<{ status: string }>("SELECT status FROM connector_user_tokens WHERE id = ? AND org_id = ?", t.id, orgId))?.status === "expired";
            failed = readers.kind === "chat" ? "chat" : expiredNow ? "reconnect" : "unavailable";
            if (!(e instanceof ConnectorError)) console.error("Connector access check failed", e);
            break;
          }
        }
        open = new Set([...open].filter((x) => theirs.has(x)));
      }
      if (failed) {
        leaveOut(failed);
        continue;
      }
      const closed = list.filter((it) => !open.has(it.external_id));
      for (const it of closed) drop.add(it.id);
      // Some items closed for one of several chat readers: the chat hears that not everything could be used.
      if (closed.length && readers.kind === "chat") notes.push({ connectorId, kind, reason: "chat", text: noteText(kind, "chat") });
    }
    spanAttrs({ candidates: items.length, connections: byConn.size, readers: readers.kind === "person" ? 1 : readers.userIds.length + readers.unmatched, checked, fromCache, openToAll: openToAllCount, dropped: drop.size, notes: notes.length });
    return { drop, notes };
  });
}

/** One personal-mode connection a person can sign in to, and whether they have. */
export type MySignIn = {
  connectorId: string; kind: ConnectorKind; label: string; workspaceId: string; workspaceName: string;
  status: "none" | "connected" | "expired"; accountName: string | null; connectedAt: string | null; problem: string | null;
};

/**
 * The "each person signs in" connections of the groups the person can see (`ws` limits it to one, checked with
 * `requireWorkspace`), with their own status. Anyone signed in may call it for themselves (GET /api/connectors/mine).
 */
export async function mySignIns(user: User, ws?: string | null): Promise<MySignIn[]> {
  const groups = ws ? [await requireWorkspace(user, ws)] : await workspaceIdsFor(user);
  if (!groups.length) return [];
  const rows = await all<{ id: string; kind: ConnectorKind; workspace_id: string; workspace_name: string; status: string | null; account_name: string | null; connected_at: string | null; last_error: string | null }>(
    `SELECT c.id, c.kind, c.workspace_id, w.name AS workspace_name, t.status, t.account_name, t.connected_at, t.last_error
       FROM connectors c JOIN workspaces w ON w.id = c.workspace_id AND w.org_id = c.org_id
       LEFT JOIN connector_user_tokens t ON t.connector_id = c.id AND t.org_id = c.org_id AND t.user_id = ?
      WHERE c.org_id = ? AND c.access_mode = 'personal' AND c.workspace_id IN (${groups.map(() => "?").join(", ")})
      ORDER BY w.name, c.kind`,
    user.id, user.org_id, ...groups,
  );
  return rows.map((r) => ({
    connectorId: r.id, kind: r.kind, label: r.kind === "m365" ? "Microsoft 365 files" : KIND_LABEL[r.kind], workspaceId: r.workspace_id, workspaceName: r.workspace_name,
    status: r.status === "connected" ? "connected" : r.status === "expired" ? "expired" : "none", accountName: r.account_name, connectedAt: r.connected_at,
    problem: r.status === "expired" ? r.last_error : null,
  }));
}

/**
 * Removes the person's **own** sign-in to one connection (their tokens). Only their own row can be removed; another
 * organization's or group's connection answers 404. Audited in the group.
 */
export async function disconnectMine(user: User, connectorId: unknown): Promise<{ removed: boolean }> {
  const c = typeof connectorId === "string" ? await get<{ id: string; kind: ConnectorKind; workspace_id: string }>("SELECT id, kind, workspace_id FROM connectors WHERE id = ? AND org_id = ?", connectorId, user.org_id) : undefined;
  if (!c) throw new HttpError(404, "Connector not found.");
  await requireWorkspace(user, c.workspace_id).catch(() => { throw new HttpError(404, "Connector not found."); });
  const r = await run("DELETE FROM connector_user_tokens WHERE connector_id = ? AND user_id = ? AND org_id = ?", c.id, user.id, user.org_id);
  if (r.changes) await audit(user, `Disconnected their own ${KIND_LABEL[c.kind]} sign-in from this group`, "Connectors", c.workspace_id);
  return { removed: r.changes > 0 };
}

/**
 * Deletes the personal sign-ins of people who are no longer in the group they were for (left it, or were removed;
 * Org Owners and Admins see every group, so theirs stay while they keep that role).
 * Called from the watcher run (lib/watchers.ts), so a removal anywhere is cleaned up within one run. Returns how many.
 */
export async function pruneLeftSignIns(orgId: string): Promise<number> {
  return (await run(
    `DELETE FROM connector_user_tokens WHERE org_id = ?
        AND NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = connector_user_tokens.workspace_id AND wm.user_id = connector_user_tokens.user_id)
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = connector_user_tokens.user_id AND u.org_id = connector_user_tokens.org_id AND u.role IN ('Org Owner', 'Org Admin'))`,
    orgId,
  )).changes;
}

/**
 * Personal-mode connections with expired personal sign-ins of current members, per connection (for the watcher
 * `connector_signins`: a finding for the group's managers with the names).
 */
export async function expiredSignIns(orgId: string): Promise<{ connectorId: string; kind: ConnectorKind; workspaceId: string; names: string[]; since: string }[]> {
  const rows = await all<{ connector_id: string; kind: ConnectorKind; workspace_id: string; name: string; at: string }>(
    `SELECT t.connector_id, c.kind, t.workspace_id, u.name, COALESCE(t.last_error_at, t.updated_at) AS at FROM connector_user_tokens t
       JOIN connectors c ON c.id = t.connector_id AND c.org_id = t.org_id JOIN users u ON u.id = t.user_id AND u.org_id = t.org_id
      WHERE t.org_id = ? AND t.status = 'expired' AND c.access_mode = 'personal'
        AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = t.workspace_id AND wm.user_id = t.user_id)
      ORDER BY u.name`,
    orgId,
  );
  const out = new Map<string, { connectorId: string; kind: ConnectorKind; workspaceId: string; names: string[]; since: string }>();
  for (const r of rows) {
    const cur = out.get(r.connector_id) ?? { connectorId: r.connector_id, kind: r.kind, workspaceId: r.workspace_id, names: [], since: r.at };
    cur.names.push(r.name);
    if (r.at < cur.since) cur.since = r.at;
    out.set(r.connector_id, cur);
  }
  return [...out.values()];
}
