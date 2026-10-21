/**
 * PATCH /api/action-items/:id: change an action item's status (Open, In progress, Done), owner or due date.
 * Who: anyone who can edit content in the item's workspace (Memory & gaps, or the meeting's own page). Audited,
 * with what changed. Teams cards change items through bot.ts instead.
 *
 * Body (all optional, at least one): `status`; `owner` (a name, up to 120 characters; "" clears it);
 * `due` ("YYYY-MM-DD"; "" clears it). A new due date replaces both the date reminders use (`due_on`) and the
 * words from the meeting (`due`), so the item no longer shows what was said ("next Friday").
 */
import { handle, readJson } from "@/lib/api";
import { audit, canEdit, HttpError, requireUser, requireWorkspace } from "@/lib/auth";
import { get, run } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };
const STATUSES = ["Open", "In progress", "Done"];
const MAX_OWNER = 120;

/** "" or a real calendar day as YYYY-MM-DD (2026-02-30 is refused). */
function isDay(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  if (!canEdit(user)) throw new HttpError(403, "Your role can't change action items.");
  const a = await get<{ id: string; workspace_id: string; text: string; status: string; owner: string | null; due_on: string | null }>(
    "SELECT id, workspace_id, text, status, owner, due_on FROM action_items WHERE id = ? AND org_id = ?", (await params).id, user.org_id,
  );
  if (!a) throw new HttpError(404, "Action item not found.");
  await requireWorkspace(user, a.workspace_id);
  const body = await readJson<{ status?: unknown; owner?: unknown; due?: unknown }>(req);

  // Check everything first, so a bad field never leaves the item half-changed.
  if (body.status !== undefined && (typeof body.status !== "string" || !STATUSES.includes(body.status))) throw new HttpError(400, "Status must be Open, In progress or Done.");
  if (body.owner !== undefined && body.owner !== null && typeof body.owner !== "string") throw new HttpError(400, "Owner must be a name.");
  const owner = body.owner === undefined ? undefined : (body.owner as string | null)?.trim() || null;
  if (owner && owner.length > MAX_OWNER) throw new HttpError(400, `Owner is too long (max ${MAX_OWNER} characters).`);
  if (body.due !== undefined && body.due !== null && typeof body.due !== "string") throw new HttpError(400, "Due date must be a date like 2026-10-24.");
  const due = body.due === undefined ? undefined : (body.due as string | null)?.trim() || null;
  if (due && !isDay(due)) throw new HttpError(400, "Due date must be a date like 2026-10-24.");

  const changes: string[] = [];
  if (body.status !== undefined && body.status !== a.status) {
    await run("UPDATE action_items SET status = ? WHERE id = ?", body.status, a.id);
    changes.push(`status ${a.status} → ${body.status}`);
  }
  if (owner !== undefined && owner !== a.owner) {
    await run("UPDATE action_items SET owner = ? WHERE id = ?", owner, a.id);
    changes.push(owner ? `owner → ${owner}` : "owner cleared");
  }
  if (due !== undefined && due !== a.due_on) {
    await run("UPDATE action_items SET due = ?, due_on = ? WHERE id = ?", due, due, a.id);
    changes.push(due ? `due → ${due}` : "due date cleared");
  }
  if (!changes.length) {
    if (body.status === undefined && owner === undefined && due === undefined) throw new HttpError(400, "Nothing to change: send status, owner or due.");
    return { ok: true, changed: false };
  }
  await audit(user, `Updated action item “${a.text.slice(0, 60)}”: ${changes.join(", ")}`, "Data", a.workspace_id);
  return { ok: true, changed: true };
});
