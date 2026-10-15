import { handle } from "@/lib/api";
import { requireUser, workspaceIdsFor } from "@/lib/auth";
import { all, get } from "@/lib/db";

export const GET = handle(async () => {
  const user = await requireUser();
  const ids = workspaceIdsFor(user);
  const ph = ids.length ? ids.map(() => "?").join(",") : "''";
  const one = (sql: string) => (get<{ n: number }>(sql.replace("__WS__", ph), ...ids)?.n ?? 0);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  return {
    stats: {
      workspaces: ids.length,
      documents: one("SELECT COUNT(*) n FROM documents WHERE workspace_id IN (__WS__) AND status = 'Ready'"),
      meetings: one("SELECT COUNT(*) n FROM meetings WHERE workspace_id IN (__WS__) AND status = 'Ready'"),
      questions: one("SELECT COUNT(*) n FROM questions WHERE workspace_id IN (__WS__)"),
      answered: one("SELECT COUNT(*) n FROM questions WHERE workspace_id IN (__WS__) AND found = 1"),
      openActions: one("SELECT COUNT(*) n FROM action_items WHERE workspace_id IN (__WS__) AND status != 'Done'"),
      noOwner: one("SELECT COUNT(*) n FROM action_items WHERE workspace_id IN (__WS__) AND status != 'Done' AND (owner IS NULL OR owner = '')"),
      decisions: one("SELECT COUNT(*) n FROM items WHERE workspace_id IN (__WS__) AND kind = 'decision'"),
      spendMonth: get<{ c: number }>("SELECT COALESCE(SUM(cost_usd),0) c FROM usage_events WHERE org_id = ? AND created_at >= ?", user.org_id, monthStart)?.c ?? 0,
    },
    recentMeetings: ids.length
      ? all(`SELECT m.id, m.title, m.held_at, m.status, w.name AS workspace, w.color, w.id AS workspace_id FROM meetings m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id IN (${ph}) ORDER BY m.created_at DESC LIMIT 5`, ...ids)
      : [],
    attention: {
      failedDocs: ids.length ? all(`SELECT d.id, d.name, d.error, d.workspace_id FROM documents d WHERE d.workspace_id IN (${ph}) AND d.status = 'Failed' ORDER BY d.created_at DESC LIMIT 3`, ...ids) : [],
      failedQuestions: ids.length ? all(`SELECT q.question, q.workspace_id, COUNT(*) c FROM questions q WHERE q.workspace_id IN (${ph}) AND q.found = 0 GROUP BY lower(q.question), q.workspace_id ORDER BY c DESC LIMIT 3`, ...ids) : [],
      failedMeetings: ids.length ? all(`SELECT id, title, error, workspace_id FROM meetings WHERE workspace_id IN (${ph}) AND status = 'Failed' LIMIT 3`, ...ids) : [],
    },
  };
});
