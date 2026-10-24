/**
 * @file Asking for a tool: the request side of connector permissions (approve → link → request).
 *
 * Concepts
 * - **Approved tool**: a tool the Org Owner turned on for the organization on the Connectors page (its one-time
 *   sign-in done, lib/connectors.ts `startConnect`/`finishConnect`). Only the **Org Owner** turns tools on or off;
 *   Org Admins do everything else (reconnect an expired sign-in, link projects to any group, see requests).
 * - **Request** (`connector_requests`): a Team Lead (for a group they belong to) or an Org Admin (for any group)
 *   asks the Org Owner to turn a tool on, with an optional reason. At most one **pending** request per tool and
 *   group (a unique index backs the check). Statuses: pending → approved (the tool was turned on: by approving
 *   it, or by the Org Owner turning the tool on directly) | declined (with an optional note) | cancelled (by the
 *   person who asked, or by the Org Owner). Requests for a tool already on are refused ("link it instead").
 * - **Plan limits**: a plan without connectors (Starter) can't ask (the plan's upgrade message); a plan that is
 *   full may ask, and approving shows the upgrade message when turning the tool on (lib/limits.ts).
 * - **Telling people**: every change refreshes the "connector_request" watcher at once (lib/watchers.ts
 *   `runWatcherNow`), so a pending request is a "Needs attention" finding on the Org Owner's Home, and the group's
 *   managers see an approval ("link it") or a decline (with the note) there for a week. When Teams is set up and the
 *   person has a 1:1 chat with Sidekick, they also get a short Teams message (best effort; a failed post is
 *   recorded for the failed-posts watcher, never thrown).
 *
 * Walls: every query is scoped to the organization; asking goes through `requireManage` (the group must be one the
 * person manages); a request of another organization answers 404. Everything is audited and traced (kind
 * "connector", counts only, never the reason text).
 */
import "server-only";
import { all, get, newId, now, run, tx } from "./db";
import { audit, HttpError, isAdmin, isLead, requireManage, workspaceIdsFor, type User } from "./auth";
import { span, spanAttrs } from "./trace";
import { assertCanAdd, orgPlan } from "./limits";
import { runWatcherNow } from "./watchers";
import { BRAND } from "./brand";
import { CONNECTOR_KINDS, KIND_LABEL, type ConnectorKind } from "./connector-text";

/** Longest reason or note kept, in characters. */
export const REQUEST_TEXT_MAX = 500;

/** A request as the Connectors page shows it. `mine`: the viewer asked. `canDecide`: the viewer is an Org Owner. */
export type ConnectorRequest = {
  id: string; kind: ConnectorKind; label: string; workspaceId: string; workspaceName: string; requestedBy: string; reason: string | null;
  status: "pending" | "approved" | "declined" | "cancelled"; decidedBy: string | null; decidedAt: string | null; note: string | null;
  createdAt: string; mine: boolean; canDecide: boolean;
};

type Row = {
  id: string; org_id: string; kind: ConnectorKind; workspace_id: string; requested_by: string; requester_name: string; reason: string | null;
  status: ConnectorRequest["status"]; decided_by: string | null; decided_at: string | null; note: string | null; created_at: string; workspace_name: string;
};

const isOwner = (u: User) => u.role === "Org Owner";
const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, REQUEST_TEXT_MAX) : null);

function kindOf(value: unknown): ConnectorKind {
  if (typeof value === "string" && (CONNECTOR_KINDS as readonly string[]).includes(value)) return value as ConnectorKind;
  throw new HttpError(400, `Pick a tool: ${CONNECTOR_KINDS.join(", ")}.`);
}

const SELECT = `SELECT r.*, w.name AS workspace_name FROM connector_requests r JOIN workspaces w ON w.id = r.workspace_id AND w.org_id = r.org_id`;

const toView = (r: Row, user: User): ConnectorRequest => ({
  id: r.id, kind: r.kind, label: KIND_LABEL[r.kind] ?? r.kind, workspaceId: r.workspace_id, workspaceName: r.workspace_name, requestedBy: r.requester_name,
  reason: r.reason, status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at, note: r.note, createdAt: r.created_at,
  mine: r.requested_by === user.id, canDecide: isOwner(user) && r.status === "pending",
});

/**
 * The requests this person may see, newest first: Org Owners and Org Admins every request in the organization
 * (pending ones, plus the last 30 days of decided ones); Team Leads the requests of the groups they belong to;
 * everyone else none (they can't ask).
 */
export async function requestsFor(user: User): Promise<ConnectorRequest[]> {
  if (!isAdmin(user) && !isLead(user)) return [];
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const rows = await all<Row>(`${SELECT} WHERE r.org_id = ? AND (r.status = 'pending' OR r.updated_at >= ?) ORDER BY r.created_at DESC LIMIT 200`, user.org_id, since);
  if (isAdmin(user)) return rows.map((r) => toView(r, user));
  const mine = new Set(await workspaceIdsFor(user));
  return rows.filter((r) => mine.has(r.workspace_id)).map((r) => toView(r, user));
}

