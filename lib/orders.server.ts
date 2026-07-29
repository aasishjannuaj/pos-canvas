import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { CartItem, CompletedOrder, PaymentMethod } from "@/lib/cart";

type OrderItemRow = {
  item_id: string;
  item_name: string;
  unit_price: number;
  quantity: number;
  line_total: number;
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
  order_items: OrderItemRow[] | null;
};

function mapOrderRow(row: OrderRow): CompletedOrder {
  const items: CartItem[] = (row.order_items ?? []).map((orderItem) => ({
    itemId: orderItem.item_id,
    name: orderItem.item_name,
    price: orderItem.unit_price,
    quantity: orderItem.quantity,
  }));

  return {
    id: row.id,
    orderNumber: row.order_number,
    items,
    subtotal: row.subtotal,
    taxAmount: row.tax_amount,
    tip: row.tip_amount,
    total: row.total,
    paymentMethod: row.payment_method,
    createdAt: row.created_at,
  };
}

export async function getProjectOrders(projectId: string): Promise<{
  orders: CompletedOrder[];
  error: string | null;
}> {
  const supabase = await createClient();

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsData?.claims ?? null;

  if (claimsError || !claims) {
    return {
      orders: [],
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
      order_items (
        item_id,
        item_name,
        unit_price,
        quantity,
        line_total
      )
    `
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    return { orders: [], error: error.message };
  }

  const orders: CompletedOrder[] = (data ?? []).map((row) =>
    mapOrderRow(row as OrderRow)
  );

  return { orders, error: null };
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
