import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { OrderTotal } from "@/lib/dashboard.types";

type OrderTotalRow = {
  id: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  created_at: string;
};

function mapOrderTotalRow(row: OrderTotalRow): OrderTotal {
  return {
    id: row.id,
    subtotal: row.subtotal,
    taxAmount: row.tax_amount,
    total: row.total,
    createdAt: row.created_at,
  };
}

// Feature 10.1 — project-level business dashboard summary. Every row in
// `orders` is already a completed, paid sale (rows only ever get inserted by
// the complete_sale RPC once a sale succeeds — there is no draft/pending
// status column), so no status filter is needed here. Unlike
// getProjectOrders (orders.server.ts), this has no row limit and skips the
// order_items join, since the dashboard only needs per-order totals.
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
    .select("id, subtotal, tax_amount, total, created_at")
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
