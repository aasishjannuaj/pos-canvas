// Real POS Canvas product screenshots — the Task 3C media contract, exercised
// against a genuine asset rather than fixtures.
//
// The fixtures in lib/learnPackage.guards.test.ts prove the rules. These prove
// the rules hold for the thing actually shipped: that the record on disk
// validates, that its file exists, that the dimensions it declares are the
// dimensions the file really has, and that nothing reaches public/screenshots
// without a reviewed provenance record.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILDER_CAFE_PRODUCTS } from "@/data/productMedia";
import * as productMedia from "@/data/productMedia";
import {
  SCREENSHOT_PLATFORMS,
  validateMediaImage,
  type ArticleImage,
} from "@/lib/learn";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCREENSHOT_DIR = join(repoRoot, "public", "screenshots");
const RELEASED_V120 = "75f1fd35780e07ac8ee4a1c4484f6a178d03ff30";

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Real pixel dimensions from a WebP header, with no image library.
 *
 * Supports the three WebP chunk types. Declared width/height that disagree
 * with the file are a layout-shift bug and, worse, a sign the record was not
 * written from the file it describes.
 */
function webpSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  expect(b.toString("ascii", 0, 4)).toBe("RIFF");
  expect(b.toString("ascii", 8, 12)).toBe("WEBP");
  const chunk = b.toString("ascii", 12, 16);

  if (chunk === "VP8L") {
    // 1 signature byte, then 14-bit width-1 and 14-bit height-1, little-endian.
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8X") {
    return {
      width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
      height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
    };
  }
  throw new Error(`unknown WebP chunk ${chunk}`);
}

/** Every ArticleImage exported from data/productMedia.ts. */
const records: [string, ArticleImage][] = Object.entries(productMedia).filter(
  (entry): entry is [string, ArticleImage] =>
    typeof entry[1] === "object" && entry[1] !== null && "provenance" in entry[1]
);

// ---------------------------------------------------------------------------
// The real asset
// ---------------------------------------------------------------------------

describe("the Builder screenshot is a real, reviewed product capture", () => {
  const shot = BUILDER_CAFE_PRODUCTS;

  it("validates against the shared media contract", () => {
    expect(validateMediaImage("builder-cafe-products", shot)).toEqual([]);
  });

  it("is classified as a real product screenshot", () => {
    expect(shot.provenance).toBe("real-product-screenshot");
    expect(shot.decorative).toBeFalsy();
  });

  it("resolves to a file that exists", () => {
    expect(shot.src.startsWith("/screenshots/")).toBe(true);
    expect(existsSync(join(repoRoot, "public", shot.src))).toBe(true);
  });

  it("declares the dimensions the file actually has", () => {
    const real = webpSize(join(repoRoot, "public", shot.src));

    expect(shot.width).toBe(real.width);
    expect(shot.height).toBe(real.height);
  });

  it("records the platform it was really taken on", () => {
    // A Builder capture must never be presented as the till or a native app.
    expect(shot.capture?.platform).toBe("web-builder");
    expect(SCREENSHOT_PLATFORMS).toContain(shot.capture?.platform);
  });

  it("names the released product it represents", () => {
    expect(shot.capture?.shippedBasis.version).toBe("1.2.0");
    expect(shot.capture?.shippedBasis.commit).toBe(RELEASED_V120);
  });

  it("carries both human reviews", () => {
    expect(shot.capture?.reviews.unreleasedFeatures).toBe("passed");
    expect(shot.capture?.reviews.sensitiveInformation).toBe("passed");
  });

  it("says what it shows and how it was made", () => {
    expect(shot.capture?.surface).toContain("/editor/cafe");
    expect(shot.capture?.context).toContain("byte-identical to the v1.2.0 baseline");
    expect(shot.capture?.demonstrates.length).toBeGreaterThan(20);
  });

  it("has alt text that describes the product, not the file", () => {
    const alt = shot.alt.toLowerCase();

    expect(alt).toContain("pos canvas");
    expect(alt).toContain("builder");
    // Not a filename, a placeholder, or a stuffed keyword list.
    for (const bad of ["screenshot of", "image of", ".webp", "mockup", "simulated", "ai-generated"]) {
      expect(`alt: ${bad}`).toBe(`alt: ${bad}`);
      expect(alt).not.toContain(bad);
    }
    expect(shot.alt.split(",").length).toBeLessThan(4);
  });

  it("does not describe itself as anything but genuine", () => {
    const publicText = `${shot.alt} ${shot.caption ?? ""}`.toLowerCase();

    for (const word of ["mockup", "concept", "simulated", "illustration", "ai-generated", "rendering"]) {
      expect(`public text: ${word}`).toBe(`public text: ${word}`);
      expect(publicText).not.toContain(word);
    }
  });

  it("claims no unreleased capability in its public text", () => {
    const publicText = `${shot.alt} ${shot.caption ?? ""}`.toLowerCase();

    for (const word of ["employee", "barcode", "scanner", "time clock", "register session", "cash drawer", "age verification"]) {
      expect(`public text: ${word}`).toBe(`public text: ${word}`);
      expect(publicText).not.toContain(word);
    }
  });
});

