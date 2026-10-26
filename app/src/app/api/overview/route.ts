/**
 * GET /api/overview: numbers for the portal home page across the workspaces this user can see.
 * AI use this month, as a count of AI requests (`aiCallsMonth`; never the cost, which is only in the Owner
 * Console): roles that may see usage and billing (Org Owner, Org Admin) get the whole organization's total
 * (`spendScope: "org"`); everyone else gets only the calls made for them, in the portal or from a linked Teams
 * account (`spendScope: "you"`).
 */
import { handle } from "@/lib/api";
import { isAdmin, requireUser, workspaceIdsFor } from "@/lib/auth";
import { all, get } from "@/lib/db";

export const GET = handle(async () => {
  const user = await requireUser();
  const ids = await workspaceIdsFor(user);
  const ph = ids.length ? ids.map(() => "?").join(",") : "''";
  const one = async (sql: string) => ((await get<{ n: number }>(sql.replace("__WS__", ph), ...ids))?.n ?? 0);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const wholeOrg = isAdmin(user);
  const mine = (await get<{ calls: number }>(
    `SELECT COUNT(*) AS calls FROM usage_events WHERE org_id = ? AND created_at >= ?${wholeOrg ? "" : " AND user_id = ?"}`,
    ...(wholeOrg ? [user.org_id, monthStart] : [user.org_id, monthStart, user.id]),
  )) ?? { calls: 0 };
  return {
    stats: {
      workspaces: ids.length,
      documents: await one("SELECT COUNT(*) n FROM documents WHERE workspace_id IN (__WS__) AND status = 'Ready'"),
      meetings: await one("SELECT COUNT(*) n FROM meetings WHERE workspace_id IN (__WS__) AND status = 'Ready'"),
      questions: await one("SELECT COUNT(*) n FROM questions WHERE workspace_id IN (__WS__)"),
      answered: await one("SELECT COUNT(*) n FROM questions WHERE workspace_id IN (__WS__) AND found = 1"),
      openActions: await one("SELECT COUNT(*) n FROM action_items WHERE workspace_id IN (__WS__) AND status != 'Done'"),
      noOwner: await one("SELECT COUNT(*) n FROM action_items WHERE workspace_id IN (__WS__) AND status != 'Done' AND (owner IS NULL OR owner = '')"),
      decisions: await one("SELECT COUNT(*) n FROM items WHERE workspace_id IN (__WS__) AND kind = 'decision'"),
      aiCallsMonth: mine.calls,
      spendScope: wholeOrg ? "org" : "you",
    },
    recentMeetings: ids.length
      ? await all(`SELECT m.id, m.title, m.held_at, m.status, w.name AS workspace, w.color, w.id AS workspace_id FROM meetings m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id IN (${ph}) ORDER BY m.created_at DESC LIMIT 5`, ...ids)
      : [],
    attention: {
      failedDocs: ids.length ? await all(`SELECT d.id, d.name, d.error, d.workspace_id FROM documents d WHERE d.workspace_id IN (${ph}) AND d.status = 'Failed' ORDER BY d.created_at DESC LIMIT 3`, ...ids) : [],
      failedQuestions: ids.length ? await all(`SELECT MIN(q.question) AS question, q.workspace_id, COUNT(*) c FROM questions q WHERE q.workspace_id IN (${ph}) AND q.found = 0 GROUP BY lower(q.question), q.workspace_id ORDER BY c DESC LIMIT 3`, ...ids) : [],
      failedMeetings: ids.length ? await all(`SELECT id, title, error, workspace_id FROM meetings WHERE workspace_id IN (${ph}) AND status = 'Failed' LIMIT 3`, ...ids) : [],
    },
  };
});
