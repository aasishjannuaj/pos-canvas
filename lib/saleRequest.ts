// Milestone 16, Feature 16.3 — Migration D3.
//
// Browser-safe sale-request-id lifecycle. Deliberately imports NOTHING — no
// node:crypto, no Supabase, no React — so a "use client" component can hold it.
// The canonical hash is never computed here: complete_sale_v2 derives it inside
// PostgreSQL from the request it actually received. See lib/saleCanonical.ts
// for the model used to pin cross-language fixtures.
import type { CartItem, PaymentMethod } from "@/lib/cart";

/**
 * A checkout attempt's identity. The SAME id must be reused for every retry of
 * an unchanged cart — that is what makes a lost response replay the original
 * receipt instead of ringing up a second sale.
 */
export type SaleRequestState = {
  id: string;
  /** What the id was issued for; a change invalidates it. */
  fingerprint: string;
};

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSaleRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UUID_PATTERN.test(value) &&
    value.toLowerCase() !== ZERO_UUID
  );
}

/**
 * Generates a request id.
 *
 * Uses crypto.randomUUID, which every browser this app targets supports.
 * Math.random is NOT an acceptable fallback: colliding ids across two terminals
 * would make one device's retry return the other's receipt. If the API is
 * missing, this throws so checkout fails loudly rather than silently unsafe.
 */
export function createSaleRequestId(
  cryptoImpl: { randomUUID?: () => string } | null | undefined = globalThis.crypto
): string {
  if (!cryptoImpl || typeof cryptoImpl.randomUUID !== "function") {
    throw new Error("Secure checkout is unavailable in this browser.");
  }

  const id = cryptoImpl.randomUUID();

  if (!isValidSaleRequestId(id)) {
    throw new Error("Secure checkout is unavailable in this browser.");
  }

  return id;
}

/**
 * A stable description of everything the canonical hash covers.
 *
 * Mirrors the SQL canonicalization: item ids trimmed, quantities as integers,
 * sorted by id, plus the payment method and the tip. If any of these change,
 * the server would compute a different hash — so the client must not reuse the
 * old id, or the retry would be rejected as a mismatch rather than replayed.
 * Prices and item names are excluded because the server derives them.
 */
export function createSaleFingerprint(input: {
  projectId: string;
  paymentMethod: PaymentMethod | null;
  tipAmount: number;
  items: readonly Pick<CartItem, "itemId" | "quantity">[];
}): string {
  const items = [...input.items]
    .map((item) => ({ itemId: item.itemId.trim(), quantity: item.quantity }))
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
    .map((item) => `${item.itemId}=${item.quantity}`)
    .join(",");

  return [
    input.projectId,
    input.paymentMethod ?? "",
    input.tipAmount.toFixed(2),
    items,
  ].join("|");
}

/**
 * Returns the request state to use for this attempt.
 *
 * Reuses the existing id when the fingerprint is unchanged — the retry case.
 * Issues a new id when anything the hash covers has changed, because the server
 * would otherwise reject the reused id as a mismatch.
 */
export function resolveSaleRequest(
  current: SaleRequestState | null,
  fingerprint: string,
  generate: () => string = createSaleRequestId
): SaleRequestState {
  if (current && current.fingerprint === fingerprint) {
    return current;
  }

  return { id: generate(), fingerprint };
}

/** True when a new attempt must not start: one is already in flight. */
export function isSubmitBlocked(status: string): boolean {
  return status === "saving";
}
