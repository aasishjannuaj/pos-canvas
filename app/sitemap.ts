import type { MetadataRoute } from "next";
import { templates } from "@/data/templates";
import { absoluteUrl } from "@/lib/seo";

// Lane 3 Task 3 — the sitemap, which is a claim about what is worth indexing.
//
// WHAT IS IN IT: the homepage, the template gallery, and one page per template
// in the canonical registry. Nothing else. Each is a real, public, crawlable
// page with content a searcher could want.
//
// TEMPLATE PAGES ARE ENUMERATED FROM THE REGISTRY, not matched by pattern.
// data/templates.ts is the single source of truth for which templates exist
// (Feature 12.1), so this lists exactly the six that do. /templates/[id] renders
// an "unavailable" state for any other id, and that state is marked noindex by
// the route's own generateMetadata — a sitemap must never point at a soft 404,
// and a pattern-matched entry eventually would.
//
// WHAT IS DELIBERATELY EXCLUDED:
//
//   /dashboard, /editor/*, /runtime/*   application surfaces behind proxy.ts;
//                                       a crawler gets a redirect to /login
//   /login, /signup, /forgot-password,  publicly reachable but thin; they carry
//   /reset-password, /device            `noindex` instead
//   /auth/*                             a route handler, not a page
//   the four planned SEO landing pages  /customizable-pos,
//                                       /pos-for-small-business,
//                                       /liquor-store-pos and
//                                       /no-code-pos-builder are PLAN ONLY.
//                                       They do not exist, and a sitemap entry
//                                       for a 404 is a self-inflicted crawl
//                                       error.
//
// No `lastModified`: this repository has no per-page content timestamp, and a
// build-time `new Date()` would tell crawlers every page changed on every
// deploy, which is both false and a good way to have the signal ignored.
// No `priority`/`changeFrequency` either — Google has said for years it ignores
// them, and inventing numbers to fill a schema is how a sitemap starts lying.

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: absoluteUrl("/") },
    { url: absoluteUrl("/templates") },
    ...templates.map((template) => ({
      url: absoluteUrl(`/templates/${template.id}`),
    })),
  ];
}
