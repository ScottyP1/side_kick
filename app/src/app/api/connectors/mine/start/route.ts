/**
 * GET /api/connectors/mine/start?connector=<id>: "Connect your Jira" (or Azure DevOps): sends the browser to the
 * tool's sign-in so the person connects **their own** account to a group connection in "each person signs in" mode.
 * Anyone who may see that group (Viewers too). Comes back through /api/connectors/callback (same redirect address as
 * group connections) and lands on /knowledge; problems land on /knowledge?error=1 with the reason in a short-lived
 * message cookie (lib/flash.ts), never in the address. See lib/connectors.ts (`startPersonalConnect`).
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { errorMessageFor, handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { CONNECTOR_BACK_COOKIE, CONNECTOR_COOKIE, startPersonalConnect } from "@/lib/connectors";
import { FLASH_COOKIE, FLASH_SECONDS } from "@/lib/flash";

export const GET = handle(async (req: Request) => {
  const user = await requireUser();
  const jar = await cookies();
  const secure = process.env.NODE_ENV === "production";
  try {
    const { url, state } = await startPersonalConnect(req, user, new URL(req.url).searchParams.get("connector"));
    // Lax so the cookies come back on the tool's redirect (a top-level GET), but not on other sites' requests.
    jar.set(CONNECTOR_COOKIE, state, { httpOnly: true, sameSite: "lax", secure, path: "/api/connectors", maxAge: 600 });
    jar.set(CONNECTOR_BACK_COOKIE, "knowledge", { httpOnly: true, sameSite: "lax", secure, path: "/api/connectors", maxAge: 600 });
    return NextResponse.redirect(url);
  } catch (e) {
    jar.set(FLASH_COOKIE, await errorMessageFor(req, e), { path: "/", maxAge: FLASH_SECONDS, sameSite: "lax", secure });
    return NextResponse.redirect(new URL("/knowledge?error=1#signins", req.url));
  }
});
