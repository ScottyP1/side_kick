/**
 * GET /api/owner/auth/microsoft/callback: where Microsoft sends the browser back after an Owner Console sign-in
 * (registered on the Entra app as a Web redirect URI next to the portal's). Steps:
 * 1. Verify the reply (lib/entra.ts `finishMicrosoftSignIn` with flow "owner": a portal sign-in is refused here).
 * 2. The account must be listed in `SIDEKICK_OWNER_MS_ACCOUNTS` by tenant id + object id; anyone else gets one
 *    plain refusal (no hint about who is allowed) and an operator-log entry naming the account that tried.
 * 3. If the token lists sign-in methods (`amr`) without MFA, refuse (lib/owner.ts `ownerMfaEvidence`).
 * 4. Find, link or create the owner row (`ownerForMicrosoft`).
 * 5. With a passkey registered, ask for it first (the second-step cookie, then /owner/login?step=passkey);
 *    otherwise start the Owner Console session (`startOwnerSession`, never a portal session) and open /owner.
 * Success answers with a same-site handoff page (lib/owner.ts `sameSiteHandoff`), not a redirect: the strict
 * `sk_owner` cookie isn't sent on a redirect chain that started at Microsoft, which used to bounce the owner to
 * /owner/login once. Problems never fail silently: the browser lands on /owner/login with the reason (a flash cookie, lib/flash.ts).
 * Logged in the operator log: sign-ins, links, new owner rows and every refusal.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { errorMessageFor, handle } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { FLASH_COOKIE, FLASH_SECONDS } from "@/lib/flash";
import { finishMicrosoftSignIn, redirectUri } from "@/lib/entra";
import { secondFactorMethods, startSecondStep } from "@/lib/mfa";
import { setSecondStepCookie } from "@/lib/mfa-routes";
import { OWNER_MS_REFUSED, OWNER_OIDC_COOKIE, ownerForMicrosoft, ownerMfaEvidence, ownerMicrosoftAllowed, ownerMicrosoftEnabled, platformLog, sameSiteHandoff, startOwnerSession } from "@/lib/owner";

export const GET = handle(async (req: Request) => {
  const jar = await cookies();
  const cookieState = jar.get(OWNER_OIDC_COOKIE)?.value;
  jar.delete({ name: OWNER_OIDC_COOKIE, path: "/api/owner/auth/microsoft" });
  const go = (path: string) => NextResponse.redirect(new URL(path, redirectUri(req, "owner")));
  try {
    if (!ownerMicrosoftEnabled()) throw new HttpError(503, "Microsoft sign-in isn't set up for the Owner Console. Use another way to sign in.");
    const { who } = await finishMicrosoftSignIn(req, cookieState, "owner");
    const account = `${who.email || "no email"} (tenant ${who.tenantId}, object id ${who.objectId})`.slice(0, 300);
    if (!ownerMicrosoftAllowed(who)) {
      await platformLog("System", `Refused Owner Console sign-in with Microsoft: ${account} isn't an allowed operator account`);
      throw new HttpError(403, OWNER_MS_REFUSED);
    }
    const mfa = ownerMfaEvidence(who.amr);
    if (mfa === "none") {
      await platformLog("System", `Refused Owner Console sign-in with Microsoft for ${account}: Microsoft says no MFA was used`);
      throw new HttpError(403, "Microsoft says this sign-in didn't use multi-factor authentication (MFA). Sign in again with MFA.");
    }
    const { owner, created, linked } = await ownerForMicrosoft(who);
    if (created) await platformLog(owner.name, `Created the owner account ${owner.email} from Microsoft sign-in`);
    if (linked) await platformLog(owner.name, `Linked the owner account ${owner.email} to their Microsoft account`);
    const how = mfa === "mfa" ? "Microsoft, MFA confirmed" : "Microsoft; the token doesn't list the method, tenant policy requires MFA";
    if ((await secondFactorMethods("owner", owner.id)).includes("passkey")) {
      await setSecondStepCookie("owner", await startSecondStep("owner", owner.id));
      await platformLog(owner.name, `Owner Console sign-in with ${how}: waiting for their passkey`);
      return sameSiteHandoff("/owner/login?step=passkey");
    }
    await startOwnerSession(owner.id);
    await platformLog(owner.name, `Signed in to the Owner Console (${how})`);
    return sameSiteHandoff("/owner");
  } catch (e) {
    const message = await errorMessageFor(req, e);
    // The message travels in a short-lived cookie, not the address, so a link can't put its own words on the page.
    jar.set(FLASH_COOKIE, message, { path: "/", maxAge: FLASH_SECONDS, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    return go("/owner/login?error=1");
  }
}, { system: "Owner Console Microsoft sign-in" });