/** The organization's request, or 404 (also for another organization's id). */
async function ownRequest(user: User, id: unknown): Promise<Row> {
  const r = typeof id === "string" ? await get<Row>(`${SELECT} WHERE r.id = ? AND r.org_id = ?`, id, user.org_id) : undefined;
  if (!r) throw new HttpError(404, "That request isn't there any more.");
  return r;
}

/**
 * Asks the Org Owner to turn a tool on for one group (Team Leads for their groups, Org Admins for any group:
 * `requireManage`). Refused when the tool is already on (409: link it instead), when the group already has a
 * pending request for it (409), and on a plan without connectors (402, the plan's upgrade message). The Org
 * Owners hear about it on Home (a finding) and in Teams. Audited. Returns the request.
 */
export async function createRequest(user: User, body: { kind?: unknown; ws?: unknown; reason?: unknown }): Promise<ConnectorRequest> {
  const ws = await requireManage(user, typeof body.ws === "string" ? body.ws : null);
  const kind = kindOf(body.kind);
  const label = KIND_LABEL[kind];
  return span("connector", "Request a connector", async () => {
    if (await get("SELECT id FROM connectors WHERE org_id = ? AND kind = ?", user.org_id, kind)) {
      throw new HttpError(409, `${label} is already on for your organization: link a project to your group instead.`);
    }
    if ((await orgPlan(user.org_id)).limits.connectors === 0) await assertCanAdd(user.org_id, "connectors"); // throws the plan's message
    if (await get("SELECT id FROM connector_requests WHERE org_id = ? AND kind = ? AND workspace_id = ? AND status = 'pending'", user.org_id, kind, ws)) {
      throw new HttpError(409, `There's already a request for ${label} for this group, waiting for the Org Owner.`);
    }
    const id = newId();
    const t = now();
    try {
      await run(
        "INSERT INTO connector_requests (id, org_id, kind, workspace_id, requested_by, requester_name, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
        id, user.org_id, kind, ws, user.id, user.name, clean(body.reason), t, t,
      );
    } catch (e) {
      // Two clicks at once: the unique index on pending requests keeps one. Anything else is a real error.
      if (await get("SELECT id FROM connector_requests WHERE org_id = ? AND kind = ? AND workspace_id = ? AND status = 'pending'", user.org_id, kind, ws)) {
        throw new HttpError(409, `There's already a request for ${label} for this group, waiting for the Org Owner.`);
      }
      throw e;
    }
    spanAttrs({ kind, reason: Boolean(clean(body.reason)) });
    const r = await ownRequest(user, id);
    await audit(user, `Asked the Org Owner to turn on ${label} for this group`, "Connectors", ws);
    await runWatcherNow(user.org_id, "connector_request");
    await tellInTeams(user.org_id, await ownerIds(user.org_id), `${user.name} asks to use ${label}`,
      `${user.name} asked to turn on ${label} (read-only) for “${r.workspace_name}”.${r.reason ? ` Why: “${r.reason}”` : ""} Approve or decline it on the Connectors page in ${BRAND.name}.`);
    return toView(r, user);
  });
}

/**
 * Org Owner: approves a pending request. When the tool is already on, the request (and any other pending one for
 * the same tool) is approved at once. Otherwise nothing changes yet: the answer is the address of the tool's
 * one-time sign-in (`signIn`, with `site` for Azure DevOps or an Atlassian site), and the request is approved
 * when that sign-in finishes (lib/connectors.ts `finishConnect` → `approveOpenRequests`). The plan's connector
 * limit is checked first (402 with the upgrade message).
 */
export async function approveRequest(user: User, id: unknown, site: unknown): Promise<{ approved: boolean; signIn?: string }> {
  if (!isOwner(user)) throw new HttpError(403, "Only the Org Owner approves tools for the organization.");
  const r = await ownRequest(user, id);
  if (r.status !== "pending") throw new HttpError(409, `This request was already ${r.status}.`);
  const on = await get<{ id: string }>("SELECT id FROM connectors WHERE org_id = ? AND kind = ?", user.org_id, r.kind);
  if (on) {
    await approveOpenRequests(user.org_id, r.kind, user.name);
    return { approved: true };
  }
  await assertCanAdd(user.org_id, "connectors");
  const q = new URLSearchParams({ kind: r.kind });
  const s = typeof site === "string" ? site.trim().slice(0, 200) : "";
  if (s) q.set("site", s);
  return { approved: false, signIn: `/api/connectors/start?${q}` };
}

/**
 * Marks every pending request for a tool approved (the tool was just turned on: by approving a request, or by the
 * Org Owner turning it on directly), tells the people who asked (Home and Teams), and audits each. Called by
 * lib/connectors.ts after a new connection. System use: the caller already checked who may turn tools on.
 * @returns how many requests were approved
 */
