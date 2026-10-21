/**
 * GET /api/auth/microsoft/consent: "Approve Sidekick for your organization". Sends the browser to Microsoft's
 * admin-consent page for the org's own Microsoft tenant (Org Owners and Org Admins; the org must be connected
 * to Microsoft first). A Microsoft admin of that tenant approves there; Microsoft then returns to
 * /api/auth/microsoft/callback, which records it (lib/directory.ts). Problems land on Users & access with the reason.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { errorMessageFor, handle } from "@/lib/api";
import { OIDC_COOKIE, redirectUri } from "@/lib/entra";
import { startAdminConsent } from "@/lib/directory";

export const GET = handle(async (req: Request) => {
  try {
    const { url, state } = await startAdminConsent(req);
    (await cookies()).set(OIDC_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/auth/microsoft", maxAge: 900 });
    return NextResponse.redirect(url);
  } catch (e) {
    return NextResponse.redirect(new URL(`/users?error=${encodeURIComponent(await errorMessageFor(req, e))}`, redirectUri(req)));
  }
});
