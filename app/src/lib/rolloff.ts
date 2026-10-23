/**
 * @file Roll-off: what happens to a client's data when an engagement ends (one group) or a company leaves
 * (the whole organization). Scheduling, cancelling, the scheduled deletion and the deletion certificate.
 *
 * Concepts
 * - **Group roll-off** ("Ending"): an Org Owner/Admin sets a group to end on a date (default
 *   `GROUP_DEFAULT_DAYS`, at least `MIN_GROUP_DAYS`). From then on the group is read-only
 *   (`requireWorkspace` in lib/auth.ts refuses changes), doesn't count toward the group limit
 *   (`NOT_ENDING` in lib/billing.ts), and its Teams chats are told and unlinked (Sidekick stops answering
 *   there). Admins can download everything (lib/export.ts) and cancel until the date; cancelling relinks
 *   the chats that are still free. On the date the group is deleted with `deleteWorkspace`
 *   (lib/workspaces.ts, search entries included).
 * - **Organization roll-off**: when a plan is canceled (lib/billing.ts `cancel`) or the Sidekick team
 *   ends a client (Owner Console). The organization stays usable until `read_only_from` (the end of what
 *   was paid for), then is read-only for the grace period with a banner and export (`withRolloff` in
 *   lib/plans.ts), then everything is deleted (`deleteOrganization`). Paying again stops it.
 * - **Deletion certificate**: written when the data is deleted: which kinds of data and how many of each,
 *   when, who asked and who ran it, and that database backups age out within `BACKUP_RETENTION_DAYS`. It
 *   never holds content (no document text, names of people, questions or messages): only counts, dates,
 *   the organization's and group's names. Kept in `rolloffs.certificate_json` and, for a group, as an entry
 *   in the organization's audit log; downloadable as text or PDF (`certificateText`, `certificatePdf`).
 * - **What's kept after an organization is deleted**: only its `rolloffs` row (organization name, dates,
 *   who asked, the certificate's counts) and the operator log line. Everything with the organization's
 *   id is gone, including its subscription, usage records and its own audit log. Proof of the deletion and
 *   billing history live in that row (and, with a real provider, in Stripe's own records).
 * - **Scheduled job**: `runDueRolloffs` runs on the job queue (lib/job-kinds.ts `rolloffs.run`, every 5
 *   minutes). Each roll-off is claimed with a conditional update first (status scheduled → running), so two
 *   copies of the app never run the same one. A failure puts it back to scheduled with the error, shown in
 *   the Owner Console, and it's tried again on the next run.
 *
 * Callers: /api/workspaces/:id/rolloff, /api/workspaces/:id (delete now), lib/billing.ts, the Owner Console
 * routes under /api/owner/rolloffs and /api/owner/tenants/:id/rolloff, and the job queue.
 */
import "server-only";
import crypto from "node:crypto";
import { audit, HttpError, type User } from "./auth";
import { all, get, newId, now, run, tx } from "./db";
import { deleteWorkspace } from "./workspaces";
import { FIRM_SCOPE, removeFirmIndex } from "./search";
import { platformLog } from "./owner";
import { span } from "./trace";
import { textPdf } from "./pdf";
import { BRAND } from "./brand";
import type { TeamsConversation } from "./teams/bot";

import { BACKUP_RETENTION_DAYS, GROUP_DEFAULT_DAYS, MAX_ROLLOFF_DAYS, MIN_GROUP_DAYS } from "./rolloff-policy";
export { BACKUP_RETENTION_DAYS, GROUP_DEFAULT_DAYS, MAX_ROLLOFF_DAYS, MIN_GROUP_DAYS, ORG_GRACE_DAYS } from "./rolloff-policy";

/** One roll-off row. Dates are ISO strings. */
export type Rolloff = {
  id: string;
  org_id: string;
  org_name: string;
  workspace_id: string | null;
  workspace_name: string | null;
  scope: "group" | "org";
  status: "scheduled" | "running" | "canceled" | "done";
  reason: string | null;
  read_only_from: string | null;
  delete_on: string;
  requested_by: string;
  created_at: string;
  chats_json: string | null;
  closed_by: string | null;
  closed_at: string | null;
  certificate_json: string | null;
  error: string | null;
};