// ---------------------------------------------------------------------------
// Missing provenance fails — on the real record
// ---------------------------------------------------------------------------

describe("the real record fails the moment its provenance is incomplete", () => {
  const base = BUILDER_CAFE_PRODUCTS;
  const without = (patch: object): ArticleImage =>
    ({ ...base, capture: { ...base.capture!, ...patch } }) as ArticleImage;
  const problems = (image: ArticleImage) =>
    validateMediaImage("x", image).map((i) => i.problem).join(" | ");

  it("without capture details", () => {
    expect(problems({ ...base, capture: undefined })).toContain("capture details");
  });

  it("without a platform", () => {
    expect(problems(without({ platform: "iphone" }))).toContain("known platform");
  });

  it("without a shipped version or commit", () => {
    expect(problems(without({ shippedBasis: { version: "", commit: RELEASED_V120 } }))).toContain(
      "shipped version"
    );
    expect(problems(without({ shippedBasis: { version: "1.2.0", commit: "75f1fd3" } }))).toContain(
      "full shipped commit"
    );
  });

  it("without context or a statement of what it shows", () => {
    expect(problems(without({ context: "" }))).toContain("capture context");
    expect(problems(without({ demonstrates: " " }))).toContain("what it demonstrates");
  });

  it("without either review", () => {
    expect(
      problems(without({ reviews: { unreleasedFeatures: "pending", sensitiveInformation: "passed" } }))
    ).toContain("unreleased-feature review");
    expect(
      problems(without({ reviews: { unreleasedFeatures: "passed", sensitiveInformation: "pending" } }))
    ).toContain("sensitive-information review");
  });

  it("when relabelled as an illustration but still carrying capture evidence", () => {
    // The masquerade in the other direction: a real capture's evidence pinned
    // to something that is not one.
    expect(problems({ ...base, provenance: "illustration" })).toContain(
      "only a real-product-screenshot"
    );
  });

  it("when an illustration claims to be a screenshot without evidence", () => {
    expect(
      problems({ ...base, provenance: "real-product-screenshot", capture: undefined })
    ).toContain("capture details");
  });
});

// ---------------------------------------------------------------------------
// Nothing unreviewed reaches the site
// ---------------------------------------------------------------------------

