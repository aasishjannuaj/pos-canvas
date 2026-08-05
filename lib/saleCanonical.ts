// Milestone 16, Feature 16.3 — Migration D3.
//
// A TypeScript MODEL of the canonical sale-request format and its SHA-256
// digest. Production never computes this in the browser: complete_sale_v2
// derives the hash inside PostgreSQL from the request it actually received, so
// a tampered or stale client cannot influence it. This module exists so the
// canonical format has pinned, executable fixtures that cross-check the SQL.
//
// Imports node:crypto, so it must never be pulled into a "use client"
// component. Browser-safe request-id helpers live in lib/saleRequest.ts.
import { createHash } from "node:crypto";

export const SALE_CANONICAL_VERSION = "posc.sale.v1";

/** Bounds mirrored from complete_sale_v2. */
export const SALE_MAX_ITEMS = 200;
export const SALE_MAX_QUANTITY = 10000;

export type CanonicalSaleItem = { itemId: string; quantity: number };

export type CanonicalSaleRequest = {
  projectId: string;
  paymentMethod: "cash" | "card";
  /** Already rounded to two decimals, as a decimal string (e.g. "0.00"). */
  tipAmount: string;
  items: CanonicalSaleItem[];
};

// ---------------------------------------------------------------------------
// Exact decimal rounding, matching PostgreSQL `round(numeric, 2)`.
//
// PostgreSQL rounds half AWAY FROM ZERO on exact decimal values. JavaScript
// doubles cannot represent 2.005 exactly, so a number input would round to 2.00
// where PostgreSQL gives 2.01. Inputs are therefore decimal STRINGS.
// ---------------------------------------------------------------------------
export function roundMoneyString(value: string): string {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("roundMoneyString: not a decimal literal");
  }

  // The sign is stripped first, so all arithmetic below is on non-negative
  // integers. Plain numbers are used rather than BigInt literals, which the
  // repository's TypeScript target does not support.
  const negative = trimmed.startsWith("-");
  const [whole, frac = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  const padded = (frac + "000").slice(0, 3);
  const scaled = Number(whole) * 1000 + Number(padded);

  if (!Number.isSafeInteger(scaled)) {
    throw new Error("roundMoneyString: value out of range");
  }

  const quotient = Math.floor(scaled / 10);
  const remainder = scaled % 10;
  const rounded = remainder >= 5 ? quotient + 1 : quotient;

  const out = `${Math.floor(rounded / 100)}.${String(rounded % 100).padStart(2, "0")}`;
  return negative && rounded !== 0 ? `-${out}` : out;
}

/**
 * Normalizes and validates the client-authoritative part of a sale request.
 *
 * Deliberately rejects duplicates BEFORE any hashing: two requests that differ
 * only by how a repeated item was split across lines must never be able to
 * produce the same canonical form.
 */
export function normalizeSaleItems(
  items: readonly { itemId: unknown; quantity: unknown }[]
): CanonicalSaleItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("normalizeSaleItems: at least one item is required");
  }
  if (items.length > SALE_MAX_ITEMS) {
    throw new Error("normalizeSaleItems: too many items");
  }

  const normalized: CanonicalSaleItem[] = [];
  const seen = new Set<string>();

  for (const raw of items) {
    const itemId = typeof raw.itemId === "string" ? raw.itemId.trim() : "";
    if (itemId === "") {
      throw new Error("normalizeSaleItems: invalid item id");
    }
    if (seen.has(itemId)) {
      throw new Error("normalizeSaleItems: duplicate item id");
    }
    seen.add(itemId);

    const quantity = Number(raw.quantity);
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > SALE_MAX_QUANTITY
    ) {
      throw new Error("normalizeSaleItems: invalid quantity");
    }

    normalized.push({ itemId, quantity });
  }

  // Sorted by UTF-8 BYTE order, which is what PostgreSQL's COLLATE "C"
  // produces. A locale collation would order differently and silently break
  // cross-language agreement.
  return normalized.sort((a, b) =>
    Buffer.compare(Buffer.from(a.itemId, "utf8"), Buffer.from(b.itemId, "utf8"))
  );
}

/**
 * Builds the canonical preimage.
 *
 * WHY EQUIVALENT REQUESTS HASH IDENTICALLY: every variable field is normalized
 * to a single representation before it is written — the item list is sorted by
 * byte order, quantities become plain integer text, the tip becomes a
 * two-decimal numeric string, and the payment method is one of exactly two
 * validated literals. Item ids are trimmed with the same rule used for
 * validation, so no request can normalize two ways.
 *
 * WHY DIFFERENT REQUESTS DO NOT COLLIDE: every item id is written with an
 * explicit octet-length prefix, so the concatenation is injective — an id
 * containing '=', ':' or a newline cannot be re-parsed as a different
 * (id, quantity) pairing. Field names and the item count are fixed, so a
 * shorter list can never be a prefix of a longer one.
 */
export function buildCanonicalSaleRequest(request: CanonicalSaleRequest): string {
  const lines = [
    SALE_CANONICAL_VERSION,
    `project=${request.projectId}`,
    `payment=${request.paymentMethod}`,
    `tip=${request.tipAmount}`,
    `items=${request.items.length}`,
  ];

  for (const item of request.items) {
    const bytes = Buffer.byteLength(item.itemId, "utf8");
    lines.push(`${bytes}:${item.itemId}=${item.quantity}`);
  }

  return lines.join("\n");
}

/** Lowercase 64-character hex, matching orders_sale_request_hash_format_check. */
export function hashCanonicalSaleRequest(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Convenience: normalize, canonicalize and hash in one step. */
export function computeSaleRequestHash(input: {
  projectId: string;
  paymentMethod: "cash" | "card";
  tipAmount: string;
  items: readonly { itemId: unknown; quantity: unknown }[];
}): { canonical: string; hash: string } {
  const canonical = buildCanonicalSaleRequest({
    projectId: input.projectId,
    paymentMethod: input.paymentMethod,
    tipAmount: roundMoneyString(input.tipAmount),
    items: normalizeSaleItems(input.items),
  });

  return { canonical, hash: hashCanonicalSaleRequest(canonical) };
}
