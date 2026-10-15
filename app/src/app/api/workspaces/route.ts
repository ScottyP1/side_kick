import { handle, readJson, requireText } from "@/lib/api";
import { audit, isAdmin, requireUser, workspaceIdsFor, HttpError } from "@/lib/auth";
import { all, newId, now, run } from "@/lib/db";

const COLORS = ["#0f6b5c", "#2a5ba8", "#7a5a2a", "#8b3f6b", "#5a6b1f", "#9a4a1f", "#3d4a52"];

export const GET = handle(async () => {
  const user = await requireUser();
  const ids = workspaceIdsFor(user);
  if (!ids.length) return { workspaces: [] };
  const ph = ids.map(() => "?").join(",");
  const workspaces = all(
    `SELECT w.id, w.name, w.code, w.color, w.created_at,
       (SELECT COUNT(*) FROM documents d WHERE d.workspace_id = w.id) AS docs,
       (SELECT COUNT(*) FROM meetings m WHERE m.workspace_id = w.id) AS meetings,
       (SELECT COUNT(*) FROM workspace_members wm WHERE wm.workspace_id = w.id) AS members,
       (SELECT COUNT(*) FROM action_items a WHERE a.workspace_id = w.id AND a.status != 'Done') AS open_items,
       (SELECT MAX(held_at) FROM meetings m WHERE m.workspace_id = w.id) AS last_meeting
     FROM workspaces w WHERE w.id IN (${ph}) ORDER BY w.name`,
    ...ids,
  );
  return { workspaces };
});

export const POST = handle(async (req: Request) => {
  const user = await requireUser();
  if (!isAdmin(user)) throw new HttpError(403, "Only Org Owners and Org Admins can create workspaces.");
  const body = await readJson<{ name?: string; code?: string }>(req);
  const name = requireText(body.name, "Workspace name", 120);
  const id = newId();
  const count = all("SELECT id FROM workspaces WHERE org_id = ?", user.org_id).length;
  run("INSERT INTO workspaces (id, org_id, name, code, color, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, user.org_id, name, body.code?.trim() || null, COLORS[count % COLORS.length], now());
  run("INSERT INTO workspace_members (workspace_id, user_id) VALUES (?, ?)", id, user.id);
  audit(user, `Created workspace “${name}”`, "Access", id);
  return { id };
});
