// Feature 10.3/10.4 — shared product-grouping key, used by Product
// Performance and Inventory Summary so the two features can never disagree
// on how a product is identified. Group by item_id primarily, falling back
// to item_name only if item_id is ever missing/blank — cheap insurance
// against malformed rows, matching the same non-null assumption the rest of
// the app already makes about item_id.
export function productKey(itemId: string, itemName: string): string {
  return itemId.trim() !== "" ? itemId : itemName;
}
