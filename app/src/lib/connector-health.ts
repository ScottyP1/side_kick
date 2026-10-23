/**
 * @file Connector health: the one place a connector (Azure DevOps Boards, Jira, later others) says whether it
 * works for an organization, so the broken-connector watcher (lib/watchers.ts) can tell people.
 *
 * Concepts
 * - **Connector**: a link from an organization (or one of its groups) to another tool, e.g. Azure DevOps Boards.
 *   Each connector has a short id (`"azure-devops"`, `"jira"`) and a plain label ("Azure DevOps Boards").
 * - **Health**: the connector's latest state, `ok` or `broken` (token expired, permission removed, project gone,
 *   the other service refusing). One row per organization + group + connector in `connector_health`; group `''`
 *   means the connector is organization-wide. `broken_since` keeps the first time it broke, so "since Tuesday"
 *   stays true while it keeps failing.
 * - **The hook**: a connector calls `reportConnectorHealth(...)` after each sync or check, with `ok: true` when it
 *   worked or `ok: false` and a short reason (no client content: e.g. "The access token expired"). On the next
 *   watcher run (every 15 minutes) a broken connector becomes a finding for the organization's admins (or the
 *   group's managers, when it's per group) with a link to fix it; reporting `ok: true` again resolves it.
 *   `removeConnectorHealth` forgets a connector that was disconnected on purpose.
 *
 * Who may call it: server code acting for the organization (connector sync jobs, the connector settings routes).
 * Always pass the organization id the connector belongs to; nothing here checks roles.
 */
import "server-only";
import { all, now, run } from "./db";

/** One connector's latest state, as stored. `workspace_id` is '' for an organization-wide connector. */
export type ConnectorHealth = {
  org_id: string;
  workspace_id: string;
  connector: string;
  label: string;
  status: "ok" | "broken";
  message: string | null;
  fix_href: string | null;
  checked_at: string;
  broken_since: string | null;
};

/**
 * Records whether a connector works right now (call after every sync or check).
 *
 * @param opts.orgId       the organization the connector belongs to
 * @param opts.workspaceId the group, when the connector is per group (omit for organization-wide)
 * @param opts.connector   short id, e.g. "azure-devops" or "jira"
 * @param opts.label       plain name shown to people, e.g. "Azure DevOps Boards"
 * @param opts.ok          true when it worked
 * @param opts.message     when broken: a short reason people can act on, never client content
 * @param opts.fixHref     portal page where it's fixed (default: /connectors)
 */
export async function reportConnectorHealth(opts: { orgId: string; workspaceId?: string | null; connector: string; label: string; ok: boolean; message?: string | null; fixHref?: string | null }) {
  const t = now();
  await run(
    `INSERT INTO connector_health (org_id, workspace_id, connector, label, status, message, fix_href, checked_at, broken_since)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (org_id, workspace_id, connector) DO UPDATE SET
       label = excluded.label, status = excluded.status, message = excluded.message, fix_href = excluded.fix_href,
       checked_at = excluded.checked_at,
       broken_since = CASE WHEN excluded.status = 'ok' THEN NULL ELSE COALESCE(connector_health.broken_since, excluded.broken_since) END`,
    opts.orgId, opts.workspaceId ?? "", opts.connector, opts.label.slice(0, 80), opts.ok ? "ok" : "broken",
    opts.ok ? null : (opts.message ?? "It stopped working.").slice(0, 300), opts.fixHref ?? null, t, opts.ok ? null : t,
  );
}

/** Forgets a connector's health (it was disconnected on purpose), which also resolves its finding. */
export async function removeConnectorHealth(orgId: string, connector: string, workspaceId?: string | null) {
  await run("DELETE FROM connector_health WHERE org_id = ? AND connector = ? AND workspace_id = ?", orgId, connector, workspaceId ?? "");
}

/** The organization's broken connectors (read by the broken-connector watcher). */
export async function brokenConnectors(orgId: string): Promise<ConnectorHealth[]> {
  return all<ConnectorHealth>("SELECT * FROM connector_health WHERE org_id = ? AND status = 'broken' ORDER BY broken_since", orgId);
}
