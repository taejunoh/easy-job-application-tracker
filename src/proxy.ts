import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  SESSION_COOKIE_NAME,
  getSessionCookieOptions,
  verifySessionToken,
} from "@/lib/security/auth";
import { sanitizeReturnPath } from "@/lib/return-path";

export function proxy(request: NextRequest): NextResponse {
  const session = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const authenticated = verifySessionToken(session);

  if (request.nextUrl.pathname === "/connect") {
    const response = authenticated
      ? redirectTo(request, "/")
      : NextResponse.next();
    return clearInvalidSession(response, session, authenticated);
  }

  const response = authenticated
    ? NextResponse.next()
    : redirectToConnect(request);
  return clearInvalidSession(response, session, authenticated);
}

function redirectTo(request: NextRequest, pathname: string): NextResponse {
  const destination = request.nextUrl.clone();
  destination.pathname = pathname;
  destination.search = "";
  return NextResponse.redirect(destination);
}

function redirectToConnect(request: NextRequest): NextResponse {
  const destination = request.nextUrl.clone();
  const requestedPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const returnPath = sanitizeReturnPath(requestedPath) ?? "/";
  destination.pathname = "/connect";
  destination.search = "";
  destination.searchParams.set("next", returnPath);
  return NextResponse.redirect(destination);
}

function clearInvalidSession(
  response: NextResponse,
  session: string | undefined,
  authenticated: boolean,
): NextResponse {
  if (session !== undefined && !authenticated) {
    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: "",
      ...getSessionCookieOptions(),
      maxAge: 0,
    });
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!api(?:/|$)|_next/static(?:/|$)|_next/image(?:/|$)|(?:favicon\\.ico|file\\.svg|globe\\.svg|next\\.svg|vercel\\.svg|window\\.svg)$).*)",
  ],
};
