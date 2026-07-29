import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { OrderLineItem, OrderTotal } from "@/lib/dashboard.types";
import type { PaymentMethod } from "@/lib/cart";

type OrderItemDetailRow = {
  item_id: string;
  item_name: string;
  quantity: number;
  line_total: number;
};

type OrderTotalRow = {
  id: string;
  order_number: string;
  subtotal: number;
  tax_amount: number;
  tip_amount: number;
  total: number;
  payment_method: PaymentMethod;
  created_at: string;
  order_items: OrderItemDetailRow[] | null;
};

function mapOrderTotalRow(row: OrderTotalRow): OrderTotal {
  const items: OrderLineItem[] = (row.order_items ?? []).map((item) => ({
    itemId: item.item_id,
    itemName: item.item_name,
    quantity: item.quantity,
    lineTotal: item.line_total,
  }));

  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  return {
    id: row.id,
    orderNumber: row.order_number,
    subtotal: row.subtotal,
    taxAmount: row.tax_amount,
    tip: row.tip_amount,
    total: row.total,
    paymentMethod: row.payment_method,
    itemCount,
    items,
    createdAt: row.created_at,
  };
}

// Feature 10.1/10.2/10.3 — shared project-level reporting loader, used by
// the Business Dashboard, the Sales Report, and Product Performance. Every
// row in `orders` is already a completed, paid sale (rows only ever get
// inserted by the complete_sale RPC once a sale succeeds — there is no
// draft/pending status column), so no status filter is needed here. Unlike
// getProjectOrders (orders.server.ts), this has no row limit — the
// Dashboard's "today" figures, the Sales Report's "All Time" range, and
// Product Performance's per-product aggregation all need the full history,
// not just the most recent 20. The order_items join now carries item_id/
// item_name/line_total in addition to quantity (Feature 10.3 — Product
// Performance needs to know *which* product each unit belongs to; itemCount
// above is unaffected, still a flat per-order sum for the Dashboard/Sales
// Report). This is one query widened, not a second unbounded query.
export async function getProjectOrderTotals(projectId: string): Promise<{
  orderTotals: OrderTotal[];
  error: string | null;
}> {
  const supabase = await createClient();

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsData?.claims ?? null;

  if (claimsError || !claims) {
    return {
      orderTotals: [],
      error: "You must be signed in to view the dashboard.",
    };
  }

  const { data, error } = await supabase
    .from("orders")
    .select(
      `
      id,
      order_number,
      subtotal,
      tax_amount,
      tip_amount,
      total,
      payment_method,
      created_at,
      order_items (
        item_id,
        item_name,
        quantity,
        line_total
      )
    `
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (error) {
    return { orderTotals: [], error: error.message };
  }

  const orderTotals: OrderTotal[] = (data ?? []).map((row) =>
    mapOrderTotalRow(row as OrderTotalRow)
  );

  return { orderTotals, error: null };
}
