// Real POS Canvas product screenshots, with their provenance.
//
// ONE RECORD PER ASSET, ON THE SAME CONTRACT LEARN USES. These are ArticleImage
// records — the exact type an article figure is — so a screenshot on the
// homepage is held to the same rules as one in an article: real dimensions,
// real alt text, a required provenance, and for a real screenshot, capture
// evidence and two human reviews. There is no second media model.
//
// WHAT "REAL" MEANS HERE. Pixels captured from the running POS Canvas product.
// The only processing allowed is crop, resize, lossless or reasonable
// compression, and format conversion. Nothing is retouched, regenerated,
// reconstructed or composited — see docs/LEARN_EDITORIAL_CONTRACT.md §6.
//
// The `capture` block is INTERNAL. It is never rendered; a reader sees only
// `alt` and `caption`.
import type { ArticleImage } from "@/lib/learn";

/**
 * The Builder, opened on the Cozy Cafe template.
 *
 * Captured by the owner, not generated. The Builder was opened at
 * /editor/cafe, which seeds the session from the template's starter
 * configuration WITHOUT creating a project: nothing was saved and nothing was
 * published, so the capture wrote nothing to the hosted database. Every name
 * and price on screen is the template's own fictional starter data.
 *
 * PROCESSING, exactly: a rectangular crop of the raw window capture to the
 * product surface — removing the browser's tabs, address bar, bookmarks and
 * profile (rows 0–169) and the Next.js development-tools badge that `next dev`
 * draws bottom-left (from row 1202) — then lossless WebP encoding. The crop is
 * a byte-exact subset of the raw capture and the encode is pixel-identical to
 * the crop. No pixel was edited.
 */
export const BUILDER_CAFE_PRODUCTS: ArticleImage = {
  src: "/screenshots/builder-cafe-products.webp",
  alt: "The POS Canvas Builder editing a cafe menu, with priced products shown in a live point-of-sale preview.",
  width: 2047,
  height: 1020,
  provenance: "real-product-screenshot",
  caption: "The POS Canvas Builder, open on the Cozy Cafe template.",
  capture: {
    surface: "Builder (/editor/cafe) — Menu tab, with the live POS preview and the Setup Guide open",
    platform: "web-builder",
    capturedAt: "2026-09-16",
    shippedBasis: {
      version: "1.2.0",
      commit: "75f1fd35780e07ac8ee4a1c4484f6a178d03ff30",
    },
    context:
      "Owner-assisted capture from a local Lane 3 checkout (npm run dev) signed in as the owner. " +
      "The Builder's component code is byte-identical to the v1.2.0 baseline; Lane 3 changed only " +
      "the route's invisible robots meta. Opened from the Cozy Cafe starter configuration with no " +
      "Save or Publish. Raw window capture cropped to the product surface, excluding browser chrome " +
      "and the Next.js development badge, then losslessly encoded.",
    demonstrates:
      "A business owner starting from a template and configuring the menu — categories, products, " +
      "prices and stock — with the point-of-sale presentation shown beside the editor.",
    reviews: {
      unreleasedFeatures: "passed",
      sensitiveInformation: "passed",
    },
  },
};
