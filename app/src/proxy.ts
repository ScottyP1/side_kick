import { NextResponse, type NextRequest } from "next/server";

/**
 * @file Runs before every page request (Next.js 16 renamed "middleware" to "proxy").
 *
 * Optimistic check only: it sends people without a session cookie to the right sign-in page (client
 * portal or Owner Console). The public pages (pricing, sign-up, privacy, terms, support) need no sign-in and
 * are skipped too; checkout isn't (it pays for a signed-in organization). It does not check that the cookie is valid; every API route still verifies
 * the session and permissions on the server. API routes, sign-in pages and static files are skipped
 * (see `matcher`), which is also why the Teams bot endpoint /api/messages is never redirected.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/owner")) {
    if (pathname === "/owner/login" || pathname === "/owner/setup") return NextResponse.next();
    if (!request.cookies.get("sk_owner")) return NextResponse.redirect(new URL("/owner/login", request.url));
    return NextResponse.next();
  }
  if (!request.cookies.get("sk_session")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|login|setup|pricing|signup|privacy|terms|support|_next|favicon.ico).*)"],
};
