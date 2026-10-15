import { NextResponse, type NextRequest } from "next/server";

// Optimistic check only: sends people without a session cookie to the right sign-in page.
// Every API route still verifies the session and permissions on the server.
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
  matcher: ["/((?!api|login|setup|_next|favicon.ico).*)"],
};