describe("every served screenshot has a reviewed record", () => {
  it("each file in public/screenshots is described by exactly one record", () => {
    // Not a count limit: add as many as are justified. What is refused is an
    // image on the site with nobody's name on its provenance.
    const files = readdirSync(SCREENSHOT_DIR).filter((f) => !f.startsWith("."));
    const described = records.map(([, image]) => image.src.replace("/screenshots/", ""));

    for (const file of files) {
      expect(`orphan screenshot ${file}`).toBe(`orphan screenshot ${file}`);
      expect(described.filter((d) => d === file)).toHaveLength(1);
    }
  });

  it("every record validates", () => {
    for (const [name, image] of records) {
      expect(`record ${name}`).toBe(`record ${name}`);
      expect(validateMediaImage(name, image)).toEqual([]);
    }
  });

  it("no raw or unprocessed capture was committed", () => {
    // Raw window captures carry browser chrome and personal browsing context;
    // they stay outside the repository.
    const files = readdirSync(SCREENSHOT_DIR);

    for (const file of files) {
      expect(`raw ${file}`).toBe(`raw ${file}`);
      expect(file.toLowerCase()).not.toMatch(/^screenshot|\sat\s|\.png$|raw/);
    }
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("the homepage renders the record, and only its public fields", () => {
  const section = code(read("components/landing/BusinessTypes.tsx"));

  it("renders from the provenance record, not a hardcoded path", () => {
    expect(section).toContain("BUILDER_CAFE_PRODUCTS.src");
    expect(section).toContain("BUILDER_CAFE_PRODUCTS.alt");
    expect(section).toContain("BUILDER_CAFE_PRODUCTS.width");
    expect(section).toContain("BUILDER_CAFE_PRODUCTS.height");
    expect(section).not.toContain('"/screenshots/');
  });

  it("never renders the internal capture metadata", () => {
    expect(section).not.toContain(".capture");
    expect(section).not.toContain("shippedBasis");
    expect(section).not.toContain("reviews");
  });

  it("is a responsive figure with a caption", () => {
    expect(section).toContain("<figure");
    expect(section).toContain("<figcaption");
    expect(section).toContain("sizes=");
    expect(section).toContain("h-auto w-full");
    // Below the fold: must not be eager.
    expect(section).not.toContain("priority");
    expect(section).not.toContain('loading="eager"');
  });

  it("stays inspectable on narrow screens instead of shrinking to illegibility", () => {
    // Task 3D correction. Scaled to fit a phone, the Builder rendered ~324px
    // wide and none of its text could be read. The invariant protected here is
    // the SHAPE of the fix, not a pixel value: on narrow screens the real image
    // keeps a minimum width and scrolls inside its own viewport — the page does
    // not — and from the desktop breakpoint it fits the column again.
    const raw = read("components/landing/BusinessTypes.tsx");
    const css = read("app/design-system.css");

    expect(raw).toContain('className="pc-screenshot-viewport pc-focusable"');
    expect(raw).toContain("pc-screenshot-viewport__image");

    // Each assertion reads ONE rule block, not "from here to the end of the
    // file". An earlier version sliced to end-of-file, so the desktop reset's
    // `min-width: 0` satisfied the check even with the phone minimum deleted —
    // a negative control caught it.
    const block = (selector: string) => {
      const start = css.indexOf(selector);
      expect(start, `${selector} is missing`).toBeGreaterThan(-1);
      return css.slice(start, css.indexOf("}", start));
    };

    expect(block(".pc-screenshot-viewport {")).toContain("overflow-x: auto;");
    // A real, non-zero minimum on the base rule — not merely the word.
    expect(block(".pc-screenshot-viewport__image {")).toMatch(/min-width:\s*[1-9]/);

    // ...and the minimum is lifted at the desktop breakpoint, so desktop and
    // tablet are unchanged.
    const desktop = css.slice(css.indexOf("@media (min-width: 64rem) {\n    .pc-screenshot-viewport"));
    expect(desktop).toContain("overflow-x: visible;");
    expect(desktop).toContain("min-width: 0;");
  });

  it("the scroll viewport is reachable and named for keyboard users", () => {
    // A scrollable region that cannot take focus cannot be scrolled without a
    // pointer. Named by the caption, so there is one label, not two.
    const raw = read("components/landing/BusinessTypes.tsx");

    expect(raw).toContain("tabIndex={0}");
    expect(raw).toContain('role="region"');
    expect(raw).toContain('aria-labelledby="builder-screenshot-caption"');
    expect(raw).toContain('id="builder-screenshot-caption"');
  });

  it("the scroll hint is visual-only and appears only where scrolling exists", () => {
    const raw = read("components/landing/BusinessTypes.tsx");
    const hint = raw.slice(raw.indexOf("Scroll sideways") - 200, raw.indexOf("Scroll sideways"));

    expect(hint).toContain('aria-hidden="true"');
    expect(hint).toContain("lg:hidden");
    // No script decides any of this.
    expect(raw).not.toContain('"use client"');
    expect(raw).not.toContain("onScroll");
  });

  it("labels itself as a real screenshot, visibly", () => {
    expect(read("components/landing/BusinessTypes.tsx")).toContain("POS Canvas screenshot");
  });

  it("the pilot article is unchanged — no screenshot was added to it", () => {
    const pilot = read("data/learn.ts");
    expect(pilot).not.toContain("real-product-screenshot");
    expect(pilot).not.toContain("/screenshots/");
  });
});
