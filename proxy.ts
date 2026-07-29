import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

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
    const redirectResponse = NextResponse.redirect(redirectUrl);
    copyCookies(supabaseResponse, redirectResponse);
    return redirectResponse;
  }

  if (isAuthPage && claims) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/dashboard";
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
