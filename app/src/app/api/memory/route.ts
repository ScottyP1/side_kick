/**
 * GET /api/memory: a workspace's memory: the knowledge map with gap statuses, items from meetings, and action items.
 * Who: any member of the workspace.
 */
import { handle } from "@/lib/api";
import { requireUser, requireWorkspace } from "@/lib/auth";
import { all, get } from "@/lib/db";

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const ws = await requireWorkspace(user, new URL(req.url).searchParams.get("ws"));
  const insight = await get<{ json: string; refreshed_at: string }>("SELECT json, refreshed_at FROM insights WHERE workspace_id = ?", ws);
  const statuses = await all<{ gap_key: string; status: string; assignee: string | null }>("SELECT gap_key, status, assignee FROM gap_status WHERE workspace_id = ?", ws);
  const parsed = insight ? JSON.parse(insight.json) : null;
  const gaps = (parsed?.gaps ?? [])
    .map((g: { text: string }) => {
      const s = statuses.find((x) => x.gap_key === g.text);
      return { ...g, status: s?.status ?? "Open", assignee: s?.assignee ?? null };
    })
    .filter((g: { status: string }) => g.status !== "Resolved");
  const items = await all(
    `SELECT i.id, i.kind, i.text, i.who, i.answered, i.pinned, i.created_at, m.title AS meeting, m.held_at
       FROM items i LEFT JOIN meetings m ON m.id = i.meeting_id WHERE i.workspace_id = ? ORDER BY m.held_at DESC, i.rowid`,
    ws,
  );
  const actions = await all(
    `SELECT a.id, a.text, a.owner, a.due, a.due_on, a.status, a.ticket, m.title AS meeting, m.held_at
       FROM action_items a LEFT JOIN meetings m ON m.id = a.meeting_id WHERE a.workspace_id = ? ORDER BY a.status = 'Done', m.held_at DESC, a.rowid`,
    ws,
  );
  return { topics: parsed?.topics ?? [], gaps, refreshedAt: insight?.refreshed_at ?? null, items, actions };
});
