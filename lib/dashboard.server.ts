import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { OrderTotal } from "@/lib/dashboard.types";
import type { PaymentMethod } from "@/components/editor/EditorShell";

type OrderItemQuantityRow = {
  quantity: number;
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
  order_items: OrderItemQuantityRow[] | null;
};

function mapOrderTotalRow(row: OrderTotalRow): OrderTotal {
  const itemCount = (row.order_items ?? []).reduce(
    (sum, item) => sum + item.quantity,
    0
  );

  return {
    id: row.id,
    orderNumber: row.order_number,
    subtotal: row.subtotal,
    taxAmount: row.tax_amount,
    tip: row.tip_amount,
    total: row.total,
    paymentMethod: row.payment_method,
    itemCount,
    createdAt: row.created_at,
  };
}

// Feature 10.1/10.2 — shared project-level reporting loader, used by both
// the Business Dashboard and the Sales Report. Every row in `orders` is
// already a completed, paid sale (rows only ever get inserted by the
// complete_sale RPC once a sale succeeds — there is no draft/pending status
// column), so no status filter is needed here. Unlike getProjectOrders
// (orders.server.ts), this has no row limit — both the Dashboard's "today"
// figures and the Sales Report's "All Time" range need the full history,
// not just the most recent 20. The order_items join is trimmed to just
// `quantity` (Feature 10.2 — item-count column), not the full line-item
// detail getProjectOrders fetches for receipts.
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
        quantity
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
