// Feature 18.1 — the modifier contract.
//
// Dependency-free (no React, no Supabase, no Node built-ins), so every rule
// here is unit-testable under plain Node like lib/cart.ts and lib/saleRequest.ts.
//
// WHAT THIS MODULE IS NOT: it is not the authority. complete_sale_v3 revalidates
// every rule below in SQL against the authorized config, because a browser can
// call the RPC directly. These functions exist so the client can present the
// same rules and refuse obviously-invalid input early — never so the server can
// skip a check.
//
// SCOPE (Feature 18.1 locked model): single/multiple selection, required or
// optional, an optional maximum, and non-negative price adjustments. No
// minSelections > 1, no defaults, no per-option quantity, no nesting, no
// conditional groups, no modifier inventory, no modifier-specific tax.

// ---------------------------------------------------------------------------
// Bounded caps
//
// These bound both the authored menu and the submitted request, which is what
// keeps the canonical preimage (and therefore the hash input) from growing
// without limit. complete_sale_v2 already caps a sale at 200 items; without
// per-line caps a single request could otherwise carry an unbounded number of
// option ids.
//
// The numbers are deliberately generous against real menus and still small
// enough to bound the worst case: a size group has 3-5 options, a toppings
// group 10-15, and a product rarely carries more than 3-4 groups.
// ---------------------------------------------------------------------------

/** Modifier groups one product may define. */
export const MAX_MODIFIER_GROUPS_PER_ITEM = 10;

/** Options one group may define. */
export const MAX_OPTIONS_PER_GROUP = 20;

/** Selected options across every group of ONE cart line. */
export const MAX_SELECTED_OPTIONS_PER_LINE = 50;

/** Mirrors the existing c_max_unit_price bound in complete_sale_v2. */
export const MAX_PRICE_ADJUSTMENT = 1000000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModifierSelectionType = "single" | "multiple";

export type ModifierOption = {
  id: string;
  name: string;
  /** MVP: always >= 0. Negative adjustments are deliberately out of scope. */
  priceAdjustment: number;
};

export type ModifierGroup = {
  id: string;
  name: string;
  selection: ModifierSelectionType;
  required: boolean;
  /** `multiple` only; null means "no explicit maximum beyond the global cap". */
  maxSelections: number | null;
  options: ModifierOption[];
};

/** What a client submits for one line: identifiers only, never prices. */
export type ModifierSelection = {
  groupId: string;
  optionIds: string[];
};

/**
 * The historical snapshot persisted on order_items.modifiers.
 *
 * Written from the SERVER's authorized config at sale time, never from the
 * request, so a receipt reprinted after a menu change still shows what the
 * customer actually bought and what they actually paid.
 */
export type ModifierSnapshotEntry = {
  groupId: string;
  groupName: string;
  optionId: string;
  optionName: string;
  /** Fixed two-decimal string, matching the money convention everywhere else. */
  priceAdjustment: string;
};

// ---------------------------------------------------------------------------
// Normalization — old configs predate modifiers entirely
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function normalizeOption(value: unknown): ModifierOption | null {
  if (!isPlainObject(value)) {
    return null;
  }

  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.name)) {
    return null;
  }

  const adjustment = value.priceAdjustment;

  // Not a number, NaN, Infinity, negative, or above the money bound: the option
  // is dropped rather than coerced to 0, because silently selling an option at
  // the wrong price is worse than not offering it.
  if (
    typeof adjustment !== "number" ||
    !Number.isFinite(adjustment) ||
    adjustment < 0 ||
    adjustment > MAX_PRICE_ADJUSTMENT
  ) {
    return null;
  }

  // NOT rounded here, deliberately. complete_sale_v3 applies round(x, 2) in
  // PostgreSQL numeric, which rounds half away from zero exactly; JavaScript's
  // Math.round(x * 100) / 100 disagrees at half-cent boundaries because the
  // multiply is inexact in IEEE-754 (1.005 * 100 is 100.49999999999999, so it
  // rounds DOWN to 1.00 where SQL gives 1.01). Rounding here would create a
  // second money implementation that silently differs from the authoritative
  // one. This mirrors how the base price is handled in
  // lib/generatedPosConfig.ts's toRuntimeSafeMenuItem, which also preserves the
  // authored value rather than rounding it.
  return {
    id: value.id.trim(),
    name: value.name.trim(),
    priceAdjustment: adjustment,
  };
}