/** What a deletion certificate says. Counts only: never content. */
export type Certificate = {
  id: string;
  scope: "group" | "org";
  organization: string;
  group: string | null;
  requestedBy: string;
  requestedAt: string;
  reason: string | null;
  deletedAt: string;
  deletedBy: string;
  /** Kind of data → how many were deleted, in plain words ("Documents": 12). */
  counts: Record<string, number>;
  /** Plain sentences on what was kept and why (no content). */
  kept: string[];
  backups: string;
};

const PENDING = "('scheduled', 'running')";
const inDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString();
/** "Nov 20, 2026" */
export const dateText = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const certificateId = () => {
  const c = Array.from(crypto.randomBytes(8), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
  return `DEL-${c.slice(0, 4)}-${c.slice(4)}`;
};

/** Checks a number of days for a group's deletion date: a whole number from `MIN_GROUP_DAYS` to `MAX_ROLLOFF_DAYS`. */
export function requireDays(days: unknown, min = MIN_GROUP_DAYS): number {
  if (days === undefined || days === null) return GROUP_DEFAULT_DAYS;
  if (typeof days !== "number" || !Number.isInteger(days) || days < min || days > MAX_ROLLOFF_DAYS) {
    throw new HttpError(400, `Pick a deletion date ${min} to ${MAX_ROLLOFF_DAYS} days from today.`);
  }
  return days;
}

/** The group's pending roll-off (ending), or null. Scoped to the organization. */
export async function groupRolloff(orgId: string, workspaceId: string): Promise<Rolloff | null> {
  return (await get<Rolloff>(`SELECT * FROM rolloffs WHERE org_id = ? AND workspace_id = ? AND scope = 'group' AND status IN ${PENDING}`, orgId, workspaceId)) ?? null;
}

/** Every pending group roll-off in the organization, by workspace id (for the Groups page). */
export async function endingGroups(orgId: string): Promise<Map<string, Rolloff>> {
  const rows = await all<Rolloff>(`SELECT * FROM rolloffs WHERE org_id = ? AND scope = 'group' AND status IN ${PENDING}`, orgId);
  return new Map(rows.map((r) => [r.workspace_id!, r]));
}

/** Posts a short notice in each chat (best effort: Teams being down never stops a roll-off). */
async function tellChats(chats: Pick<TeamsConversation, "id" | "service_url">[], title: string, body: string) {
  if (!chats.length) return;
  const [{ postCard }, { noticeCard }] = await Promise.all([import("./teams/bot"), import("./teams/cards")]);
  for (const c of chats) await postCard(c, noticeCard(title, body)).catch((e) => console.error(`Couldn't post the roll-off notice in Teams chat ${c.id}`, e));
}

/**
 * Sets a group to **Ending**: read-only, deleted in `days` days. Its linked Teams chats are told and
 * unlinked (their ids are kept so cancelling can relink them). Org Owners/Admins only (checked by the
 * route, with the workspace wall). Audited. Returns the roll-off.
 */
export async function scheduleGroupRolloff(user: User, workspaceId: string, days: number): Promise<Rolloff> {
  return span("rolloff", "End a group", async () => {
    if (await groupRolloff(user.org_id, workspaceId)) throw new HttpError(409, "This group is already ending. Cancel it first to pick another date.");
    const ws = await get<{ name: string }>("SELECT name FROM workspaces WHERE id = ? AND org_id = ?", workspaceId, user.org_id);
    if (!ws) throw new HttpError(404, "Workspace not found, or you're not a member of it.");
    const org = await get<{ name: string }>("SELECT name FROM orgs WHERE id = ?", user.org_id);
    const chats = await all<TeamsConversation>("SELECT * FROM teams_conversations WHERE workspace_id = ? AND org_id = ?", workspaceId, user.org_id);
    const id = newId();
    const deleteOn = inDays(days);
    await tx(async () => {
      await run(
        `INSERT INTO rolloffs (id, org_id, org_name, workspace_id, workspace_name, scope, status, reason, read_only_from, delete_on, requested_by, created_at, chats_json)
         VALUES (?, ?, ?, ?, ?, 'group', 'scheduled', ?, ?, ?, ?, ?, ?)`,
        id, user.org_id, org?.name ?? "", workspaceId, ws.name, "the engagement ended", now(), deleteOn, user.name, now(), JSON.stringify(chats.map((c) => c.id)),
      );
      // Unlinked, but not "waiting": Sidekick stays in the chat (so cancelling can relink it) until the deletion.
      await run("UPDATE teams_conversations SET org_id = NULL, workspace_id = NULL, linked_by = NULL, linked_at = NULL WHERE workspace_id = ? AND org_id = ?", workspaceId, user.org_id);
    });
    await tellChats(chats, `“${ws.name}” has ended`, `This group's engagement has ended, so I've stopped answering and taking notes here. Everything I kept for it will be deleted on ${dateText(deleteOn)}. Ask your ${BRAND.name} admin if you need anything from it before then.`);
    await audit(user, `Set group “${ws.name}” to end: read-only now, everything deleted on ${dateText(deleteOn)}${chats.length ? `; unlinked ${chats.length} Teams chat${chats.length === 1 ? "" : "s"}` : ""}`, "Data", workspaceId);
    return (await get<Rolloff>("SELECT * FROM rolloffs WHERE id = ?", id))!;
  }, { days });
}

/**
 * Cancels a group's ending: it's a normal group again (and counts toward the group limit again). The Teams
 * chats it had are relinked if nobody linked them elsewhere and Sidekick is still in them. `actor` is the
 * person (Org Owner/Admin) or "Sidekick team" (Owner Console). Audited.
 */
export async function cancelGroupRolloff(actor: Pick<User, "org_id" | "name"> & { id?: string }, workspaceId: string): Promise<{ relinked: number }> {
  return span("rolloff", "Cancel a group's ending", async () => {
    const r = await groupRolloff(actor.org_id, workspaceId);
    if (!r) throw new HttpError(404, "This group isn't ending.");
    if (r.status === "running") throw new HttpError(409, "This group is being deleted right now and can't be kept.");
    const ids = (JSON.parse(r.chats_json ?? "[]") as string[]).filter((x) => typeof x === "string");
    let relinked = 0;
    await tx(async () => {
      const claimed = await run("UPDATE rolloffs SET status = 'canceled', closed_by = ?, closed_at = ? WHERE id = ? AND status = 'scheduled'", actor.name, now(), r.id);
      if (!claimed.changes) throw new HttpError(409, "This group is being deleted right now and can't be kept.");
      for (const id of ids) {
        const done = await run(
          "UPDATE teams_conversations SET org_id = ?, workspace_id = ?, linked_by = ?, linked_at = ?, waiting_since = NULL WHERE id = ? AND workspace_id IS NULL AND leaving IS NULL",
          actor.org_id, workspaceId, actor.id ?? null, now(), id,
        );
        relinked += done.changes;
      }
    });
    const chats = ids.length ? await all<TeamsConversation>(`SELECT * FROM teams_conversations WHERE workspace_id = ? AND org_id = ?`, workspaceId, actor.org_id) : [];
    await tellChats(chats, `“${r.workspace_name}” is back`, "This group's ending was cancelled, so I'm answering and taking notes here again.");
    await audit(actor, `Cancelled the ending of group “${r.workspace_name}”${relinked ? `; relinked ${relinked} Teams chat${relinked === 1 ? "" : "s"}` : ""}`, "Data", workspaceId);
    return { relinked };
  });
}

/**
 * Starts (or moves) the organization's roll-off: read-only from `readOnlyFrom`, everything deleted on
 * `deleteOn`. Called when a plan is canceled (lib/billing.ts) and when the Sidekick team ends a client.
 * Audited in the client's log and the operator log.
 */
export async function scheduleOrgRolloff(orgId: string, opts: { readOnlyFrom: string; deleteOn: string; reason: string; by: string }) {
  const org = await get<{ name: string }>("SELECT name FROM orgs WHERE id = ?", orgId);
  if (!org) throw new HttpError(404, "Client not found.");
  const cur = await get<{ id: string }>(`SELECT id FROM rolloffs WHERE org_id = ? AND scope = 'org' AND status IN ${PENDING}`, orgId);
  if (cur) {
    await run("UPDATE rolloffs SET read_only_from = ?, delete_on = ?, reason = ? WHERE id = ? AND status = 'scheduled'", opts.readOnlyFrom, opts.deleteOn, opts.reason, cur.id);
  } else {
    await run(
      `INSERT INTO rolloffs (id, org_id, org_name, scope, status, reason, read_only_from, delete_on, requested_by, created_at)
       VALUES (?, ?, ?, 'org', 'scheduled', ?, ?, ?, ?, ?)`,
      newId(), orgId, org.name, opts.reason, opts.readOnlyFrom, opts.deleteOn, opts.by, now(),
    );
  }
  await audit({ org_id: orgId, name: opts.by }, `Scheduled the organization's data for deletion on ${dateText(opts.deleteOn)} (read-only from ${dateText(opts.readOnlyFrom)}) because ${opts.reason}`, "Data");
  await platformLog(opts.by, `${org.name}: data scheduled for deletion on ${dateText(opts.deleteOn)} (${opts.reason})`);
}

/**
 * Stops the organization's pending roll-off, if there is one (paid again, or the Sidekick team kept the
 * client). Does nothing otherwise. Audited when something was stopped.
 */
export async function cancelOrgRolloff(orgId: string, by: string, why: string) {
  const r = await run(`UPDATE rolloffs SET status = 'canceled', closed_by = ?, closed_at = ? WHERE org_id = ? AND scope = 'org' AND status = 'scheduled'`, by, now(), orgId);
  if (!r.changes) return;
  await audit({ org_id: orgId, name: by }, `Stopped the scheduled deletion of the organization's data (${why})`, "Data");
  const org = await get<{ name: string }>("SELECT name FROM orgs WHERE id = ?", orgId);
  await platformLog(by, `${org?.name ?? orgId}: scheduled deletion stopped (${why})`);
}

/**
 * The Sidekick team moves a pending roll-off's deletion date (Owner Console → Roll-offs → Extend), to
 * `days` days from today (at least 1). Audited on both sides.
 */
export async function rescheduleRolloff(id: string, days: unknown, ownerName: string): Promise<Rolloff> {
  const n = requireDays(days, 1);
  const r = await get<Rolloff>("SELECT * FROM rolloffs WHERE id = ?", id);
  if (!r || r.status !== "scheduled") throw new HttpError(404, "No scheduled roll-off with that id.");
  const deleteOn = inDays(n);
  await run("UPDATE rolloffs SET delete_on = ?, error = NULL WHERE id = ? AND status = 'scheduled'", deleteOn, id);
  const what = r.scope === "group" ? `group “${r.workspace_name}”` : "the organization's data";
  await audit({ org_id: r.org_id, name: `${BRAND.name} team` }, `Moved the deletion of ${what} to ${dateText(deleteOn)}`, "Data", r.workspace_id);
  await platformLog(ownerName, `${r.org_name}: deletion of ${what} moved to ${dateText(deleteOn)}`);
  return (await get<Rolloff>("SELECT * FROM rolloffs WHERE id = ?", id))!;
}

/**
 * The Sidekick team brings a pending roll-off forward to **now** (Owner Console → Roll-offs → Delete now),
 * e.g. when a client asks for prompt deletion: the timer deletes it on its next run (within 5 minutes).
 * Audited on both sides.
 */
export async function deleteSoon(id: string, ownerName: string): Promise<Rolloff> {
  const r = await get<Rolloff>("SELECT * FROM rolloffs WHERE id = ?", id);
  if (!r || r.status !== "scheduled") throw new HttpError(404, "No scheduled roll-off with that id.");
  await run("UPDATE rolloffs SET delete_on = ?, error = NULL WHERE id = ? AND status = 'scheduled'", now(), id);
  const what = r.scope === "group" ? `group “${r.workspace_name}”` : "the organization's data";
  await audit({ org_id: r.org_id, name: `${BRAND.name} team` }, `Brought the deletion of ${what} forward to now`, "Data", r.workspace_id);
  await platformLog(ownerName, `${r.org_name}: deletion of ${what} brought forward to now`);
  return (await get<Rolloff>("SELECT * FROM rolloffs WHERE id = ?", id))!;
}

/* ---------- Deleting, with a certificate ---------- */

const n = async (sql: string, ...p: string[]) => Number((await get<{ n: number | string }>(sql, ...p))?.n ?? 0);

/** How much one group holds, by kind (for its certificate). Scoped to the organization. */
async function groupCounts(orgId: string, workspaceId: string): Promise<Record<string, number>> {
  const c = (table: string) => n(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ? AND org_id = ?`, workspaceId, orgId);
  return {
    "Documents": await c("documents"),
    "Search entries (passages)": await c("passages"),
    "Meetings (transcripts and notes)": await c("meetings"),
    "Decisions, risks and other meeting notes": await c("items"),
    "Action items": await c("action_items"),
    "Questions and answers": await c("questions"),
    "Saved Teams chat messages": await c("chat_messages"),
    "Custom guardrail rules": await c("guard_custom_rules"),
    "Group members": await n("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ?", workspaceId),
  };
}

const KEPT_GROUP = [
  "The organization's audit log (who did what and when) and this certificate, for the organization's own records.",
  "AI usage and cost records and activity timings for billing, which hold no document text.",
];
const KEPT_ORG = [
  `This certificate and a minimal record of the deletion (organization name, dates, who asked), kept by the ${BRAND.name} team as proof of deletion and for billing history.`,
  "Nothing else with the organization's id is kept: not its people, groups, documents, Teams links, settings, usage details or audit log.",
];
const backupLine = () => `Deleted data also leaves the database backups as they age out, within ${BACKUP_RETENTION_DAYS} days of the deletion. Backups can't be searched or used by ${BRAND.name}.`;

/** Writes the certificate on a roll-off row (creating a done row when there was no schedule). */
async function closeWithCertificate(r: Partial<Rolloff> & { org_id: string; org_name: string; scope: "group" | "org" }, cert: Certificate) {
  if (r.id) {
    await run("UPDATE rolloffs SET status = 'done', closed_by = ?, closed_at = ?, certificate_json = ?, error = NULL WHERE id = ?", cert.deletedBy, cert.deletedAt, JSON.stringify(cert), r.id);
    return r.id;
  }
  const id = newId();
  await run(
    `INSERT INTO rolloffs (id, org_id, org_name, workspace_id, workspace_name, scope, status, reason, delete_on, requested_by, created_at, closed_by, closed_at, certificate_json)
     VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, ?)`,
    id, r.org_id, r.org_name, r.workspace_id ?? null, r.workspace_name ?? null, r.scope, cert.reason, cert.deletedAt, cert.requestedBy, cert.requestedAt, cert.deletedBy, cert.deletedAt, JSON.stringify(cert),
  );
  return id;
}

/** One-line summary of the counts ("12 documents, 3 meetings…") for audit and log lines. */
export const countsLine = (c: Record<string, number>) => Object.entries(c).filter(([, v]) => v > 0).map(([k, v]) => `${k.toLowerCase()}: ${v}`).join(", ") || "nothing stored";

/**
 * Deletes a group with everything in it (`deleteWorkspace`) and writes its deletion certificate: on the
 * pending roll-off when there is one (`rolloff`), otherwise on a new done roll-off row (deleting a group by
 * hand gets a certificate too). Chats unlinked when the group started ending are now treated like any
 * unassigned chat (in a tied Microsoft tenant, Sidekick leaves them after 7 days). An audit entry with the
 * certificate's counts is added to the organization's log. Returns the certificate.
 */
export async function deleteGroupWithCertificate(orgId: string, workspaceId: string, actor: Pick<User, "org_id" | "name">, rolloff?: Rolloff | null): Promise<Certificate> {
  return span("rolloff", "Delete a group", async () => {
    const ws = await get<{ name: string; created_at: string }>("SELECT name, created_at FROM workspaces WHERE id = ? AND org_id = ?", workspaceId, orgId);
    if (!ws) throw new HttpError(404, "Workspace not found, or you're not a member of it.");
    const org = await get<{ name: string }>("SELECT name FROM orgs WHERE id = ?", orgId);
    const counts = await groupCounts(orgId, workspaceId);
    const { unlinked } = await deleteWorkspace(orgId, workspaceId);
    const ids = (JSON.parse(rolloff?.chats_json ?? "[]") as string[]).filter((x) => typeof x === "string");
    for (const id of ids) await run("UPDATE teams_conversations SET waiting_since = ? WHERE id = ? AND workspace_id IS NULL AND waiting_since IS NULL", now(), id);
    counts["Teams chats unlinked"] = unlinked + ids.length;
    const cert: Certificate = {
      id: certificateId(), scope: "group", organization: org?.name ?? rolloff?.org_name ?? "", group: ws.name,
      requestedBy: rolloff?.requested_by ?? actor.name, requestedAt: rolloff?.created_at ?? now(), reason: rolloff?.reason ?? "deleted by hand",
      deletedAt: now(), deletedBy: actor.name, counts, kept: KEPT_GROUP, backups: backupLine(),
    };
    await closeWithCertificate(rolloff ?? { org_id: orgId, org_name: cert.organization, workspace_id: workspaceId, workspace_name: ws.name, scope: "group" }, cert);
    await audit(actor, `Deleted group “${ws.name}” and everything in it. Deletion certificate ${cert.id}: ${countsLine(counts)}`, "Data", null);
    return cert;
  });
}

/**
 * Every table with an `org_id` column that `deleteOrganization` clears, children first (so foreign keys
 * hold on both engines). `rolloffs` is left out on purpose (it's the record of the deletion). A test checks
 * this list against the real schema, so a new table with an `org_id` can't be forgotten.
 */
export const ORG_TABLES = [
  "support_attachments", "support_messages", "support_article_uses", "support_tickets", "conversation_turns", "conversations",
  "answer_feedback", "firm_docs", "graph_meetings", "graph_poll_cursors", "graph_subscriptions", "auto_meetings", "findings", "watch_checks", "connector_health", "teams_post_failures", "jobs",
  "guard_rule_versions", "guard_custom_rules", "guard_workspace_rules", "guard_events", "guard_rules",
  "chat_messages", "teams_chat_settings", "reminder_runs", "action_items", "items", "meetings", "documents",
  "questions", "passages", "usage_events", "audit_log", "settings", "org_flags", "traces", "org_setup",
  "credit_topups", "credit_notices", "ai_batch_items", "org_terms", "subscriptions", "teams_conversations",
  "users", "workspaces",
] as const;

/**
 * Deletes a whole organization: every group (`deleteWorkspace`, search entries included), the firm library's
 * search entries (local and Azure, `removeFirmIndex`), then every row
 * with its id (`ORG_TABLES`), its people's sign-in data (sessions, two-step factors, backup codes, Microsoft
 * sign-ins in progress, failed sign-ins, rate-limit hits), Teams chats waiting in its Microsoft tenant, and
 * the organization itself. Writes the certificate on the roll-off row (or a new one) and the operator log.
 * Called by `runDueRolloffs`; never from a customer request. Returns the certificate.
 */
export async function deleteOrganization(orgId: string, actor: string, rolloff?: Rolloff | null): Promise<Certificate> {
  return span("rolloff", "Delete an organization", async () => {
    const org = await get<{ name: string; entra_tenant_id: string | null }>("SELECT name, entra_tenant_id FROM orgs WHERE id = ?", orgId);
    if (!org) throw new HttpError(404, "Client not found.");
    const groups = await all<{ id: string }>("SELECT id FROM workspaces WHERE org_id = ?", orgId);
    const counts: Record<string, number> = {
      "Groups": groups.length,
      "People (portal accounts)": await n("SELECT COUNT(*) AS n FROM users WHERE org_id = ?", orgId),
    };
    for (const g of groups) {
      for (const [k, v] of Object.entries(await groupCounts(orgId, g.id))) counts[k] = (counts[k] ?? 0) + v;
    }
    counts["Teams chats linked or waiting"] = await n(
      "SELECT COUNT(*) AS n FROM teams_conversations WHERE org_id = ? OR (workspace_id IS NULL AND tenant_id IS NOT NULL AND tenant_id = ?)", orgId, org.entra_tenant_id ?? "",
    );
    counts["Audit log entries"] = await n("SELECT COUNT(*) AS n FROM audit_log WHERE org_id = ?", orgId);
    counts["AI usage records"] = await n("SELECT COUNT(*) AS n FROM usage_events WHERE org_id = ?", orgId);
    counts["Activity traces"] = await n("SELECT COUNT(*) AS n FROM traces WHERE org_id = ?", orgId);
    counts["Firm library documents"] = await n("SELECT COUNT(*) AS n FROM firm_docs WHERE org_id = ?", orgId);
    counts["Firm library search entries"] = await n("SELECT COUNT(*) AS n FROM passages WHERE org_id = ? AND workspace_id = ?", orgId, FIRM_SCOPE);
    counts["Settings and guardrail switches"] = await n("SELECT COUNT(*) AS n FROM settings WHERE org_id = ?", orgId) + await n("SELECT COUNT(*) AS n FROM guard_rules WHERE org_id = ?", orgId);

    for (const g of groups) await deleteWorkspace(orgId, g.id);
    // The firm library is indexed once per org (not per group): remove it from Azure too, before the rows go.
    await removeFirmIndex(orgId);
    await tx(async () => {
      const users = "(SELECT id FROM users WHERE org_id = ?)";
      await run(`DELETE FROM mfa_backup_codes WHERE account_kind = 'user' AND account_id IN ${users}`, orgId);
      await run(`DELETE FROM mfa_factors WHERE account_kind = 'user' AND account_id IN ${users}`, orgId);
      await run(`DELETE FROM mfa_challenges WHERE account_kind = 'user' AND account_id IN ${users}`, orgId);
      await run(`DELETE FROM sessions WHERE user_id IN ${users}`, orgId);
      await run(`DELETE FROM oidc_states WHERE user_id IN ${users}`, orgId);
      await run(`DELETE FROM workspace_members WHERE user_id IN ${users}`, orgId);
      await run("DELETE FROM login_failures WHERE email IN (SELECT email FROM users WHERE org_id = ?)", orgId);
      await run("DELETE FROM rate_events WHERE bucket IN (SELECT 'ask:' || id FROM users WHERE org_id = ?)", orgId);
      await run("DELETE FROM trace_spans WHERE trace_id IN (SELECT id FROM traces WHERE org_id = ?)", orgId);
      if (org.entra_tenant_id) await run("DELETE FROM teams_conversations WHERE workspace_id IS NULL AND tenant_id = ?", org.entra_tenant_id);
      for (const table of ORG_TABLES) await run(`DELETE FROM ${table} WHERE org_id = ?`, orgId);
      await run("DELETE FROM orgs WHERE id = ?", orgId);
    });
    const cert: Certificate = {
      id: certificateId(), scope: "org", organization: org.name, group: null,
      requestedBy: rolloff?.requested_by ?? actor, requestedAt: rolloff?.created_at ?? now(), reason: rolloff?.reason ?? null,
      deletedAt: now(), deletedBy: actor, counts, kept: KEPT_ORG, backups: backupLine(),
    };
    await closeWithCertificate(rolloff ?? { org_id: orgId, org_name: org.name, scope: "org" }, cert);
    await platformLog(actor, `Deleted ${org.name} and all its data. Deletion certificate ${cert.id}: ${countsLine(counts)}`);
    return cert;
  });
}

/**
 * The scheduled job (the job queue's `rolloffs.run`, every 5 minutes): deletes every group and organization whose deletion
 * date has passed. Each is claimed first (scheduled → running), so it runs once even with two copies of
 * the app; a failure goes back to scheduled with the error and is retried next time. Returns how many
 * were deleted.
 */
export async function runDueRolloffs(at = new Date()): Promise<number> {
  const due = await all<Rolloff>("SELECT * FROM rolloffs WHERE status = 'scheduled' AND delete_on <= ? ORDER BY delete_on LIMIT 20", at.toISOString());
  let done = 0;
  for (const r of due) {
    const claimed = await run("UPDATE rolloffs SET status = 'running' WHERE id = ? AND status = 'scheduled'", r.id);
    if (!claimed.changes) continue;
    try {
      const by = `${BRAND.name} (scheduled deletion)`;
      if (r.scope === "group") {
        const exists = r.workspace_id && (await get("SELECT id FROM workspaces WHERE id = ? AND org_id = ?", r.workspace_id, r.org_id));
        if (exists) await deleteGroupWithCertificate(r.org_id, r.workspace_id!, { org_id: r.org_id, name: by }, r);
        else await run("UPDATE rolloffs SET status = 'canceled', closed_by = ?, closed_at = ?, error = ? WHERE id = ?", by, now(), "The group was already deleted.", r.id);
      } else {
        await deleteOrganization(r.org_id, by, r);
      }
      done++;
    } catch (e) {
      console.error(`Roll-off ${r.id} failed`, e);
      await run("UPDATE rolloffs SET status = 'scheduled', error = ? WHERE id = ?", (e instanceof Error ? e.message : String(e)).slice(0, 500), r.id);
    }
  }
  return done;
}

/* ---------- Reading, and the certificate as text or PDF ---------- */

/** A roll-off as shown in lists (no chat ids, the certificate's id and counts only once done). */
export function rolloffView(r: Rolloff) {
  const cert = r.certificate_json ? (JSON.parse(r.certificate_json) as Certificate) : null;
  return {
    id: r.id, orgId: r.org_id, org: r.org_name, scope: r.scope, workspaceId: r.workspace_id, group: r.workspace_name, status: r.status,
    reason: r.reason, readOnlyFrom: r.read_only_from, deleteOn: r.delete_on, requestedBy: r.requested_by, requestedAt: r.created_at,
    closedBy: r.closed_by, closedAt: r.closed_at, error: r.error, certificate: cert ? { id: cert.id, counts: cert.counts } : null,
  };
}

/** The organization's roll-offs, newest first (Org Owners/Admins: Settings → Roll-offs and certificates). */
export async function listRolloffs(orgId: string) {
  return (await all<Rolloff>("SELECT * FROM rolloffs WHERE org_id = ? ORDER BY created_at DESC LIMIT 200", orgId)).map(rolloffView);
}

/** Every roll-off, pending first, for the Owner Console. */
export async function listAllRolloffs() {
  const rows = await all<Rolloff>("SELECT * FROM rolloffs ORDER BY created_at DESC LIMIT 500");
  return rows.map(rolloffView).sort((a, b) => Number(b.status === "scheduled" || b.status === "running") - Number(a.status === "scheduled" || a.status === "running"));
}

/** The certificate of a done roll-off, or 404. `orgId` limits it to one organization (customers). */
export async function certificateFor(id: string, orgId?: string): Promise<Certificate> {
  const r = await get<Rolloff>("SELECT * FROM rolloffs WHERE id = ?", id);
  if (!r || (orgId !== undefined && r.org_id !== orgId) || !r.certificate_json) throw new HttpError(404, "Deletion certificate not found.");
  return JSON.parse(r.certificate_json) as Certificate;
}

/** The certificate as plain text lines ("# " = heading), shared by the text and PDF versions. */
export function certificateLines(c: Certificate): string[] {
  const what = c.scope === "group" ? `the group “${c.group}” of ${c.organization}` : `the organization ${c.organization} and all its groups`;
  return [
    `# ${BRAND.name} deletion certificate`,
    `Certificate: ${c.id}`,
    "",
    `This certifies that ${BRAND.name} deleted ${what}.`,
    "",
    `Requested by: ${c.requestedBy}, ${c.requestedAt.slice(0, 10)}${c.reason ? ` (${c.reason})` : ""}`,
    `Deleted: ${c.deletedAt.replace("T", " ").slice(0, 16)} UTC, by ${c.deletedBy}`,
    "",
    "# What was deleted",
    ...Object.entries(c.counts).map(([k, v]) => `${k}: ${v.toLocaleString("en-US")}`),
    "",
    "# What was kept",
    ...c.kept,
    "",
    "# Backups",
    c.backups,
    "",
    "This certificate lists kinds of data and counts only. It contains no content from the deleted data.",
  ];
}

/** The certificate as a text file. */
export const certificateText = (c: Certificate) => certificateLines(c).map((l) => (l.startsWith("# ") ? l.slice(2).toUpperCase() : l)).join("\n") + "\n";
/** The certificate as a PDF file. */
export const certificatePdf = (c: Certificate) => textPdf(`${BRAND.name} deletion certificate ${c.id}`, certificateLines(c));

/** A download response for a certificate (`format` "pdf" or anything else for text). */
export function certificateResponse(c: Certificate, format: string | null): Response {
  const pdf = format === "pdf";
  const body = pdf ? certificatePdf(c) : Buffer.from(certificateText(c), "utf8");
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": pdf ? "application/pdf" : "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="deletion-certificate-${c.id}.${pdf ? "pdf" : "txt"}"`,
      "cache-control": "no-store",
    },
  });
}
