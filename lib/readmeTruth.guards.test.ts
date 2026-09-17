// Lane 3 Task 4.2 — the README's product and release claims, guarded.
//
// WHY THIS FILE IS SMALL, AND STAYS SMALL. The README is not a marketing
// surface and this is not another copy linter. It guards the handful of claims
// that were actually wrong, plus the release facts that go stale silently:
//
//   - "No offline mode" survived two releases after offline selling shipped.
//   - "a packaging proof, not a till" described the Android app for months
//     after it became a real paired till.
//   - Printing, payments and layout are the three things a reader most easily
//     assumes POS Canvas does more of than it does.
//   - The released baseline is v1.2.0, and v1.3 branch work must not read as
//     released.
//
// Everything here is checked against repository evidence — the release modules,
// the template registry, the files the README links to — rather than against a
// transcription, so a future release moves the guard with it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CURRENT_ANDROID_RELEASE } from "@/lib/androidRelease";
import { CURRENT_WINDOWS_RELEASE } from "@/lib/windowsRelease";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = readFileSync(join(repoRoot, "README.md"), "utf-8");

/**
 * Lower-cased with whitespace collapsed.
 *
 * LOAD-BEARING: the README is hard-wrapped, so "the template decides the
 * layout" spans a newline in the file. Matching the raw text made this guard
 * pass and fail on where a sentence happened to break.
 */
const readme = README.toLowerCase().replace(/\s+/g, " ");

describe("the README states the released baseline, not branch work", () => {
  it("names the released version the release modules actually declare", () => {
    // Both apps ship the same version today; if that ever diverges this fails
    // rather than leaving one of them misdescribed.
    expect(CURRENT_ANDROID_RELEASE?.versionName).toBe("1.2.0");
    expect(CURRENT_WINDOWS_RELEASE?.versionName).toBe("1.2.0");
    expect(README).toContain("**POS Canvas v1.2.0**");
  });

  it("does not present v1.3 as released", () => {
    expect(readme).toContain("development, not released");

    for (const claim of [
      "v1.3.0 release",
      "released v1.3",
      "v1.3 is released",
      "now shipping v1.3",
    ]) {
      expect(`README: ${claim}`).toBe(`README: ${claim}`);
      expect(readme).not.toContain(claim);
    }
  });

  it("advertises no unreleased v1.3 capability as something the product does", () => {
    // Named because each one is active v1.3 work. The README may not describe
    // any of them at all; it certainly may not describe them as shipped.
    for (const capability of [
      "employee pin",
      "employee login",
      "employee switching",
      "time clock",
      "clock in",
      "register session",
      "cash pickup",
      "safe drop",
      "paid in/out",
      "over/short",
      "barcode",
      "age verification",
    ]) {
      expect(`README: ${capability}`).toBe(`README: ${capability}`);
      expect(readme).not.toContain(capability);
    }
  });
});

describe("the README describes offline selling as it shipped", () => {
  it("no longer carries the stale 'no offline mode' claim", () => {
    // THE DEFECT THIS FILE EXISTS FOR. Offline selling shipped in 1.2.0 and the
    // README still denied it, as a limitation bullet of its own.
    //
    // The BULLET is what is banned, not the phrase: "the owner POS in the
    // browser has no offline mode" is a true and necessary exclusion, and an
    // earlier draft of this guard banned that sentence too.
    expect(readme).not.toContain("**no offline mode**");
    expect(readme).not.toMatch(/no offline mode\s*—/);
    expect(readme).not.toContain("the android shell shows an honest failure screen");
  });

  it("scopes offline selling to a paired native till, with its bound", () => {
    expect(readme).toContain("paired native till");
    expect(readme).toContain("set up online once");
    expect(readme).toContain("seven days");
    // The browser POS is excluded explicitly, because that is the assumption a
    // reader makes by default.
    expect(readme).toContain("browser has no offline mode");
  });

  it("does not simplify the inventory rule in either direction", () => {
    // Online rejects; a synced offline sale is kept with the shortfall
    // recorded. Neither half may be stated alone.
    expect(readme).toContain("insufficient tracked stock is rejected");
    expect(readme).toContain("floors at zero");
    expect(readme).toContain("shortfall is recorded");

    for (const blanket of [
      "all insufficient-stock sales are rejected",
      "insufficient stock always",
    ]) {
      expect(`README: ${blanket}`).toBe(`README: ${blanket}`);
      expect(readme).not.toContain(blanket);
    }
  });
});