function normalizeGroup(value: unknown): ModifierGroup | null {
  if (!isPlainObject(value)) {
    return null;
  }

  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.name)) {
    return null;
  }

  const selection: ModifierSelectionType =
    value.selection === "multiple" ? "multiple" : "single";

  const options: ModifierOption[] = [];
  const seenOptionIds = new Set<string>();

  for (const raw of Array.isArray(value.options) ? value.options : []) {
    const option = normalizeOption(raw);

    // A duplicate option id inside one group would make the canonical line
    // identity ambiguous, so the later duplicate is dropped.
    if (option !== null && !seenOptionIds.has(option.id)) {
      seenOptionIds.add(option.id);
      options.push(option);
    }

    if (options.length >= MAX_OPTIONS_PER_GROUP) {
      break;
    }
  }

  // A group with no usable options cannot be satisfied, and a required one
  // would make its product unsellable. Dropped entirely.
  if (options.length === 0) {
    return null;
  }

  let maxSelections: number | null = null;

  if (selection === "multiple") {
    const raw = value.maxSelections;

    if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
      // A maximum above the option count is meaningless; clamp rather than
      // reject, since it changes no behavior.
      maxSelections = Math.min(raw, options.length);
    }
  }
  // `single` never carries a maximum: the selection type already implies one.

  return {
    id: value.id.trim(),
    name: value.name.trim(),
    selection,
    required: value.required === true,
    maxSelections,
    options,
  };
}

/**
 * Normalizes whatever a stored config carries into a valid group list.
 *
 * Follows the Feature 7.5 / 11.1 convention in lib/projectConfig.ts: a project
 * saved before modifiers existed has no `modifierGroups` key at all, and must
 * normalize to [] rather than crashing or being treated as unknown.
 */
export function normalizeModifierGroups(value: unknown): ModifierGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const groups: ModifierGroup[] = [];
  const seenGroupIds = new Set<string>();

  for (const raw of value) {
    const group = normalizeGroup(raw);

    if (group !== null && !seenGroupIds.has(group.id)) {
      seenGroupIds.add(group.id);
      groups.push(group);
    }

    if (groups.length >= MAX_MODIFIER_GROUPS_PER_ITEM) {
      break;
    }
  }

  return groups;
}

/** True when a product sells exactly as it did before Feature 18. */
export function hasModifiers(groups: ModifierGroup[] | undefined): boolean {
  return Array.isArray(groups) && groups.length > 0;
}

// ---------------------------------------------------------------------------
// Selection validation
// ---------------------------------------------------------------------------

export type ModifierValidationError =
  | "unknown_group"
  | "unknown_option"
  | "duplicate_group"
  | "duplicate_option"
  | "single_choice_exceeded"
  | "required_group_missing"
  | "max_selections_exceeded"
  | "too_many_groups"
  | "too_many_options"
  | "modifiers_not_supported";

export type ModifierValidationResult =
  | { ok: true; selections: ModifierSelection[] }
  | { ok: false; error: ModifierValidationError };

/**
 * Total options selected across every group of ONE line.
 *
 * Feature 18.2 Phase 5A — extracted so the rule has a single name. It is what
 * MAX_SELECTED_OPTIONS_PER_LINE bounds below, and it is what the selector
 * consults to refuse the tap that would exceed the ceiling, instead of each
 * caller re-deriving the same sum.
 */
export function countSelectedOptions(
  selections: readonly ModifierSelection[]
): number {
  return selections.reduce(
    (total, selection) => total + selection.optionIds.length,
    0
  );
}

