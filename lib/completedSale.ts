// Milestone 16, Feature 16.3 — Migration D3.
//
// The AUTHORITATIVE completed-sale model: exactly what complete_sale_v2
// returns, and the only thing a real receipt may be rendered from.
//
// Deliberately a separate type from CompletedOrder in lib/cart.ts. That model
// carries JavaScript numbers and is still correct for the Builder's preview,
// which has no server round-trip. Widening it to accept strings would let a
// preview value and a stored value flow through the same render path, which is
// exactly the confusion D3 exists to remove.
//
// Money is a fixed two-decimal STRING, produced by numeric(12,2)::text. It is
// never parsed back into a number: an IEEE-754 round-trip is the drift this
// representation avoids. Render it directly — no toFixed, no recomputation.
//
// Dependency-free (no React, no Supabase, no node builtins), so both the client
// runtime and Vitest can use it.

export type CompletedSaleItem = {
  itemId: string;
  itemName: string;
  unitPrice: string;
  quantity: number;
  lineTotal: string;
};

export type CompletedSaleReceipt = {
  orderId: string;
  orderNumber: string;
  paymentMethod: "cash" | "card";
  subtotal: string;
  taxAmount: string;
  tipAmount: string;
  total: string;
  createdAt: string;
  items: CompletedSaleItem[];
};

const MONEY_PATTERN = /^-?\d+\.\d{2}$/;

/** Exactly two decimals, as the SQL side guarantees. */
export function isFixedDecimalString(value: unknown): value is string {
  return typeof value === "string" && MONEY_PATTERN.test(value);
}

function isCompletedSaleItem(value: unknown): value is CompletedSaleItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;

  return (
    typeof item.itemId === "string" &&
    typeof item.itemName === "string" &&
    isFixedDecimalString(item.unitPrice) &&
    typeof item.quantity === "number" &&
    Number.isInteger(item.quantity) &&
    item.quantity > 0 &&
    isFixedDecimalString(item.lineTotal)
  );
}

/**
 * Structural guard for the RPC response.
 *
 * Rejects rather than coerces: a payload that does not match is a contract
 * break, and printing a half-understood receipt is worse than showing an error.
 */
export function isCompletedSaleReceipt(
  value: unknown
): value is CompletedSaleReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;

  return (
    typeof receipt.orderId === "string" &&
    receipt.orderId !== "" &&
    typeof receipt.orderNumber === "string" &&
    receipt.orderNumber !== "" &&
    (receipt.paymentMethod === "cash" || receipt.paymentMethod === "card") &&
    isFixedDecimalString(receipt.subtotal) &&
    isFixedDecimalString(receipt.taxAmount) &&
    isFixedDecimalString(receipt.tipAmount) &&
    isFixedDecimalString(receipt.total) &&
    typeof receipt.createdAt === "string" &&
    Array.isArray(receipt.items) &&
    receipt.items.every(isCompletedSaleItem)
  );
}

/**
 * True when a money string is a non-zero amount, for conditional receipt lines.
 * Compares text, never a parsed float — "0.00" is the only zero the server
 * emits for a two-decimal string.
 */
export function isNonZeroMoney(value: string): boolean {
  return isFixedDecimalString(value) && !/^-?0\.00$/.test(value);
}
