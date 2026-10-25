/**
 * GET /api/auth/microsoft/consent: "Approve Sidekick for your organization". Sends the browser to Microsoft's
 * admin-consent page for the org's own Microsoft tenant (Org Owners and Org Admins; the org must be connected
 * to Microsoft first). A Microsoft admin of that tenant approves there; Microsoft then returns to
 * /api/auth/microsoft/callback, which records it (lib/directory.ts). Problems land on Users & access with the reason (in a one-time cookie, lib/flash.ts).
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { errorMessageFor, handle } from "@/lib/api";
import { OIDC_COOKIE, redirectUri } from "@/lib/entra";
import { FLASH_COOKIE, FLASH_SECONDS } from "@/lib/flash";
import { startAdminConsent } from "@/lib/directory";

export const GET = handle(async (req: Request) => {
  try {
    const { url, state } = await startAdminConsent(req);
    (await cookies()).set(OIDC_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/auth/microsoft", maxAge: 900 });
    return NextResponse.redirect(url);
  } catch (e) {
    // The reason goes in a one-time cookie, never the address (lib/flash.ts).
    (await cookies()).set(FLASH_COOKIE, await errorMessageFor(req, e), { path: "/", maxAge: FLASH_SECONDS, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    return NextResponse.redirect(new URL("/users?error=1", redirectUri(req)));
  }
}, { system: "Microsoft sign-in" });