describe("the README describes the platforms as they shipped", () => {
  it("does not call the Android app a packaging proof", () => {
    for (const stale of ["packaging proof", "not a till"]) {
      expect(`README: ${stale}`).toBe(`README: ${stale}`);
      expect(readme).not.toContain(stale);
    }
    expect(readme).toContain("a real paired till");
  });

  it("claims no Android receipt printing, and keeps the printing that works", () => {
    expect(readme).toContain("no receipt printing on android");
    expect(readme).toContain("browser print path");
    expect(readme).toContain("no printer-hardware integration");
  });

  it("claims no payment processing", () => {
    expect(readme).toContain("recorded as the tender");

    for (const claim of [
      "payment gateway",
      "card terminal integration",
      "process payments",
      "payment processing is",
    ]) {
      expect(`README: ${claim}`).toBe(`README: ${claim}`);
      expect(readme).not.toContain(claim);
    }
  });

  it("states the universal-binary model rather than a per-business build", () => {
    expect(readme).toContain("one universal binary per platform");

    for (const claim of ["apk per project", "app per business", "we build your"]) {
      expect(`README: ${claim}`).toBe(`README: ${claim}`);
      expect(readme).not.toContain(claim);
    }
  });
});

describe("the README describes templates without promising layout editing", () => {
  it("says the template decides the layout", () => {
    expect(readme).toContain("the template decides the layout");
    expect(readme).toContain("no layout editing");
  });

  it("offers no freeform or drag-and-drop editing", () => {
    // "freeform" appears once, in the sentence that DENIES it; that denial is
    // asserted rather than banned.
    expect(readme).toContain("not a freeform screen designer");

    for (const claim of [
      "drag-and-drop",
      "drag and drop",
      "rearrange the layout",
      "design your own screen",
    ]) {
      expect(`README: ${claim}`).toBe(`README: ${claim}`);
      expect(readme).not.toContain(claim);
    }
  });
});

describe("the README stays safe about credentials and databases", () => {
  it("names no Supabase project reference and leaks no key", () => {
    // Project refs identify a specific hosted database; a key in a README is a
    // key in every clone of the repository.
    for (const secret of ["xhjadcffrgjpkobniiwz", "pkwlpstqdqscegfkjnel"]) {
      expect("README: project ref").toBe("README: project ref");
      expect(readme).not.toContain(secret);
    }

    // A service-role key is a JWT; the README may NAME the variable but must
    // never contain a value.
    expect(README).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(README).not.toMatch(/sb(p|_secret)_[A-Za-z0-9_-]{10,}/);
  });

  it("gives no casual production migration instruction", () => {
    for (const command of ["supabase db push", "supabase db reset", "supabase link"]) {
      expect(`README: ${command}`).toBe(`README: ${command}`);
      expect(readme).not.toContain(command);
    }
  });

  it("still marks the service-role key as server-only where it is named", () => {
    expect(README).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(README).toContain("Never prefix with `NEXT_PUBLIC_`");
  });
});

describe("the README points at documents that exist", () => {
  it("every repository-relative link resolves", () => {
    const links = [...README.matchAll(/\]\(\.\/([^)#]+)\)/g)].map((match) => match[1]);

    expect(links.length).toBeGreaterThan(4);

    for (const link of links) {
      expect(`README links ${link}`).toBe(`README links ${link}`);
      expect(existsSync(join(repoRoot, link))).toBe(true);
    }
  });

  it("every npm script it documents exists in package.json", () => {
    const scripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")).scripts;
    const documented = [...README.matchAll(/`npm run ([a-z:]+)[^`]*`/g)].map((m) => m[1]);

    expect(documented.length).toBeGreaterThan(3);

    for (const script of documented) {
      expect(`README documents npm run ${script}`).toBe(`README documents npm run ${script}`);
      expect(Object.keys(scripts)).toContain(script);
    }
  });
});
