/**
 * GET /api/connectors/start?ws=<group>&kind=ado&site=<ADO organization> | &kind=jira|confluence[&site=<Atlassian site>] |
 * &kind=github (no site: repositories come from the GitHub App's installations) | &kind=m365 (no site: whichever
 * Microsoft organization the account signs in to, usually the client's): sends the browser to the tool's sign-in to
 * connect it **for that group**, read-only, with the account the client gave the team (or to reconnect the group's
 * connection). The group's Team Lead, or an Org Owner/Admin for any group; the tool type must be allowed in the
 * organization. Problems land back on /connectors with the reason (a short-lived message cookie, lib/flash.ts),
 * never in the address.
 * See lib/connectors.ts (`startConnect`) for how the round trip is protected.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { errorMessageFor, handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { CONNECTOR_COOKIE, startConnect } from "@/lib/connectors";
import { FLASH_COOKIE, FLASH_SECONDS } from "@/lib/flash";

export const GET = handle(async (req: Request) => {
  const user = await requireUser(["Org Owner", "Org Admin", "Team Lead"]);
  const q = new URL(req.url).searchParams;
  const jar = await cookies();
  try {
    const { url, state } = await startConnect(req, user, q.get("kind"), q.get("site"), q.get("ws"));
    // Lax so the cookie comes back on the tool's redirect (a top-level GET), but not on other sites' requests.
    jar.set(CONNECTOR_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/connectors", maxAge: 600 });
    return NextResponse.redirect(url);
  } catch (e) {
    jar.set(FLASH_COOKIE, await errorMessageFor(req, e), { path: "/", maxAge: FLASH_SECONDS, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    return NextResponse.redirect(new URL("/connectors?error=1", req.url));
  }
});
