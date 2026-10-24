/**
 * GET /api/connectors/start?kind=ado&site=<ADO organization> | ?kind=jira|confluence[&site=<Atlassian site>] |
 * ?kind=github (no site: repositories come from the GitHub App's installations) | ?kind=m365 (no site: the
 * organization's own Microsoft tenant, when it linked one, is the only one allowed): sends the browser to
 * the tool's sign-in to connect it for the organization, read-only (Org Owners and Org Admins). Refused with the
 * plan's upgrade message when a new tool would go past the plan's connectors limit. Problems land back on
 * /connectors with the reason (a short-lived message cookie, lib/flash.ts), never in the address.
 * See lib/connectors.ts (`startConnect`) for how the round trip is protected.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { errorMessageFor, handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { CONNECTOR_COOKIE, startConnect } from "@/lib/connectors";
import { FLASH_COOKIE, FLASH_SECONDS } from "@/lib/flash";

export const GET = handle(async (req: Request) => {
  const user = await requireUser(["Org Owner", "Org Admin"]);
  const q = new URL(req.url).searchParams;
  const jar = await cookies();
  try {
    const { url, state } = await startConnect(req, user, q.get("kind"), q.get("site"));
    // Lax so the cookie comes back on the tool's redirect (a top-level GET), but not on other sites' requests.
    jar.set(CONNECTOR_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/connectors", maxAge: 600 });
    return NextResponse.redirect(url);
  } catch (e) {
    jar.set(FLASH_COOKIE, await errorMessageFor(req, e), { path: "/", maxAge: FLASH_SECONDS, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    return NextResponse.redirect(new URL("/connectors?error=1", req.url));
  }
});
