// v1.3 Feature 1E-A — the barcode value contract.
//
// WHY THESE RULES ARE FUSSY. A barcode is an identifier a scanner will present
// thousands of times a day, and the failure mode is silent: a value that looks
// right and never matches, or two products that quietly become one. Every rule
// below exists because its absence produces one of those two outcomes.
import { describe, expect, it } from "vitest";
import {
  BARCODE_MAX_LENGTH,
  buildBarcodeIndex,
  findDuplicateBarcode,
  getBarcodeMessage,
  lookupBarcode,
  normalizeBarcode,
  normalizeOptionalBarcode,
} from "@/lib/barcode";

const index = (items: { id: string; barcode?: string }[]) => {
  const result = buildBarcodeIndex(items);

  if (!result.ok) throw new Error(`unexpected duplicate: ${result.duplicate}`);

  return result.lookup;
};

describe("normalization", () => {
  // THE WHOLE REASON THIS IS A STRING. 012345678905 as a number is 12345678905,
  // which is a different code and does not scan.
  it("preserves leading zeros", () => {
    expect(normalizeBarcode("012345678905")).toEqual({
      ok: true,
      barcode: "012345678905",
    });
    expect(normalizeBarcode("0000")).toEqual({ ok: true, barcode: "0000" });
  });

  // Code 39 and Code 128 are case-sensitive alphabets: folding case would merge
  // two real products into one.
  it("preserves case, and keeps case-different values distinct", () => {
    expect(normalizeBarcode("A1b2C")).toEqual({ ok: true, barcode: "A1b2C" });

    const lookup = index([
      { id: "upper", barcode: "ABC123" },
      { id: "lower", barcode: "abc123" },
    ]);

    expect(lookup.size).toBe(2);
    expect(lookupBarcode(lookup, "ABC123")).toBe("upper");
    expect(lookupBarcode(lookup, "abc123")).toBe("lower");
  });

  it("trims the outside only", () => {
    expect(normalizeBarcode("  012345678905  ")).toEqual({
      ok: true,
      barcode: "012345678905",
    });
    expect(normalizeBarcode("\t0123\n")).toEqual({ ok: true, barcode: "0123" });
  });

  // NEGATIVE CONTROL. Stripping an interior space would turn two distinct
  // catalogue entries into one, silently.
  it("rejects embedded whitespace rather than stripping it", () => {
    for (const raw of ["012 345", "AB\tCD", "AB\nCD", "A B C"]) {
      expect(normalizeBarcode(raw)).toEqual({
        ok: false,
        problem: "invalid_characters",
      });
    }
  });

  it("rejects control characters", () => {
    for (const raw of ["\u0000abc", "abc\u001F", "ab\u007Fcd", "\u0007"]) {
      expect(normalizeBarcode(raw).ok).toBe(false);
    }
  });

  it("rejects Unicode anywhere inside the value", () => {
    for (const raw of [
      "\uFF10\uFF11\uFF12\uFF13", // fullwidth digits
      "caf\u00E9",
      "\u2192",
      "ab\u00A0cd", // NBSP BETWEEN characters
      "12\uFEFF34", // BOM between characters
      "\u0661\u0662\u0663", // Arabic-Indic digits
    ]) {
      expect(normalizeBarcode(raw).ok).toBe(false);
    }
  });

  // A DELIBERATE, DOCUMENTED ASYMMETRY. JavaScript's trim() removes NBSP and
  // the BOM, so when one of those sits on the OUTSIDE it is outer whitespace and
  // is trimmed away like any other -- which is what "trim outer whitespace"
  // means for a value pasted out of a spreadsheet. The same character BETWEEN
  // two characters is content, is not whitespace for our purposes, and is
  // refused by the test above. Pinned here so the difference is intentional
  // rather than discovered later.
  it("trims outer NBSP/BOM but never accepts them as content", () => {
    expect(normalizeBarcode("\u00A0012345678905\u00A0")).toEqual({
      ok: true,
      barcode: "012345678905",
    });
    expect(normalizeBarcode("\uFEFF0123\uFEFF")).toEqual({ ok: true, barcode: "0123" });
    expect(normalizeBarcode("\u00A0\uFEFF").ok).toBe(false); // nothing left but whitespace
    expect(normalizeBarcode("01\u00A023").ok).toBe(false); // interior: refused
  });

  // The allowed range is exactly 0x21..0x7E: one past the space, one before DEL.
  it("accepts the ASCII boundaries and refuses just outside them", () => {
    expect(normalizeBarcode("!")).toEqual({ ok: true, barcode: "!" }); // 0x21
    expect(normalizeBarcode("~")).toEqual({ ok: true, barcode: "~" }); // 0x7E
    expect(normalizeBarcode(" ").ok).toBe(false); // 0x20, space
    expect(normalizeBarcode("\u007F").ok).toBe(false); // 0x7F, DEL

    // Every printable in the range, in one value, is acceptable content.
    const printable = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) =>
      String.fromCharCode(0x21 + i)
    ).join("");

    expect(normalizeBarcode(printable.slice(0, BARCODE_MAX_LENGTH)).ok).toBe(true);
  });

  it("accepts exactly 64 characters and refuses 65", () => {
    const at = "x".repeat(BARCODE_MAX_LENGTH);
    const over = "x".repeat(BARCODE_MAX_LENGTH + 1);

    expect(normalizeBarcode(at)).toEqual({ ok: true, barcode: at });
    expect(normalizeBarcode(over)).toEqual({ ok: false, problem: "too_long" });
    // Measured AFTER trimming, so trailing spaces cannot push a valid value over.
    expect(normalizeBarcode(`  ${at}  `).ok).toBe(true);
  });

  it("treats blank and non-string input as absent, never as empty string", () => {
    for (const raw of ["", "   ", "\t\n", null, undefined, 12345, {}, []]) {
      expect(normalizeOptionalBarcode(raw)).toBeUndefined();
    }
  });

  it("treats an unusable value as absent rather than carrying it through", () => {
    expect(normalizeOptionalBarcode("012 345")).toBeUndefined();
    expect(normalizeOptionalBarcode("x".repeat(65))).toBeUndefined();
  });

  it("says something useful for every problem", () => {
    for (const problem of ["empty", "too_long", "invalid_characters"] as const) {
      expect(getBarcodeMessage(problem).trim()).not.toBe("");
    }

    expect(getBarcodeMessage("too_long")).toContain("64");
  });

  // NEGATIVE CONTROL ON THE TWO CONTRACTS. Product search folds case, because
  // "VODKA" and "vodka" are the same shelf. A barcode must NOT, because they can
  // be two different products. Asserted as a property of this module alone --
  // deliberately without importing the search normalizer, which belongs to
  // another lane and must not become a dependency of the barcode contract.
  it("does not fold case the way a search normalizer would", () => {
    expect(normalizeBarcode("  VODKA ")).toEqual({ ok: true, barcode: "VODKA" });
    expect(normalizeOptionalBarcode("VODKA")).not.toBe(
      normalizeOptionalBarcode("vodka")
    );
  });
});

