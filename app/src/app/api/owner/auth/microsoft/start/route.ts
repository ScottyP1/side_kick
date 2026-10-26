/**
 * GET /api/owner/auth/microsoft/start: sends the browser to Microsoft to sign in to the Owner Console (the
 * "Sign in with Microsoft" button on /owner/login). Anyone may start it; only the accounts listed in
 * `SIDEKICK_OWNER_MS_ACCOUNTS` get through the callback (lib/owner.ts). The round trip is the portal's
 * (lib/entra.ts: PKCE, state, nonce) with its own mode ("owner"), cookie and callback address, so it can only
 * ever end in an Owner Console session.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { handle } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { startMicrosoftSignIn } from "@/lib/entra";
import { OWNER_OIDC_COOKIE, ownerMicrosoftEnabled } from "@/lib/owner";

export const GET = handle(async (req: Request) => {
  if (!ownerMicrosoftEnabled()) throw new HttpError(503, "Microsoft sign-in isn't set up for the Owner Console. Use another way to sign in.");
  const { url, state } = await startMicrosoftSignIn(req, "owner", { next: "/owner" });
  // Lax so the cookie comes back on Microsoft's redirect (a top-level GET), and only to the owner callback.
  (await cookies()).set(OWNER_OIDC_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/owner/auth/microsoft", maxAge: 600 });
  return NextResponse.redirect(url);
}, { system: "Owner Console Microsoft sign-in" });
