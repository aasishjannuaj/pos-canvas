import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";
import { LOGIN_REASON_PARAM, SESSION_EXPIRED_REASON } from "@/lib/sessionNotice";

// Feature 14.3 — /runtime protected the same way /editor already is: an
// unauthenticated visit redirects cleanly to /login instead of only being
// caught by the page-level getProjectById ownership check (which would
// otherwise just 404 rather than offer a sign-in path).
const PROTECTED_PREFIXES = ["/dashboard", "/editor", "/runtime"];
const AUTH_PAGES = ["/login", "/signup"];

function copyCookies(from: NextResponse, to: NextResponse) {
  from.cookies.getAll().forEach((cookie) => {
    to.cookies.set(cookie);
  });
}

export default async function proxy(request: NextRequest) {
  const { supabaseResponse, claims } = await updateSession(request);

  const pathname = request.nextUrl.pathname;

  const isProtectedRoute = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
  const isAuthPage = AUTH_PAGES.includes(pathname);

  if (isProtectedRoute && !claims) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";

    // Feature 22 Phase 4 — say why. An owner who was working and is suddenly
    // looking at a sign-in form has no way to tell an expired session from a
    // broken app; the sign-in page renders one fixed sentence for this code.
    //
    // The original query string is DROPPED rather than carried over. Two
    // reasons: whatever the owner was doing may be in it, and it must not end
    // up in a sign-in URL; and clearing it first means this redirect can carry
    // exactly one parameter, defined here, rather than anything an inbound link
    // happened to contain. Nothing records where they were going — resuming
    // after sign-in would need a destination parameter, and this phase
    // deliberately does not accept one.
    redirectUrl.search = "";
    redirectUrl.searchParams.set(LOGIN_REASON_PARAM, SESSION_EXPIRED_REASON);

    const redirectResponse = NextResponse.redirect(redirectUrl);
    copyCookies(supabaseResponse, redirectResponse);
    return redirectResponse;
  }

  if (isAuthPage && claims) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/dashboard";
    // Cleared for the same reason as above, and because the sign-in page can
    // now carry a reason code: a signed-in visitor must not be bounced to
    // /dashboard still wearing an expired-session parameter.
    redirectUrl.search = "";
    const redirectResponse = NextResponse.redirect(redirectUrl);
    copyCookies(supabaseResponse, redirectResponse);
    return redirectResponse;
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/editor/:path*",
    "/runtime/:path*",
    "/login",
    "/signup",
  ],
};
