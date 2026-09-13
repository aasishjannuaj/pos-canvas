import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { CompletedOrder, PaymentMethod } from "@/lib/cart";
import type { CompletedSaleItem, CompletedSaleReceipt } from "@/lib/completedSale";
import { storedMoneyToFixedString } from "@/lib/money";
import { toCompletedOrder } from "@/lib/saleSubmission";

type OrderItemRow = {
  item_id: string;
  item_name: string;
  unit_price: number;
  quantity: number;
  line_total: number;
  // Feature 18.2 — defaulted to [] by the migration, so every historical row
  // has a valid value and no reader has to handle null.
  modifiers: {
    groupId: string;
    groupName: string;
    optionId: string;
    optionName: string;
    priceAdjustment: string;
  }[] | null;
  // Feature 28C — selected so the ordering below is explicit about what it
  // sorts on. Null on every row predating the column; not rendered anywhere.
  line_position: number | null;
};

type OrderRow = {
  id: string;
  order_number: string;
  payment_method: PaymentMethod;
  subtotal: number;
  tax_amount: number;
  tip_amount: number;
  total: number;
  created_at: string;
  // Feature 28C — the sale-time business identity and receipt settings, for an
  // OWNER sale. Null on a device sale (which records build_job_id instead) and
  // on every order predating the column.
  receipt_snapshot: unknown;
  order_items: OrderItemRow[] | null;
};

// Feature 28A — the Builder reads the SAME canonical receipt the till does.
//
// This used to build the number-typed CompletedOrder directly, which meant the
// Builder's receipt overlay recomputed each line as price × quantity and threw
// away the persisted line_total. Now one canonical CompletedSaleReceipt is
// built here and the number-typed model is PROJECTED from it through the same
// toCompletedOrder the live checkout path uses — so there is one shape of truth
// and one place it is derived.
//
// PostgREST serialises numeric(12,2) as a JSON number, so these values reach us
// as doubles that have already lost their decimal identity. Converting them
// back goes through lib/money.ts, which refuses anything that does not look
// like money a numeric(12,2) column produced rather than inventing a third
// decimal. It is a REPRESENTATION change, never a recomputation: no figure here
// is derived from any other.
function toLineItem(orderItem: OrderItemRow): CompletedSaleItem | null {
  const unitPrice = storedMoneyToFixedString(orderItem.unit_price);
  const lineTotal = storedMoneyToFixedString(orderItem.line_total);

  if (unitPrice === null || lineTotal === null) return null;

  return {
    itemId: orderItem.item_id,
    itemName: orderItem.item_name,
    unitPrice,
    quantity: orderItem.quantity,
    // The STORED line total, never quantity × price.
    lineTotal,
    // A missing or non-array snapshot reads as "no modifiers" rather than
    // throwing — every historical row predates the column.
    modifiers: Array.isArray(orderItem.modifiers) ? orderItem.modifiers : [],
  };
}

function mapOrderRow(row: OrderRow): CompletedSaleReceipt | null {
  const subtotal = storedMoneyToFixedString(row.subtotal);
  const taxAmount = storedMoneyToFixedString(row.tax_amount);
  const tipAmount = storedMoneyToFixedString(row.tip_amount);
  const total = storedMoneyToFixedString(row.total);

  if (subtotal === null || taxAmount === null || tipAmount === null || total === null) {
    return null;
  }

  const items: CompletedSaleItem[] = [];

  for (const orderItem of row.order_items ?? []) {
    const item = toLineItem(orderItem);

    // A line whose money cannot be read drops the whole order rather than
    // showing a sale with a line missing — an incomplete receipt looks exactly
    // like a complete one. Same rule parseDeviceHistoryPage applies.
    if (item === null) return null;

    items.push(item);
  }

  return {
    orderId: row.id,
    orderNumber: row.order_number,
    paymentMethod: row.payment_method,
    subtotal,
    taxAmount,
    tipAmount,
    total,
    createdAt: row.created_at,
    items,
    // Feature 28C — present for an owner sale taken since that column existed.
    // A device sale's presentation lives in its build's config_snapshot and is
    // deliberately NOT joined here: that snapshot carries the entire menu, and
    // fetching twenty of them to render one header would be a real cost for a
    // view whose fallback (the owner's own current configuration, explicitly
    // marked as current) is already honest.
    presentation: row.receipt_snapshot ?? undefined,
  };
}

export async function getProjectOrders(projectId: string): Promise<{
  /** The number-typed history model, projected from `receipts`. */
  orders: CompletedOrder[];
  /** Feature 28A — the canonical receipts, for anything that renders one. */
  receipts: CompletedSaleReceipt[];
  error: string | null;
}> {
  const supabase = await createClient();

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsData?.claims ?? null;

  if (claimsError || !claims) {
    return {
      orders: [],
      receipts: [],
      error: "You must be signed in to view order history.",
    };
  }

  const { data, error } = await supabase
    .from("orders")
    .select(
      `
      id,
      order_number,
      payment_method,
      subtotal,
      tax_amount,
      tip_amount,
      total,
      created_at,
      receipt_snapshot,
      order_items (
        item_id,
        item_name,
        unit_price,
        quantity,
        line_total,
        modifiers,
        line_position
      )
    `
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    // Feature 28C — the SAME line ordering complete_sale* and
    // get_device_recent_orders use, so the Builder cannot list a sale's lines
    // in a different order from the slip the customer was handed. item_id alone
    // is not a total order: two lines of the same product with different
    // options tie on it, and a tie left to the planner is not reproducible.
    .order("line_position", { referencedTable: "order_items", nullsFirst: false })
    .order("item_id", { referencedTable: "order_items" })
    .order("id", { referencedTable: "order_items" })
    .limit(20);

  if (error) {
    return { orders: [], receipts: [], error: error.message };
  }

  const receipts: CompletedSaleReceipt[] = [];

  for (const row of data ?? []) {
    const receipt = mapOrderRow(row as unknown as OrderRow);

    if (receipt !== null) {
      receipts.push(receipt);
    }
  }

  return { orders: receipts.map(toCompletedOrder), receipts, error: null };
}

// Feature 14.3 correction — an exact, count-only loader for the runtime's
// order-number seed. Deliberately separate from getProjectOrders above
// (which stays capped at the 20 most recent orders — that bound is correct
// for a "recent orders" display and must not change here): a project with
// more than 20 historical orders would otherwise have its true order count
// undercounted, letting the runtime generate an order number that collides
// with a real, older order beyond that window. Uses Supabase's
// count-only/head query (`{ count: "exact", head: true }`) so no order rows
// are ever downloaded — only a single integer comes back over the wire.
// Same auth pattern as every other function in this file, so RLS/ownership
// enforcement is unchanged: an unauthenticated caller, or a projectId this
// user doesn't own, gets no usable count.
export async function getProjectOrderCount(projectId: string): Promise<{
  count: number;
  error: string | null;
}> {
  const supabase = await createClient();

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsData?.claims ?? null;

  if (claimsError || !claims) {
    return {
      count: 0,
      error: "You must be signed in to view order history.",
    };
  }

  const { count, error } = await supabase
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("project_id", projectId);

  if (error) {
    // Feature 14.3 correction — never surface the raw Supabase error here:
    // this count directly determines the next real, persisted order
    // number, so the caller must treat any failure as "count unknown," not
    // as debugging detail to display.
    return {
      count: 0,
      error: "Unable to verify order history for this project.",
    };
  }

  return { count: count ?? 0, error: null };
}
