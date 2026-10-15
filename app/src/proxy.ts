import { NextResponse, type NextRequest } from "next/server";

// Optimistic check only: sends people without a session cookie to sign-in.
// Every API route still verifies the session and permissions on the server.
export function proxy(request: NextRequest) {
  if (!request.cookies.get("sk_session")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|login|setup|_next|favicon.ico).*)"],
};
