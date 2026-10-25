/**
 * GET/PATCH /api/owner/tenants/:id: one client organization in detail, or pause/resume it.
 * Who: platform operators only (a client account, even an Org Owner, gets 401). Both are logged in the
 * operator log, so there's a record of every time someone at Sidekick looked at a client's people.
 * GET with `?reload=1` is the page refreshing itself after a change (e.g. a restriction switch) during the
 * same visit: it isn't logged again, since opening the page already was.
 */
import { handle, readJson } from "@/lib/api";
import { audit, HttpError } from "@/lib/auth";
import { all, get, run } from "@/lib/db";
import { billingSummary } from "@/lib/billing";
import { listRolloffs } from "@/lib/rolloff";
import { orgFlags, platformLog, requireOwner } from "@/lib/owner";
import { creditStatus } from "@/lib/credit";
import { limitReport, monthStart, orgTerms } from "@/lib/limits";
import { BRAND } from "@/lib/brand";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The client's details for its Owner Console page: the organization (status, Microsoft sign-in), every
 * person (role, workspaces, Microsoft-linked, last active), every workspace (members, documents, meetings)
 * its feature switches and its subscription (plan, status, what it allows now; null = managed by the
 * Sidekick team), its plan terms (custom limits, AI credit override, contract price, partner), every limit
 * with its use, this month's AI credit, and its AI use by feature and model (models are shown only here,
 * never in the client portal). Never any document or meeting content.
 */
export const GET = handle(async (req: Request, { params }: Ctx) => {
  const owner = await requireOwner();
  const org = await get<{ id: string; name: string; status: string; created_at: string; entra_tenant_id: string | null; sso_required: number }>(
    "SELECT id, name, status, created_at, entra_tenant_id, sso_required FROM orgs WHERE id = ?", (await params).id,
  );
  if (!org) throw new HttpError(404, "Organization not found.");
  const people = await all<{ id: string; name: string; email: string; role: string; microsoft: number; last_active: string | null; created_at: string }>(
    `SELECT id, name, email, role, CASE WHEN entra_oid IS NULL THEN 0 ELSE 1 END AS microsoft, last_active, created_at
       FROM users WHERE org_id = ? ORDER BY created_at`, org.id,
  );
  const workspaces = await all<{ id: string; name: string; code: string | null; documents: number; meetings: number }>(
    `SELECT w.id, w.name, w.code,
       (SELECT COUNT(*) FROM documents d WHERE d.workspace_id = w.id) AS documents,
       (SELECT COUNT(*) FROM meetings m WHERE m.workspace_id = w.id) AS meetings
     FROM workspaces w WHERE w.org_id = ? ORDER BY w.name`, org.id,
  );
  const members = await all<{ user_id: string; workspace_id: string }>(
    "SELECT wm.user_id, wm.workspace_id FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE w.org_id = ?", org.id,
  );
  const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
  const credit = await creditStatus(org.id, { fresh: true });
  // Once per visit: the page's own reloads after a change send ?reload=1.
  if (new URL(req.url).searchParams.get("reload") !== "1") await platformLog(owner.name, `Viewed the people and workspaces of ${org.name}`);
  return {
    org: { id: org.id, name: org.name, status: org.status, created_at: org.created_at, microsoft_connected: Boolean(org.entra_tenant_id), microsoft_required: org.sso_required === 1 },
    people: people.map((p) => ({
      ...p,
      microsoft: p.microsoft === 1,
      // Admins see every workspace in their org, so their list is "all" rather than memberships.
      workspaces: p.role === "Org Owner" || p.role === "Org Admin" ? ["All groups"] : members.filter((m) => m.user_id === p.id).map((m) => wsName.get(m.workspace_id)!),
    })),
    workspaces: workspaces.map((w) => ({ ...w, members: members.filter((m) => m.workspace_id === w.id).length })),
    flags: await orgFlags(org.id),
    billing: await billingSummary(org.id),
    rolloffs: await listRolloffs(org.id),
    terms: await orgTerms(org.id),
    credit,
    limits: (await limitReport(org.id, credit.usedUsd)).lines,
    ai: {
      byModel: await all("SELECT feature, model, COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens),0) input, COALESCE(SUM(cache_read_tokens),0) cached FROM usage_events WHERE org_id = ? AND created_at >= ? GROUP BY feature, model ORDER BY cost DESC", org.id, monthStart()),
    },
  };
});

// Pause or resume a client's access. Suspended orgs can't sign in or use any feature.
export const PATCH = handle(async (req: Request, { params }: Ctx) => {
  const owner = await requireOwner();
  const org = await get<{ id: string; name: string }>("SELECT id, name FROM orgs WHERE id = ?", (await params).id);
  if (!org) throw new HttpError(404, "Organization not found.");
  const { status } = await readJson<{ status?: string }>(req);
  if (status !== "Active" && status !== "Suspended") throw new HttpError(400, "Status must be Active or Suspended.");
  await run("UPDATE orgs SET status = ? WHERE id = ?", status, org.id);
  await audit({ org_id: org.id, name: `${BRAND.name} team` }, status === "Suspended" ? `Paused ${BRAND.name} access for this organization` : `Restored ${BRAND.name} access`, "Access");
  await platformLog(owner.name, `${status === "Suspended" ? "Suspended" : "Reactivated"} ${org.name}`);
  return { ok: true };
});
