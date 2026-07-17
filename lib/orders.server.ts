import "server-only";

import { createClient } from "@/lib/supabase/server";
import type {
  CartItem,
  CompletedOrder,
  PaymentMethod,
} from "@/components/editor/EditorShell";

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