export async function approveOpenRequests(orgId: string, kind: ConnectorKind, by: string): Promise<number> {
  const open = await all<Row>(`${SELECT} WHERE r.org_id = ? AND r.kind = ? AND r.status = 'pending'`, orgId, kind);
  if (!open.length) return 0;
  const t = now();
  await tx(async () => {
    for (const r of open) await run("UPDATE connector_requests SET status = 'approved', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status = 'pending'", by, t, t, r.id, orgId);
  });
  for (const r of open) {
    await audit({ org_id: orgId, name: by }, `Approved ${r.requester_name}'s request to use ${KIND_LABEL[kind]}`, "Connectors", r.workspace_id);
    await tellInTeams(orgId, [r.requested_by], `${KIND_LABEL[kind]} was approved`,
      `${by} approved your request: ${KIND_LABEL[kind]} is on for your organization. Link a project to “${r.workspace_name}” on the Connectors page in ${BRAND.name}.`);
  }
  await runWatcherNow(orgId, "connector_request");
  return open.length;
}

/**
 * Org Owner: declines a pending request with an optional note the person who asked sees (Home, Connectors page,
 * Teams). Audited (without the note's text).
 */
export async function declineRequest(user: User, id: unknown, note: unknown): Promise<ConnectorRequest> {
  if (!isOwner(user)) throw new HttpError(403, "Only the Org Owner approves or declines tools for the organization.");
  const r = await ownRequest(user, id);
  if (r.status !== "pending") throw new HttpError(409, `This request was already ${r.status}.`);
  return span("connector", "Decline a connector request", async () => {
    const t = now();
    const text = clean(note);
    await run("UPDATE connector_requests SET status = 'declined', decided_by = ?, decided_at = ?, note = ?, updated_at = ? WHERE id = ? AND org_id = ?", user.name, t, text, t, r.id, user.org_id);
    spanAttrs({ kind: r.kind, note: Boolean(text) });
    await audit(user, `Declined ${r.requester_name}'s request to use ${KIND_LABEL[r.kind]}${text ? " (with a note)" : ""}`, "Connectors", r.workspace_id);
    await runWatcherNow(user.org_id, "connector_request");
    await tellInTeams(user.org_id, [r.requested_by], `Your ${KIND_LABEL[r.kind]} request was declined`,
      `${user.name} declined turning on ${KIND_LABEL[r.kind]} for “${r.workspace_name}”.${text ? ` Note: “${text}”` : ""}`);
    return toView((await ownRequest(user, r.id)), user);
  });
}

/** Cancels a pending request: the person who asked it, or an Org Owner. Audited. */
export async function cancelRequest(user: User, id: unknown): Promise<ConnectorRequest> {
  const r = await ownRequest(user, id);
  if (r.requested_by !== user.id && !isOwner(user)) {
    // Someone who can't even see it gets the same answer as for another organization's id.
    if (!isAdmin(user) && !(await workspaceIdsFor(user)).includes(r.workspace_id)) throw new HttpError(404, "That request isn't there any more.");
    throw new HttpError(403, "Only the person who asked (or the Org Owner) can cancel this request.");
  }
  if (r.status !== "pending") throw new HttpError(409, `This request was already ${r.status}.`);
  const t = now();
  await run("UPDATE connector_requests SET status = 'cancelled', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND org_id = ?", user.name, t, t, r.id, user.org_id);
  await audit(user, `Cancelled the request to use ${KIND_LABEL[r.kind]}`, "Connectors", r.workspace_id);
  await runWatcherNow(user.org_id, "connector_request");
  return toView((await ownRequest(user, r.id)), user);
}

/** The organization's Org Owners (who approve requests). */
async function ownerIds(orgId: string): Promise<string[]> {
  return (await all<{ id: string }>("SELECT id FROM users WHERE org_id = ? AND role = 'Org Owner'", orgId)).map((u) => u.id);
}

/**
 * Sends a short Teams message to each person's 1:1 chat with Sidekick, when Teams is set up for the organization
 * (its Microsoft tenant linked) and the person's Microsoft account has a 1:1 chat with Sidekick there. Best effort:
 * a person without one is skipped, and a failed post is logged and recorded (lib/teams/bot.ts `postCard`), never
 * thrown, so a request never fails because Teams is down.
 */
async function tellInTeams(orgId: string, userIds: string[], title: string, body: string): Promise<void> {
  if (!userIds.length) return;
  try {
    const org = await get<{ t: string | null }>("SELECT entra_tenant_id AS t FROM orgs WHERE id = ?", orgId);
    if (!org?.t) return;
    const chats = await all<{ id: string; service_url: string }>(
      `SELECT c.id, c.service_url FROM teams_conversations c JOIN users u ON u.entra_oid = c.added_by_oid AND u.org_id = ?
        WHERE c.kind = 'personal' AND c.tenant_id = ? AND c.removed_at IS NULL AND u.id IN (${userIds.map(() => "?").join(", ")})`,
      orgId, org.t, ...userIds,
    );
    if (!chats.length) return;
    const [{ postCard }, { noticeCard }] = await Promise.all([import("./teams/bot"), import("./teams/cards")]);
    for (const c of chats) await postCard(c, noticeCard(title, body), c.id, "a connector request notice").catch((e) => console.error(`Couldn't send the connector request notice to Teams chat ${c.id}`, e));
  } catch (e) {
    console.error("Couldn't send the connector request notice in Teams", e);
  }
}
