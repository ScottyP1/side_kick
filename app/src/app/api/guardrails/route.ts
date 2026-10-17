/**
 * /api/guardrails: the organization's guardrails (see lib/guardrails.ts).
 *
 * GET  ?ws=<workspace id> (optional). Who: anyone signed in. Returns the locked floor, the org-wide
 *      switches and whether they're on, who last changed them, `canEdit` (Org Owner only: org switches),
 *      `canManage` (Org Owners/Admins: workspace switches, custom rules, the Test it box), the org-wide
 *      custom rules, the workspaces this person can see (for the page's picker), and for Org
 *      Owners/Admins a 30-day `summary` of how often each rule fired (counts only, no question or answer
 *      text). With `ws` (checked against the workspace wall, 404 if not theirs) it also returns that
 *      workspace's switches (org setting, the workspace's extra, and what's in force) and its own rules.
 * PUT  { [switch]: boolean, ... } Who: the Org Owner. Each change is written to the audit log as a
 *      policy change. Unknown switch names are ignored; the locked floor can't be changed at all.
 *
 * Related: /api/guardrails/workspace (a workspace's extra switches), /api/guardrails/rules (custom rules
 * and their history), /api/guardrails/test (the Test it box).
 */
import { handle, readJson } from "@/lib/api";
import { audit, isAdmin, requireUser, requireWorkspace, workspaceIdsFor } from "@/lib/auth";
import { all, get } from "@/lib/db";
import { FLOOR, getGuardSettings, getWorkspaceExtras, guardSummary, listRules, MAX_RULE_LENGTH, MAX_RULES, saveGuardSettings, SWITCHES, type SwitchKey } from "@/lib/guardrails";

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const wsParam = new URL(req.url).searchParams.get("ws");
  const settings = await getGuardSettings(user.org_id);
  const updated = await get<{ updated_by: string | null; updated_at: string }>("SELECT updated_by, updated_at FROM guard_rules WHERE org_id = ?", user.org_id);
  const mine = new Set(await workspaceIdsFor(user));
  const workspaces = (await all<{ id: string; name: string }>("SELECT id, name FROM workspaces WHERE org_id = ? ORDER BY name, id", user.org_id)).filter((w) => mine.has(w.id));
  let workspace = null;
  if (wsParam) {
    const ws = await requireWorkspace(user, wsParam);
    const extras = await getWorkspaceExtras(user.org_id, ws);
    const wsUpdated = await get<{ updated_by: string | null; updated_at: string }>("SELECT updated_by, updated_at FROM guard_workspace_rules WHERE workspace_id = ? AND org_id = ?", ws, user.org_id);
    workspace = {
      id: ws,
      name: workspaces.find((w) => w.id === ws)?.name ?? "",
      switches: (Object.keys(SWITCHES) as SwitchKey[]).map((key) => ({ key, label: SWITCHES[key].label, org: settings[key], extra: extras[key], on: settings[key] || extras[key] })),
      rules: await listRules(user.org_id, ws),
      updated: wsUpdated ? { by: wsUpdated.updated_by ?? "Unknown", at: wsUpdated.updated_at } : null,
    };
  }
  return {
    floor: FLOOR,
    switches: (Object.keys(SWITCHES) as SwitchKey[]).map((key) => ({ key, label: SWITCHES[key].label, help: SWITCHES[key].help, on: settings[key] })),
    canEdit: user.role === "Org Owner",
    canManage: isAdmin(user),
    updated: updated ? { by: updated.updated_by ?? "Unknown", at: updated.updated_at } : null,
    rules: await listRules(user.org_id, null),
    limits: { rules: MAX_RULES, length: MAX_RULE_LENGTH },
    workspaces,
    workspace,
    summary: isAdmin(user) ? await guardSummary(user.org_id, new Date(Date.now() - 30 * 86400_000).toISOString()) : null,
  };
});

export const PUT = handle(async (req: Request) => {
  const user = await requireUser(["Org Owner"]);
  const body = await readJson<Record<string, unknown>>(req);
  const { settings, changed } = await saveGuardSettings(user.org_id, user.name, body);
  for (const k of changed) await audit(user, `Guardrails: turned ${settings[k] ? "on" : "off"} “${SWITCHES[k].label}”`, "Policy change");
  return { ok: true, changed };
});
