/**
 * GET /api/connectors/callback: where Microsoft sign-in (Azure DevOps, Microsoft 365 files), Atlassian (Jira, Confluence) and GitHub send the browser back after
 * connecting a tool. Finishes the connection (lib/connectors.ts `finishConnect`: state + browser cookie checked,
 * code swapped for tokens, tokens sealed, saved for the group that started it) and lands on /connectors?connected=<tool>, or on /connectors?error=1
 * with the reason in a short-lived message cookie (lib/flash.ts). Audited ("Connected Azure DevOps …").
 * This address must be registered on each tool's app (docs/RUNBOOKS.md → Connector apps).
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { errorMessageFor, handle } from "@/lib/api";
import { CONNECTOR_COOKIE, connectorRedirectUri, finishConnect } from "@/lib/connectors";
import { FLASH_COOKIE, FLASH_SECONDS } from "@/lib/flash";

export const GET = handle(async (req: Request) => {
  const jar = await cookies();
  const cookieState = jar.get(CONNECTOR_COOKIE)?.value;
  jar.delete({ name: CONNECTOR_COOKIE, path: "/api/connectors" });
  const go = (path: string) => NextResponse.redirect(new URL(path, connectorRedirectUri(req)));
  try {
    const done = await finishConnect(req, cookieState);
    return go(`/connectors?connected=${done.kind}#tool-${done.kind}`);
  } catch (e) {
    jar.set(FLASH_COOKIE, await errorMessageFor(req, e), { path: "/", maxAge: FLASH_SECONDS, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
    return go("/connectors?error=1");
  }
});
