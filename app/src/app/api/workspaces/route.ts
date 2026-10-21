/**
 * GET/POST /api/workspaces: the workspaces (shown as "groups" in the portal) this user can see, with counts
 * and their Team Leads, or create one.
 * Who: everyone can list their own; only Org Owners and Org Admins can create. Names are unique within the
 * organization (ignoring case). Rename and delete: /api/workspaces/:id. People: /api/workspaces/:id/members.
 *
 * Concepts: a group is one client team ("Payments Platform" for the client "Northwind Bank"). Its Team Lead
 * is any member whose role is Team Lead. Creating a group can pick the lead and the first members in one
 * go; picking a Member or Viewer as lead makes them a Team Lead (audited), since only admins may do that.
 */
import { handle, readJson, requireText } from "@/lib/api";
import { audit, isAdmin, requireUser, workspaceIdsFor, HttpError, type Role } from "@/lib/auth";
import { all, newId, now, run, tx } from "@/lib/db";
import { assertUniqueName, MAX_CLIENT, MAX_CODE, MAX_NAME } from "@/lib/workspaces";

const COLORS = ["#4f46e5", "#2a5ba8", "#7a5a2a", "#8b3f6b", "#5a6b1f", "#9a4a1f", "#3d4a52"];

/**
 * Lists the caller's workspaces with document, meeting, member, open/overdue action item and linked chat
 * counts, and `leads` (the Team Leads in each), for the Groups page cards.
 */
export const GET = handle(async () => {
  const user = await requireUser();
  const ids = await workspaceIdsFor(user);
  if (!ids.length) return { workspaces: [] };
  const ph = ids.map(() => "?").join(",");
  const today = now().slice(0, 10);
  const workspaces = await all<{ id: string }>(
    `SELECT w.id, w.name, w.code, w.client, w.color, w.created_at,
       (SELECT COUNT(*) FROM documents d WHERE d.workspace_id = w.id) AS docs,
       (SELECT COUNT(*) FROM meetings m WHERE m.workspace_id = w.id) AS meetings,
       (SELECT COUNT(*) FROM workspace_members wm WHERE wm.workspace_id = w.id) AS members,
       (SELECT COUNT(*) FROM action_items a WHERE a.workspace_id = w.id AND a.status != 'Done') AS open_items,
       (SELECT COUNT(*) FROM action_items a WHERE a.workspace_id = w.id AND a.status != 'Done' AND a.due_on IS NOT NULL AND a.due_on < ?) AS overdue,
       (SELECT COUNT(*) FROM teams_conversations t WHERE t.workspace_id = w.id) AS chats,
       (SELECT MAX(held_at) FROM meetings m WHERE m.workspace_id = w.id) AS last_meeting
     FROM workspaces w WHERE w.org_id = ? AND w.id IN (${ph}) ORDER BY w.name`,
    today, user.org_id, ...ids,
  );
  const leads = await all<{ workspace_id: string; id: string; name: string }>(
    `SELECT wm.workspace_id, u.id, u.name FROM workspace_members wm JOIN users u ON u.id = wm.user_id
      WHERE u.org_id = ? AND u.role = 'Team Lead' AND wm.workspace_id IN (${ph}) ORDER BY u.name`,
    user.org_id, ...ids,
  );
  return {
    workspaces: workspaces.map((w) => ({ ...w, leads: leads.filter((l) => l.workspace_id === w.id).map(({ id, name }) => ({ id, name })) })),
  };
});

/**
 * Creates a workspace: `{ name, code?, client?, lead?, members? }` where `lead` and `members` are user ids
 * in the same organization. The creator is always a member (so they can open it). A lead who is a Member or
 * Viewer becomes a Team Lead; Org Owners/Admins/Billing Admins can't be picked as lead.
 */
export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  if (!isAdmin(user)) throw new HttpError(403, "Only Org Owners and Org Admins can create workspaces.");
  const body = await readJson<{ name?: string; code?: string; client?: string; lead?: string; members?: unknown }>(req);
  const name = requireText(body.name, "Workspace name", MAX_NAME);
  const code = typeof body.code === "string" ? body.code.trim() || null : null;
  if (code && code.length > MAX_CODE) throw new HttpError(400, `Engagement code is too long (max ${MAX_CODE} characters).`);
  const client = typeof body.client === "string" ? body.client.trim() || null : null;
  if (client && client.length > MAX_CLIENT) throw new HttpError(400, `Client name is too long (max ${MAX_CLIENT} characters).`);
  const memberIds = Array.isArray(body.members) ? [...new Set(body.members.filter((m): m is string => typeof m === "string"))] : [];
  if (memberIds.length > 500) throw new HttpError(400, "Add at most 500 people at once.");
  await assertUniqueName(user.org_id, name);

  // Everyone named must be in this organization (404 otherwise, like any person lookup).
  const wanted = [...new Set([...(body.lead ? [body.lead] : []), ...memberIds])];
  const people = wanted.length
    ? await all<{ id: string; name: string; role: Role }>(`SELECT id, name, role FROM users WHERE org_id = ? AND id IN (${wanted.map(() => "?").join(",")})`, user.org_id, ...wanted)
    : [];
  if (people.length !== wanted.length) throw new HttpError(404, "Person not found.");
  const lead = body.lead ? people.find((p) => p.id === body.lead)! : null;
  if (lead && !["Team Lead", "Member", "Viewer"].includes(lead.role)) {
    throw new HttpError(400, `${lead.name} is ${lead.role === "Org Owner" || lead.role === "Org Admin" ? "an" : "a"} ${lead.role} and already manages every group. Pick someone else as Team Lead.`);
  }

  const id = newId();
  await tx(async () => {
    const count = (await all("SELECT id FROM workspaces WHERE org_id = ?", user.org_id)).length;
    await run("INSERT INTO workspaces (id, org_id, name, code, client, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, user.org_id, name, code, client, COLORS[count % COLORS.length], now());
    for (const uid of new Set([user.id, ...wanted])) await run("INSERT INTO workspace_members (workspace_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING", id, uid);
    if (lead && lead.role !== "Team Lead") await run("UPDATE users SET role = 'Team Lead' WHERE id = ? AND org_id = ?", lead.id, user.org_id);
  });
  await audit(user, `Created workspace “${name}”${client ? ` for ${client}` : ""}`, "Access", id);
  if (lead && lead.role !== "Team Lead") await audit(user, `Changed ${lead.name}'s role to Team Lead`, "Access");
  if (lead) await audit(user, `Made ${lead.name} Team Lead of “${name}”`, "Access", id);
  if (memberIds.length) await audit(user, `Added ${memberIds.filter((m) => m !== lead?.id).length} people to “${name}”`, "Access", id);
  return { id };
});