describe("the index", () => {
  it("maps a normalized barcode to a durable item id", () => {
    const lookup = index([
      { id: "item-a", barcode: " 012345678905 " },
      { id: "item-b", barcode: "99" },
      { id: "item-c" },
    ]);

    expect(lookup.size).toBe(2);
    expect(lookupBarcode(lookup, "012345678905")).toBe("item-a");
    // The caller may hand over exactly what it received.
    expect(lookupBarcode(lookup, "  012345678905  ")).toBe("item-a");
  });

  it("returns null for an unknown, blank or unusable value", () => {
    const lookup = index([{ id: "item-a", barcode: "111" }]);

    for (const raw of ["222", "", "   ", "1 11", null, undefined, "١١١"]) {
      expect(lookupBarcode(lookup, raw)).toBeNull();
    }
  });

  it("ignores items with no barcode", () => {
    const lookup = index([{ id: "a" }, { id: "b", barcode: "" }, { id: "c", barcode: "  " }]);

    expect(lookup.size).toBe(0);
  });

  // NEITHER FIRST-WINS NOR LAST-WINS. Both silently sell one product at
  // another's price, and which one you get depends on array order.
  it("refuses a duplicate instead of picking a winner", () => {
    const result = buildBarcodeIndex([
      { id: "a", barcode: "012345678905" },
      { id: "b", barcode: "  012345678905  " },
    ]);

    expect(result).toEqual({ ok: false, duplicate: "012345678905" });
    expect(findDuplicateBarcode([
      { id: "a", barcode: "77" },
      { id: "b", barcode: "88" },
      { id: "c", barcode: "77" },
    ])).toBe("77");
  });

  it("does not treat case-different barcodes as duplicates", () => {
    expect(findDuplicateBarcode([
      { id: "a", barcode: "ABC" },
      { id: "b", barcode: "abc" },
    ])).toBeNull();
  });

  // The capability answer is passed IN; this module knows nothing about
  // projects, templates or feature flags.
  it("builds an empty index when the capability is disabled", () => {
    const result = buildBarcodeIndex([{ id: "a", barcode: "111" }], { enabled: false });

    expect(result.ok && result.lookup.size).toBe(0);
    expect(result.ok && lookupBarcode(result.lookup, "111")).toBeNull();

    // Absent or true both mean enabled.
    expect(buildBarcodeIndex([{ id: "a", barcode: "111" }], { enabled: true }).ok).toBe(true);
    expect(index([{ id: "a", barcode: "111" }]).size).toBe(1);
  });

  // Disabling is a capability switch, not a data eraser.
  it("disabling does not alter the items it was given", () => {
    const items = [{ id: "a", barcode: "111" }];

    buildBarcodeIndex(items, { enabled: false });

    expect(items).toEqual([{ id: "a", barcode: "111" }]);
  });
});
