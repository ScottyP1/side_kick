/**
 * GET /api/auth/microsoft/callback: where Microsoft sends the browser back after sign-in.
 * Verifies the reply (lib/entra.ts), then either:
 * - signs the person in: their Microsoft tenant must be connected to a Sidekick organization and they
 *   must have been added there (matched by Microsoft account id, or by email the first time); or
 * - (mode "link") connects the Org Owner's organization to their Microsoft tenant.
 * Problems never fail silently: the browser lands on the sign-in page (or Settings) with the reason.
 * Audited: "Signed in with Microsoft", "Connected Microsoft sign-in".
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { errorMessageFor, handle } from "@/lib/api";
import { audit, HttpError, startSession } from "@/lib/auth";
import { get, run } from "@/lib/db";
import { FLASH_COOKIE, FLASH_SECONDS } from "@/lib/flash";
import { finishMicrosoftSignIn, OIDC_COOKIE, redirectUri, safeNext, type MicrosoftIdentity } from "@/lib/entra";

export const GET = handle(async (req: Request) => {
  const jar = await cookies();
  const cookieState = jar.get(OIDC_COOKIE)?.value;
  jar.delete({ name: OIDC_COOKIE, path: "/api/auth/microsoft" });
  const go = (path: string) => NextResponse.redirect(new URL(path, redirectUri(req)));
  let mode: "signin" | "link" = "signin";
  try {
    const { who, saved } = await finishMicrosoftSignIn(req, cookieState);
    mode = saved.mode;
    if (saved.mode === "link") {
      await connectTenant(saved.user_id, who);
      return go("/settings?microsoft=connected");
    }
    const userId = await signInAs(who);
    await startSession(userId);
    return go(safeNext(saved.next_path));
  } catch (e) {
    const message = await errorMessageFor(req, e);
    // The message travels in a short-lived cookie, not the address, so a link can't put its own words on the page (lib/flash.ts).
    jar.set(FLASH_COOKIE, message, { path: "/", maxAge: FLASH_SECONDS, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    return go(`${mode === "link" ? "/settings" : "/login"}?error=1`);
  }
});

/** Finds the Sidekick person for this Microsoft account, remembering their account id on first sign-in. */
async function signInAs(who: MicrosoftIdentity): Promise<string> {
  const org = await get<{ id: string; name: string; status: string }>("SELECT id, name, status FROM orgs WHERE entra_tenant_id = ?", who.tenantId);
  if (!org) throw new HttpError(403, "Your Microsoft organization isn't connected to Sidekick yet. Ask your Org Owner to connect it in Settings, or sign in with your email and password.");
  if (org.status === "Suspended") throw new HttpError(403, "This organization's Sidekick access is paused. Contact the Sidekick team.");
  let user = await get<{ id: string; org_id: string; name: string }>("SELECT id, org_id, name FROM users WHERE org_id = ? AND entra_oid = ?", org.id, who.objectId);
  if (!user && who.email) {
    user = await get<{ id: string; org_id: string; name: string }>("SELECT id, org_id, name FROM users WHERE org_id = ? AND lower(email) = ? AND entra_oid IS NULL", org.id, who.email);
    if (user) await run("UPDATE users SET entra_oid = ? WHERE id = ?", who.objectId, user.id);
  }
  if (!user) throw new HttpError(403, `You haven't been added to ${org.name} in Sidekick yet. Ask an Org Admin to add ${who.email || "your work email"} on Users & access.`);
  // Microsoft handles the password now, so a pending "pick a new password" step no longer applies.
  await run("UPDATE users SET must_change_password = 0 WHERE id = ?", user.id);
  await audit(user, "Signed in with Microsoft", "Sign-in");
  return user.id;
}

/** Connects the Org Owner's organization to the Microsoft tenant they just signed in with. */
async function connectTenant(userId: string | null, who: MicrosoftIdentity) {
  const owner = userId ? await get<{ id: string; org_id: string; name: string; role: string }>("SELECT id, org_id, name, role FROM users WHERE id = ?", userId) : undefined;
  if (!owner || owner.role !== "Org Owner") throw new HttpError(403, "Only an Org Owner can connect Microsoft sign-in.");
  const taken = await get<{ id: string }>("SELECT id FROM orgs WHERE entra_tenant_id = ? AND id <> ?", who.tenantId, owner.org_id);
  if (taken) throw new HttpError(409, "That Microsoft organization is already connected to another Sidekick organization. Contact the Sidekick team.");
  const org = await get<{ entra_tenant_id: string | null }>("SELECT entra_tenant_id FROM orgs WHERE id = ?", owner.org_id);
  if (org?.entra_tenant_id && org.entra_tenant_id !== who.tenantId) {
    throw new HttpError(409, "This organization is already connected to a different Microsoft organization. Disconnect it first.");
  }
  await run("UPDATE orgs SET entra_tenant_id = ? WHERE id = ?", who.tenantId, owner.org_id);
  await run("UPDATE users SET entra_oid = NULL WHERE org_id = ? AND entra_oid = ? AND id <> ?", owner.org_id, who.objectId, owner.id);
  await run("UPDATE users SET entra_oid = ? WHERE id = ?", who.objectId, owner.id);
  await audit(owner, `Connected Microsoft sign-in (tenant ${who.tenantId})`, "Policy change");
}
