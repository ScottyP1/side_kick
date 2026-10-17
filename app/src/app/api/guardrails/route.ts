/**
 * /api/guardrails: the organization's guardrails (see lib/guardrails.ts).
 *
 * GET  Who: anyone signed in. Returns the locked floor, the org-wide switches and whether they're on,
 *      who last changed them, `canEdit` (Org Owner only), and for Org Owners/Admins a 30-day `summary`
 *      of how often each rule fired (counts only, no question or answer text).
 * PUT  { [switch]: boolean, ... } Who: the Org Owner. Each change is written to the audit log as a
 *      policy change. Unknown switch names are ignored; the locked floor can't be changed at all.
 */
import { handle, readJson } from "@/lib/api";
import { audit, isAdmin, requireUser } from "@/lib/auth";
import { get } from "@/lib/db";
import { FLOOR, getGuardSettings, guardSummary, saveGuardSettings, SWITCHES, type SwitchKey } from "@/lib/guardrails";

export const GET = handle(async () => {
  const user = await requireUser();
  const settings = await getGuardSettings(user.org_id);
  const updated = await get<{ updated_by: string | null; updated_at: string }>("SELECT updated_by, updated_at FROM guard_rules WHERE org_id = ?", user.org_id);
  return {
    floor: FLOOR,
    switches: (Object.keys(SWITCHES) as SwitchKey[]).map((key) => ({ key, label: SWITCHES[key].label, help: SWITCHES[key].help, on: settings[key] })),
    canEdit: user.role === "Org Owner",
    updated: updated ? { by: updated.updated_by ?? "Unknown", at: updated.updated_at } : null,
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