/**
 * Validates a submitted selection against the AUTHORIZED group definitions.
 *
 * Mirrors the SQL in complete_sale_v3 rule for rule. Client-side use is for
 * presentation only; the server never trusts the outcome of this call.
 */
export function validateModifierSelections(
  groups: ModifierGroup[],
  selections: ModifierSelection[]
): ModifierValidationResult {
  // A product with no groups accepts no selections at all — this is what stops
  // a caller attaching another product's options to a plain item.
  if (groups.length === 0) {
    return selections.length === 0
      ? { ok: true, selections: [] }
      : { ok: false, error: "modifiers_not_supported" };
  }

  if (selections.length > MAX_MODIFIER_GROUPS_PER_ITEM) {
    return { ok: false, error: "too_many_groups" };
  }

  const seenGroupIds = new Set<string>();

  for (const selection of selections) {
    if (seenGroupIds.has(selection.groupId)) {
      return { ok: false, error: "duplicate_group" };
    }
    seenGroupIds.add(selection.groupId);

    const group = groups.find((candidate) => candidate.id === selection.groupId);

    // The group must belong to THIS product. A group id borrowed from another
    // product resolves to nothing here.
    if (group === undefined) {
      return { ok: false, error: "unknown_group" };
    }

    const optionIds = selection.optionIds;

    if (optionIds.length > MAX_OPTIONS_PER_GROUP) {
      return { ok: false, error: "too_many_options" };
    }

    const seenOptionIds = new Set<string>();

    for (const optionId of optionIds) {
      if (seenOptionIds.has(optionId)) {
        return { ok: false, error: "duplicate_option" };
      }
      seenOptionIds.add(optionId);

      // The option must belong to THIS group, not merely to the product.
      if (!group.options.some((option) => option.id === optionId)) {
        return { ok: false, error: "unknown_option" };
      }
    }

    if (group.selection === "single" && optionIds.length > 1) {
      return { ok: false, error: "single_choice_exceeded" };
    }

    if (
      group.selection === "multiple" &&
      group.maxSelections !== null &&
      optionIds.length > group.maxSelections
    ) {
      return { ok: false, error: "max_selections_exceeded" };
    }
  }

  if (countSelectedOptions(selections) > MAX_SELECTED_OPTIONS_PER_LINE) {
    return { ok: false, error: "too_many_options" };
  }

  // Required groups must be satisfied. Checked over the product's groups rather
  // than the submission, so an omitted group is caught as readily as an empty one.
  for (const group of groups) {
    if (!group.required) {
      continue;
    }

    const selection = selections.find((entry) => entry.groupId === group.id);

    if (selection === undefined || selection.optionIds.length === 0) {
      return { ok: false, error: "required_group_missing" };
    }
  }

  return { ok: true, selections };
}

// ---------------------------------------------------------------------------
// Canonical line identity
//
// Used for two things that must agree exactly: distinguishing cart lines, and
// ordering/deduplicating lines inside the v3 sale-request preimage.
//
// INJECTIVITY: every variable-length id is length-prefixed and every repeated
// section carries an explicit count, so the string can be parsed back
// unambiguously. A delimiter appearing inside an id is harmless, because the
// length prefix says exactly how many characters to consume — the same
// technique complete_sale_v2 already uses for item ids.
//
// DETERMINISM: groups are sorted by group id and options by option id, so the
// order a cashier tapped them in cannot change the identity.
// ---------------------------------------------------------------------------

/**
 * Length-prefixes a value using its UTF-8 BYTE length.
 *
 * Bytes, not UTF-16 code units: complete_sale_v2 already length-prefixes item
 * ids with octet_length(), and complete_sale_v3 does the same for group and
 * option ids. A JavaScript `.length` would disagree with SQL for any non-ASCII
 * id, so the two implementations would compute different identities for the
 * same cart. TextEncoder is available in both the browser and Node, so this
 * needs no import and keeps the module dependency-free.
 */
