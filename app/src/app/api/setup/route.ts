/**
 * GET/PUT /api/setup: the setup wizard's progress (lib/setup.ts) for this organization.
 * Who: Org Owners and Org Admins. GET also starts tracking (so the "Finish setting up" banner appears until
 * it's finished) and returns the real state the wizard checks: whether Microsoft sign-in is connected, how
 * many groups exist, the people who can be picked as a group's Team Lead, which guardrails starting point
 * matches the current switches, both presets' switch values, and whether this person may change switches
 * (the Org Owner) and pay (Org Owner / Billing Admin; see /api/billing).
 * PUT { step, state: "done" | "skipped" } records a step; { finished: true | false } finishes or reopens setup.
 * Finishing is in the audit log.
 */
import { handle, readJson } from "@/lib/api";
import { audit, HttpError, requireUser } from "@/lib/auth";
import { all, get } from "@/lib/db";
import { getGuardSettings, SWITCHES, type SwitchKey } from "@/lib/guardrails";
import { finishSetup, getSetup, markStep, presetOf, PRESETS, SETUP_STEPS, startSetup, type SetupStep } from "@/lib/setup";

export const GET = handle(async () => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  await startSetup(user.org_id);
  const org = await get<{ name: string; entra_tenant_id: string | null }>("SELECT name, entra_tenant_id FROM orgs WHERE id = ?", user.org_id);
  const groups = Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM workspaces WHERE org_id = ?", user.org_id))?.n ?? 0);
  const people = await all<{ id: string; name: string; email: string; role: string }>(
    "SELECT id, name, email, role FROM users WHERE org_id = ? AND role IN ('Team Lead', 'Member', 'Viewer') ORDER BY name",
    user.org_id,
  );
  const switches = await getGuardSettings(user.org_id);
  return {
    ...(await getSetup(user.org_id)),
    org: org?.name ?? "",
    facts: { microsoftConnected: Boolean(org?.entra_tenant_id), groups },
    people,
    rules: {
      current: presetOf(switches),
      presets: PRESETS,
      labels: Object.fromEntries((Object.keys(SWITCHES) as SwitchKey[]).map((k) => [k, SWITCHES[k].label])),
      canChange: user.role === "Org Owner",
    },
    canConnectMicrosoft: user.role === "Org Owner",
  };
});

export const PUT = handle(async (req: Request) => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const body = await readJson<{ step?: string; state?: string; finished?: boolean }>(req);
  if (typeof body.finished === "boolean") {
    await finishSetup(user.org_id, body.finished);
    await audit(user, body.finished ? "Finished setting up Sidekick" : "Reopened Sidekick setup", "Access");
  } else {
    if (!SETUP_STEPS.includes(body.step as SetupStep)) throw new HttpError(400, `Unknown setup step. Use one of: ${SETUP_STEPS.join(", ")}.`);
    if (body.state !== "done" && body.state !== "skipped") throw new HttpError(400, "A step is either done or skipped.");
    await markStep(user.org_id, body.step as SetupStep, body.state);
  }
  return getSetup(user.org_id);
});
