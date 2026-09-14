import type { MetadataRoute } from "next";
import {
  APPLICATION_PATH_PREFIXES,
  NON_PAGE_PATH_PREFIXES,
  absoluteUrl,
} from "@/lib/seo";

// Lane 3 Task 3 — robots.txt.
//
// THIS IS NOT ACCESS CONTROL, and nothing here is relied on as such. The
// application surfaces below are protected by proxy.ts (which redirects an
// unauthenticated request to /login) and by row-level security on every read.
// robots.txt is a request to well-behaved crawlers and is ignored by everything
// else; treating it as a fence would be a security bug, not a search decision.
//
// WHAT IT DOES: saves crawl budget on pages that would only ever return a
// redirect, and points crawlers at the sitemap.
//
// WHAT IT DELIBERATELY DOES NOT DISALLOW: /login, /signup, /forgot-password,
// /reset-password and /device. Those are publicly reachable and are kept out of
// the index by `noindex` metadata instead — and a crawler must be able to fetch
// a page to read that directive. Disallowing them here would hide the very
// instruction that removes them, and the URLs could still be indexed from
// inbound links.
//
// The rules are built from the prefix lists in lib/seo.ts rather than retyped,
// so the sitemap, the page-level robots metadata and this file cannot drift
// into disagreeing about which routes are which.

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // BARE PREFIXES, no trailing slash. robots.txt matching is a prefix
      // match, so "/dashboard" covers /dashboard itself AND everything under
      // it. An earlier draft emitted "/dashboard/", which reads tidier and
      // silently fails to cover the /dashboard page — the one URL most likely
      // to be linked. There is no route in this app whose path merely starts
      // with one of these strings, so the broader match costs nothing.
      disallow: [...APPLICATION_PATH_PREFIXES, ...NON_PAGE_PATH_PREFIXES],
    },
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
