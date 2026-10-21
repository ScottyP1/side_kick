/**
 * @file The setup wizard's progress (/get-started): what a new organization has done of its first-time setup.
 *
 * Concepts
 * - **Steps**, in order: `welcome`, `microsoft` (connect the Microsoft 365 tenant for sign-in), `teams`
 *   (the Teams admin makes the Sidekick app available, ideally to Team Leads and admins only), `rules`
 *   (pick a guardrails starting point) and `groups` (create the first groups with their Team Leads). Each is
 *   `done`, `skipped` or not reached yet. Some are also checked against the real state (`facts`): the
 *   Microsoft tenant is connected, the organization has groups.
 * - **Presets** for the rules step: **Standard** is the guardrail switches' own defaults; **Strict** turns
 *   every switch on (for regulated clients). Applying one goes through PUT /api/guardrails, so only the Org
 *   Owner can change the switches, exactly as on the Guardrails page.
 * - **Pending**: an organization has a setup row once someone opened the wizard (sign-up sends new owners
 *   there after checkout). Until it is finished, Org Owners and Admins see a "Finish setting up" banner.
 *   Organizations that never opened the wizard (set up before it existed) never see the banner.
 *
 * Callers: /api/setup (read and record progress) and /api/me (the banner). Both check the role.
 */
import "server-only";
import { get, now, run } from "./db";
import { SWITCHES, type SwitchKey } from "./guardrails";

/** The wizard's steps, in order. */
export const SETUP_STEPS = ["welcome", "microsoft", "teams", "rules", "groups"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export type StepState = "done" | "skipped";

/** Guardrail switch values for each starting point (see the file header). */
export const PRESETS: Record<"standard" | "strict", Record<SwitchKey, boolean>> = {
  standard: Object.fromEntries((Object.keys(SWITCHES) as SwitchKey[]).map((k) => [k, SWITCHES[k].default])) as Record<SwitchKey, boolean>,
  strict: Object.fromEntries((Object.keys(SWITCHES) as SwitchKey[]).map((k) => [k, true])) as Record<SwitchKey, boolean>,
};

/** Which preset these switch values match, or "custom". */
export function presetOf(settings: Record<SwitchKey, boolean>): "standard" | "strict" | "custom" {
  for (const p of ["standard", "strict"] as const) {
    if ((Object.keys(SWITCHES) as SwitchKey[]).every((k) => settings[k] === PRESETS[p][k])) return p;
  }
  return "custom";
}

/** The saved progress: each step's state, and when setup was finished (null = not yet). */
export async function getSetup(orgId: string): Promise<{ started: boolean; steps: Partial<Record<SetupStep, StepState>>; completedAt: string | null }> {
  const row = await get<{ json: string; completed_at: string | null }>("SELECT json, completed_at FROM org_setup WHERE org_id = ?", orgId);
  if (!row) return { started: false, steps: {}, completedAt: null };
  const saved = JSON.parse(row.json) as Record<string, unknown>;
  const steps = Object.fromEntries(SETUP_STEPS.filter((s) => saved[s] === "done" || saved[s] === "skipped").map((s) => [s, saved[s] as StepState]));
  return { started: true, steps, completedAt: row.completed_at };
}

/** Starts tracking setup for this organization (opening the wizard), keeping any progress already saved. */
export async function startSetup(orgId: string) {
  await run("INSERT INTO org_setup (org_id, json, completed_at, updated_at) VALUES (?, ?, NULL, ?) ON CONFLICT (org_id) DO NOTHING", orgId, "{}", now());
}

/** Marks one step done or skipped. */
export async function markStep(orgId: string, step: SetupStep, state: StepState) {
  await startSetup(orgId);
  const { steps } = await getSetup(orgId);
  await run("UPDATE org_setup SET json = ?, updated_at = ? WHERE org_id = ?", JSON.stringify({ ...steps, [step]: state }), now(), orgId);
}

/** Marks setup finished (the banner goes away); `false` reopens it. */
export async function finishSetup(orgId: string, finished = true) {
  await startSetup(orgId);
  await run("UPDATE org_setup SET completed_at = ?, updated_at = ? WHERE org_id = ?", finished ? now() : null, now(), orgId);
}

/** Whether to show the "Finish setting up" banner: the wizard was opened and isn't finished. */
export async function setupPending(orgId: string): Promise<boolean> {
  const s = await getSetup(orgId);
  return s.started && !s.completedAt;
}
