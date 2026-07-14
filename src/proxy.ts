import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  SESSION_COOKIE_NAME,
  verifySessionToken,
} from "@/lib/security/auth";

export function proxy(request: NextRequest): NextResponse {
  const session = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const authenticated = verifySessionToken(session);

  if (request.nextUrl.pathname === "/connect") {
    return authenticated ? redirectTo(request, "/") : NextResponse.next();
  }

  return authenticated
    ? NextResponse.next()
    : redirectTo(request, "/connect");
}

function redirectTo(request: NextRequest, pathname: string): NextResponse {
  const destination = request.nextUrl.clone();
  destination.pathname = pathname;
  destination.search = "";
  return NextResponse.redirect(destination);
}

export const config = {
  matcher: [
    "/((?!api(?:/|$)|_next/static(?:/|$)|_next/image(?:/|$)|favicon\\.ico$|.*\\.[^/]+$).*)",
  ],
};
