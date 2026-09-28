/**
 * v1.3 Feature 1E-A — the barcode value contract, and nothing else.
 *
 * PURE. No DOM, no React, no template, no platform, no scanner. This module
 * cannot tell whether a value arrived from a keyboard-wedge scanner, from a
 * cashier typing, or from a Builder form — and that is the point. There is no
 * scanner-source detection anywhere in this product, so a barcode is simply a
 * string that some caller obtained, and the rules below are the same for all of
 * them.
 *
 * THIS IS NOT SEARCH NORMALIZATION, AND THE DIFFERENCE IS LOAD-BEARING.
 * `normalizeSearchTerm` lowercases, because a cashier looking for "VODKA"
 * means the same shelf as one typing "vodka". A barcode is an identifier, not a
 * word: Code 39 and Code 128 are case-sensitive alphabets, so `A1b2` and `a1B2`
 * are two different products and folding them together would merge two
 * catalogue entries into one. The two contracts must never be shared.
 *
 * LEADING ZEROS SURVIVE BECAUSE THIS IS A STRING, ALWAYS. "012345678905" is a
 * UPC-A; 12345678905 is a number that lost its first digit and no longer scans.
 * Nothing here parses, and nothing downstream may either.
 */

/** The longest barcode this version stores, counted after normalization. */
export const BARCODE_MAX_LENGTH = 64;

/**
 * Why a typed or stored barcode is not usable.
 *
 * Deliberately coarse: these exist to tell an owner what to fix in the Builder,
 * not to teach them about symbologies.
 */
export type BarcodeProblem = "empty" | "too_long" | "invalid_characters";

export type BarcodeResult =
  | { ok: true; barcode: string }
  | { ok: false; problem: BarcodeProblem };

const BARCODE_MESSAGES: Record<BarcodeProblem, string> = {
  empty: "Enter a barcode, or leave it blank.",
  too_long: `Use at most ${BARCODE_MAX_LENGTH} characters.`,
  invalid_characters:
    "Use only printable characters, with no spaces — for example 012345678905.",
};

export function getBarcodeMessage(problem: BarcodeProblem): string {
  return BARCODE_MESSAGES[problem];
}

/**
 * Every character must be printable ASCII, 0x21 through 0x7E.
 *
 * That range starts one past the space and ends one before DEL, so it excludes
 * the space and every control character by construction, and excludes all of
 * Unicode. A scanner that emits a non-breaking space, a smart quote from a
 * spreadsheet paste, or a stray tab produces a value this refuses rather than a
 * value that looks right and never matches.
 */
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

/**
 * Reads a typed or stored barcode into its canonical form.
 *
 * TRIMS THE OUTSIDE ONLY. Leading and trailing whitespace is how a value
 * arrives from a form field or a paste, so it is removed; whitespace INSIDE a
 * barcode is not a formatting artifact, it is a different value, and it is
 * refused rather than stripped. Silently deleting an interior space would turn
 * two distinct catalogue entries into one.
 *
 * ONE ASYMMETRY, AND IT IS DELIBERATE. JavaScript's trim() removes more than
 * ASCII space — a no-break space and a byte-order mark among them. So one of
 * those sitting on the OUTSIDE is treated as outer whitespace and trimmed,
 * which is exactly right for a value pasted out of a spreadsheet. The same
 * character BETWEEN two characters is content, fails the printable-ASCII test
 * below, and is refused. Outer invisible whitespace is a formatting artifact;
 * interior invisible whitespace is a different barcode.
 *
 * CASE IS PRESERVED EXACTLY. See the module note.
 */
export function normalizeBarcode(raw: unknown): BarcodeResult {
  if (typeof raw !== "string") {
    return { ok: false, problem: "empty" };
  }

  const trimmed = raw.trim();

  if (trimmed === "") {
    return { ok: false, problem: "empty" };
  }

  if (!PRINTABLE_ASCII.test(trimmed)) {
    return { ok: false, problem: "invalid_characters" };
  }

  // Length is measured AFTER trimming, so trailing whitespace cannot push an
  // otherwise-valid barcode over the limit.
  if (trimmed.length > BARCODE_MAX_LENGTH) {
    return { ok: false, problem: "too_long" };
  }

  return { ok: true, barcode: trimmed };
}

/**
 * The stored form of an optional barcode: the canonical string, or absent.
 *
 * BLANK AND INVALID BOTH BECOME ABSENT, not `""`. "This item has no barcode"
 * must have exactly one spelling, or every consumer has to remember to check
 * for two. Returning `undefined` also lets the config layer OMIT the key
 * entirely, which is what keeps a pre-1E project's canonical config byte-
 * identical — see lib/generatedPosConfig.ts.
 */
export function normalizeOptionalBarcode(raw: unknown): string | undefined {
  const result = normalizeBarcode(raw);

  return result.ok ? result.barcode : undefined;
}

/** The minimum an item must expose to take part in a barcode index. */
export type BarcodeIndexableItem = {
  id: string;
  barcode?: string;
};

/** normalized barcode -> the durable MenuItem.id that owns it. */
export type BarcodeLookup = ReadonlyMap<string, string>;

export type BarcodeIndexResult =
  | { ok: true; lookup: BarcodeLookup }
  | { ok: false; duplicate: string };

/**
 * Builds the barcode index for one catalogue.
 *
 * REFUSES DUPLICATES RATHER THAN PICKING A WINNER. Neither first-wins nor
 * last-wins is defensible: both silently sell one product at another's price,
 * and which one you get depends on array order nobody can see. A duplicate is a
 * catalogue mistake, and the honest response is to refuse to build an index
 * that would resolve one barcode to two products.
 *
 * `enabled: false` yields an empty index, so a project that has turned the
 * capability off cannot resolve anything — WITHOUT this function knowing what a
 * project, a template or a feature flag is. The caller passes the answer.
 */
export function buildBarcodeIndex(
  items: readonly BarcodeIndexableItem[],
  options?: { enabled?: boolean }
): BarcodeIndexResult {
  const lookup = new Map<string, string>();

  if (options?.enabled === false) {
    return { ok: true, lookup };
  }

  for (const item of items) {
    const barcode = normalizeOptionalBarcode(item.barcode);

    if (barcode === undefined) {
      continue;
    }

    if (lookup.has(barcode)) {
      return { ok: false, duplicate: barcode };
    }

    lookup.set(barcode, item.id);
  }

  return { ok: true, lookup };
}

/**
 * The first duplicated barcode in a catalogue, or null.
 *
 * Shares buildBarcodeIndex's scan so the Builder's advisory warning and the
 * generator's authoritative refusal can never disagree about what counts as a
 * duplicate.
 */
export function findDuplicateBarcode(items: readonly BarcodeIndexableItem[]): string | null {
  const result = buildBarcodeIndex(items);

  return result.ok ? null : result.duplicate;
}

/**
 * Resolves a raw value to a durable item id, or null.
 *
 * Normalizes first, so a caller can hand over exactly what it received and
 * cannot accidentally look up an un-normalized string. Returns an ID rather
 * than an item, so nothing downstream compares object identity or holds a
 * reference across a configuration change.
 */
export function lookupBarcode(lookup: BarcodeLookup, raw: unknown): string | null {
  const normalized = normalizeOptionalBarcode(raw);

  if (normalized === undefined) {
    return null;
  }

  return lookup.get(normalized) ?? null;
}
