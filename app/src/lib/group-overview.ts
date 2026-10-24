/**
 * @file Two read-only summaries for one group's page (/workspaces/[id]):
 * - **Sources** (`groupSources`): which connected tools feed this group (Jira, Azure DevOps, GitHub, Confluence,
 *   Microsoft 365 files), by tool, project/space/library name and last successful sync. Everyone in the group may
 *   see it (GET /api/workspaces/:id/sources), so Members and Viewers know where answers come from without the
 *   Connectors page, which is for Org Owners/Admins and Team Leads. Names and dates only: never tokens, accounts or
 *   anything that would let someone act on the connection.
 * - **Group activity** (`groupActivity`): the last 30 days in one group (questions asked and answered, meetings
 *   captured, documents added) and the share of the organization's AI use that went to this group, as a percent.
 *   No prices, plan or billing details. For the group's Team Lead and Org Owners/Admins only
 *   (GET /api/workspaces/:id/usage checks `requireManage`).
 *
 * Both take an org id and a workspace id the caller has already checked against the workspace wall, and filter on
 * both. Kept apart from lib/connectors.ts so the connector code can change shape without touching these pages:
 * if the connector tables change, only `groupSources` needs adapting.
 */
import "server-only";
import { all, get } from "./db";
import { KIND_LABEL, type ConnectorKind } from "./connector-text";

/** One tool feeding a group: its plain name, what is linked (project, space or library) and when it last synced. */
export type GroupSource = { tool: string; name: string; lastSync: string | null; working: boolean };

/**
 * The tools linked to this group, in a stable order (tool, then name). `working` is false when the tool's sign-in
 * expired or the last sync failed; `lastSync` is the last successful sync (null if none yet).
 */
export async function groupSources(orgId: string, workspaceId: string): Promise<GroupSource[]> {
  const rows = await all<{ kind: ConnectorKind; status: string; project_name: string; last_ok_at: string | null; last_error: string | null }>(
    `SELECT c.kind, c.status, l.project_name, l.last_ok_at, l.last_error
       FROM connector_links l JOIN connectors c ON c.id = l.connector_id AND c.org_id = l.org_id
      WHERE l.org_id = ? AND l.workspace_id = ?
      ORDER BY c.kind, l.project_name`,
    orgId, workspaceId,
  );
  return rows.map((r) => ({ tool: KIND_LABEL[r.kind] ?? r.kind, name: r.project_name, lastSync: r.last_ok_at, working: r.status === "connected" && !r.last_error }));
}

/** How many days `groupActivity` looks back. */
export const ACTIVITY_DAYS = 30;

/** One group's last `ACTIVITY_DAYS` days. `aiSharePct` is this group's share of the organization's AI use (0-100, null when the org used none). */
export type GroupActivity = { days: number; questions: number; answered: number; meetings: number; documents: number; aiSharePct: number | null };

/** Counts for one group over the last `ACTIVITY_DAYS` days, and its share of the organization's AI use in that time. */
export async function groupActivity(orgId: string, workspaceId: string, at = new Date()): Promise<GroupActivity> {
  const since = new Date(at.getTime() - ACTIVITY_DAYS * 86400_000).toISOString();
  const n = async (sql: string) => (await get<{ n: number }>(sql, orgId, workspaceId, since))?.n ?? 0;
  const [questions, answered, meetings, documents] = await Promise.all([
    n("SELECT COUNT(*) AS n FROM questions WHERE org_id = ? AND workspace_id = ? AND created_at >= ?"),
    n("SELECT COUNT(*) AS n FROM questions WHERE org_id = ? AND workspace_id = ? AND created_at >= ? AND found = 1"),
    n("SELECT COUNT(*) AS n FROM meetings WHERE org_id = ? AND workspace_id = ? AND created_at >= ?"),
    n("SELECT COUNT(*) AS n FROM documents WHERE org_id = ? AND workspace_id = ? AND created_at >= ?"),
  ]);
  // Only the organization's own AI use counts (not work Sidekick pays for itself: `payer` is set for that).
  const cost = await all<{ ws: number; total: number }>(
    `SELECT COALESCE(SUM(CASE WHEN workspace_id = ? THEN cost_usd ELSE 0 END), 0) AS ws, COALESCE(SUM(cost_usd), 0) AS total
       FROM usage_events WHERE org_id = ? AND created_at >= ? AND payer IS NULL`,
    workspaceId, orgId, since,
  );
  const { ws, total } = cost[0] ?? { ws: 0, total: 0 };
  return { days: ACTIVITY_DAYS, questions, answered, meetings, documents, aiSharePct: total > 0 ? Math.round((ws / total) * 1000) / 10 : null };
}
