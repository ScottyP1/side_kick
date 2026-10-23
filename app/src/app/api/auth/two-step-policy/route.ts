/**
 * GET/PATCH /api/auth/two-step-policy: the organization's "Require two-step sign-in for everyone" switch
 * (Settings → Two-step sign-in for everyone).
 * - GET (anyone signed in): whether it's on, whether the org requires Microsoft sign-in instead (then the
 *   switch isn't needed), whether the caller may change it (Org Owner), and for Org Owners/Admins how many
 *   people have no authenticator app or passkey yet (they'd be asked to set one up at their next password
 *   sign-in or page load).
 * - PATCH { required: boolean } (Org Owner only): turns it on or off. Audited as a policy change. Works while
 *   the owner's own second step is still waiting to be set up (an owner who just turned it on can turn it off
 *   again; that's no weaker than letting them set up their own second step).
 * What "required" does is in lib/auth.ts (`needs_two_step`): people who signed in with a password and have
 * no second step are asked to set one up before anything else works; Microsoft sign-in is exempt.
 */
import { handle, readJson } from "@/lib/api";
import { audit, isAdmin, requireUser } from "@/lib/auth";
import { get, run } from "@/lib/db";

export const GET = handle(async () => {
  const user = await requireUser();
  const org = await get<{ mfa_required: number; sso_required: number }>("SELECT mfa_required, sso_required FROM orgs WHERE id = ?", user.org_id);
  const without = isAdmin(user)
    ? await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM users u WHERE u.org_id = ?
         AND NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_kind = 'user' AND f.account_id = u.id AND f.enabled = 1)`,
      user.org_id,
    )
    : null;
  return {
    required: Number(org?.mfa_required) === 1,
    microsoftRequired: Number(org?.sso_required) === 1,
    canManage: user.role === "Org Owner",
    withoutTwoStep: without ? Number(without.n) : null,
  };
});

export const PATCH = handle(async (req: Request) => {
  const user = await requireUser(["Org Owner"], { allowPendingTwoStep: true });
  const { required } = await readJson<{ required?: boolean }>(req);
  await run("UPDATE orgs SET mfa_required = ? WHERE id = ?", required ? 1 : 0, user.org_id);
  await audit(user, required ? "Required two-step sign-in for everyone (password sign-ins)" : "Stopped requiring two-step sign-in", "Policy change");
  return { ok: true, required: Boolean(required) };
});
