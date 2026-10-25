/**
 * GET/POST /api/signup: self-service sign-up (lib/signup.ts).
 * GET (anyone): whether sign-up is open, for the /signup page.
 * POST (anyone, not signed in): { org, name, email, password, plan } creates the organization, its Org Owner
 * and a free-trial subscription, signs the person in, and returns where to pay (`next`, the checkout page).
 * Refused when the Sidekick team has switched sign-up off (403), after too many attempts from one network
 * address (429), for an email that already has an account (409) or invalid fields (400).
 */
import { handle, readJson } from "@/lib/api";
import { startSession } from "@/lib/auth";
import { provider } from "@/lib/billing";
import { clientIp } from "@/lib/login-limit";
import { signUp, signupOpen, type SignUpInput } from "@/lib/signup";
import type { PlanId } from "@/lib/plans";

export const GET = handle(async () => ({ open: await signupOpen(), testMode: provider().testMode }));

export const POST = handle(async (req: Request) => {
  const body = await readJson<SignUpInput>(req);
  // The browser can't claim a Microsoft identity: that only comes from a verified Microsoft sign-in (later).
  const { orgId, userId, plan } = await signUp({ ...body, microsoft: undefined }, await clientIp());
  await startSession(userId);
  return { ok: true, next: await provider().checkoutUrl(orgId, plan as PlanId) };
}, { system: "sign-up" });
