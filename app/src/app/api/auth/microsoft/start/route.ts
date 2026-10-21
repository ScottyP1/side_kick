/**
 * GET /api/auth/microsoft/start: sends the browser to Microsoft to sign in (the "Sign in with Microsoft"
 * button). `?next=/path` says where to go afterwards.
 * `?mode=link` (Org Owners, signed in): connect this organization to the Microsoft tenant of the account
 * they sign in with, from Settings. See lib/entra.ts for how the round trip is protected.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { handle } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { OIDC_COOKIE, startMicrosoftSignIn } from "@/lib/entra";

export const GET = handle(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const mode = q.get("mode") === "link" ? "link" : "signin";
  const owner = mode === "link" ? await requireUser(["Org Owner"]) : null;
  const { url, state } = await startMicrosoftSignIn(req, mode, { userId: owner?.id, next: mode === "link" ? (q.get("next") === "/get-started" ? "/get-started" : "/settings") : q.get("next") });
  // Lax so the cookie comes back on Microsoft's redirect (a top-level GET), but not on other sites' requests.
  (await cookies()).set(OIDC_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/auth/microsoft", maxAge: 600 });
  return NextResponse.redirect(url);
});