function token(value: string): string {
  return `${new TextEncoder().encode(value).length}:${value}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The canonical identity of one cart line.
 *
 * Two lines share an identity if and only if they are the same product with
 * exactly the same set of selected options.
 *
 * NOTE ON TRUST: the client computes this to key its cart. The server computes
 * it independently from the request and never accepts a client-supplied value.
 */
export function canonicalLineIdentity(
  itemId: string,
  selections: readonly ModifierSelection[]
): string {
  const groups = [...selections]
    .filter((selection) => selection.optionIds.length > 0)
    .sort((a, b) => compare(a.groupId, b.groupId))
    .map((selection) => {
      const options = [...selection.optionIds]
        .sort(compare)
        .map(token)
        .join("");

      return `${token(selection.groupId)}(${selection.optionIds.length})${options}`;
    });

  return `${token(itemId)}[${groups.length}]${groups.join("")}`;
}

/**
 * The v3 canonical preimage — the exact string complete_sale_v3 hashes.
 *
 * Deliberately a NEW format ("posc.sale.v2") rather than an extension of v1:
 * v1 keyed a line on item id alone, so two different modifier selections of the
 * same product would collide. complete_sale_v2's own format is untouched, so a
 * stale tab still hashes exactly as it always did.
 */
export const SALE_CANONICAL_V3_HEADER = "posc.sale.v2";

export function createSaleCanonicalV3(input: {
  projectId: string;
  paymentMethod: string;
  tipAmount: string;
  lines: readonly { itemId: string; quantity: number; selections: ModifierSelection[] }[];
}): string {
  const lines = input.lines
    .map((line) => ({
      identity: canonicalLineIdentity(line.itemId, line.selections),
      quantity: line.quantity,
    }))
    .sort((a, b) => compare(a.identity, b.identity))
    .map((line) => `${line.identity}=${line.quantity}`);

  return [
    SALE_CANONICAL_V3_HEADER,
    `project=${input.projectId}`,
    `payment=${input.paymentMethod}`,
    `tip=${input.tipAmount}`,
    `items=${lines.length}${lines.length === 0 ? "" : `\n${lines.join("\n")}`}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * The unit price of one configured line: base plus every selected adjustment.
 *
 * Reference implementation for the client and for tests. complete_sale_v3
 * computes this independently in SQL from its own authorized config; a value
 * produced here never crosses the wire.
 */
export function calculateModifiedUnitPrice(
  basePrice: number,
  groups: ModifierGroup[],
  selections: readonly ModifierSelection[]
): number {
  let total = basePrice;

  for (const selection of selections) {
    const group = groups.find((candidate) => candidate.id === selection.groupId);

    if (group === undefined) {
      continue;
    }

    for (const optionId of selection.optionIds) {
      const option = group.options.find((candidate) => candidate.id === optionId);

      if (option !== undefined) {
        total += option.priceAdjustment;
      }
    }
  }

  // DISPLAY ONLY. complete_sale_v3 recomputes this in SQL and its result is
  // the price actually charged; at a half-cent boundary the two can differ by
  // a cent (see normalizeOption). Never present this value as the amount the
  // customer will pay — the authoritative figure comes back on the receipt.
  return Math.round(total * 100) / 100;
}

/** Builds the historical snapshot from authorized definitions. */
export function buildModifierSnapshot(
  groups: ModifierGroup[],
  selections: readonly ModifierSelection[]
): ModifierSnapshotEntry[] {
  const entries: ModifierSnapshotEntry[] = [];

  for (const group of groups) {
    const selection = selections.find((entry) => entry.groupId === group.id);

    if (selection === undefined) {
      continue;
    }

    for (const option of group.options) {
      if (!selection.optionIds.includes(option.id)) {
        continue;
      }

      entries.push({
        groupId: group.id,
        groupName: group.name,
        optionId: option.id,
        optionName: option.name,
        priceAdjustment: option.priceAdjustment.toFixed(2),
      });
    }
  }

  return entries;
}
