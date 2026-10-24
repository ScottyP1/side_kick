import { NextResponse, type NextRequest } from "next/server";

/**
 * @file Runs before every page request (Next.js 16 renamed "middleware" to "proxy").
 *
 * Optimistic check only: it sends people without a session cookie to the right sign-in page (client
 * portal or Owner Console). The public website (lib/site.ts `PUBLIC_PAGES`: home, features, how it works,
 * security, pricing, FAQ, the /docs help center, support, changelog, sign-up, privacy, terms, plus robots.txt and
 * sitemap.xml, and the website's pictures in public/site/) needs no sign-in and is skipped too, as are the installable
 * app's manifest and icons (/manifest.webmanifest, /app-icons/: browsers fetch them without cookies; lib/pwa.ts), and the
 * Teams tab pages (/teams/: they sign in with Teams single sign-on, never a cookie; lib/teams/tab.ts); checkout isn't
 * (it pays for a signed-in organization).
 *
 * `/` is the one shared address: visitors get the website, and anyone with a portal session cookie is sent
 * to the portal home at `/home` (sign-in and Microsoft sign-in still land on `/`, so they arrive there too).
 * A stale cookie lands on /home, whose frame sends the person on to sign in.
 *
 * It does not check that the cookie is valid; every API route still verifies
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
  if (pathname === "/") {
    return request.cookies.get("sk_session") ? NextResponse.redirect(new URL("/home", request.url)) : NextResponse.next();
  }
  if (!request.cookies.get("sk_session")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Keep the public names in step with lib/site.ts PUBLIC_PAGES (a test checks each answers without a session).
  matcher: ["/((?!api|login|setup|pricing|signup|privacy|terms|support|features|how-it-works|security|faq|docs|changelog|robots.txt|sitemap.xml|manifest.webmanifest|app-icons/|site/|teams/|_next|favicon.ico).*)"],
};
