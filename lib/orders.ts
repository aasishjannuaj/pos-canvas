import { createClient } from "@/lib/supabase/client";
import type { CartItem, PaymentMethod } from "@/lib/cart";
import { isCompletedSaleReceipt } from "@/lib/completedSale";
import type { CompletedSaleReceipt } from "@/lib/completedSale";

type CompleteSaleOrderInput = {
  projectId: string;
  orderNumber: string;
  paymentMethod: PaymentMethod;
  subtotal: number;
  taxAmount: number;
  tipAmount: number;
  total: number;
  items: CartItem[];
};

export async function completeSaleOrder({
  projectId,
  orderNumber,
  paymentMethod,
  subtotal,
  taxAmount,
  tipAmount,
  total,
  items,
}: CompleteSaleOrderInput): Promise<{
  orderId: string | null;
  error: string | null;
}> {
  const supabase = createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return {
      orderId: null,
      error: "You must be signed in to complete a sale.",
    };
  }

  const { data, error } = await supabase.rpc("complete_sale", {
    p_project_id: projectId,
    p_order_number: orderNumber,
    p_payment_method: paymentMethod,
    p_subtotal: subtotal,
    p_tax_amount: taxAmount,
    p_tip_amount: tipAmount,
    p_total: total,
    p_items: items,
  });

  if (error) {
    return { orderId: null, error: error.message };
  }

  return { orderId: data as string, error: null };
}

// ---------------------------------------------------------------------------
// Migration D3 — complete_sale_v2.
//
// The v1 helper above stays exported and unchanged so a stale open tab, and a
// deployment rollback, both keep working. New checkout flows use v2.
//
// Money arrives as fixed two-decimal STRINGS, exactly as numeric(12,2)::text
// produced them. They are never parsed back into a JavaScript number for
// display: an IEEE-754 round-trip is precisely the drift this representation
// exists to avoid.
// ---------------------------------------------------------------------------

export type CompleteSaleV2Request = {
  projectId: string;
  paymentMethod: PaymentMethod;
  tipAmount: number;
  /** Only the client-authoritative fields; names and prices are server-derived. */
  items: { itemId: string; quantity: number }[];
  saleRequestId: string;
};

// ---------------------------------------------------------------------------
// Feature 18.2 — complete_sale_v3.
//
// The v2 helper below stays exported and unchanged so a stale open tab keeps
// working and a deployment rollback remains possible, exactly as v1 was kept
// when D3 introduced v2.
//
// v3 is the path every current sale takes. It differs from v2 in one respect
// visible here: each line may carry modifier IDENTIFIERS. There is still
// nowhere in this shape for a client name, price, tax or total.
// ---------------------------------------------------------------------------

export type CompleteSaleV3Request = {
  projectId: string;
  paymentMethod: PaymentMethod;
  tipAmount: number;
  items: {
    itemId: string;
    quantity: number;
    modifiers: { groupId: string; optionIds: string[] }[];
  }[];
  saleRequestId: string;
};

export async function completeSaleOrderV3({
  projectId,
  paymentMethod,
  tipAmount,
  items,
  saleRequestId,
}: CompleteSaleV3Request): Promise<{
  receipt: CompletedSaleReceipt | null;
  error: string | null;
}> {
  const supabase = createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return { receipt: null, error: "You must be signed in to complete a sale." };
  }

  const { data, error } = await supabase.rpc("complete_sale_v3", {
    p_project_id: projectId,
    p_payment_method: paymentMethod,
    p_tip_amount: tipAmount,
    // Identifiers only. Names, prices, tax and totals are all resolved by
    // complete_sale_v3 from the authorized config.
    p_items: items.map((item) => ({
      itemId: item.itemId,
      quantity: item.quantity,
      modifiers: item.modifiers.map((group) => ({
        groupId: group.groupId,
        optionIds: group.optionIds,
      })),
    })),
    p_sale_request_id: saleRequestId,
  });

  if (error) {
    return { receipt: null, error: error.message };
  }

  if (!isCompletedSaleReceipt(data)) {
    return { receipt: null, error: "The sale response could not be read." };
  }

  return { receipt: data, error: null };
}

export async function completeSaleOrderV2({
  projectId,
  paymentMethod,
  tipAmount,
  items,
  saleRequestId,
}: CompleteSaleV2Request): Promise<{
  receipt: CompletedSaleReceipt | null;
  error: string | null;
}> {
  const supabase = createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return { receipt: null, error: "You must be signed in to complete a sale." };
  }

  const { data, error } = await supabase.rpc("complete_sale_v2", {
    p_project_id: projectId,
    p_payment_method: paymentMethod,
    p_tip_amount: tipAmount,
    // Deliberately only itemId and quantity — v2 has nowhere to put a client
    // name, price or total, so tampering is structurally impossible.
    p_items: items.map((item) => ({
      itemId: item.itemId,
      quantity: item.quantity,
    })),
    p_sale_request_id: saleRequestId,
  });

  if (error) {
    return { receipt: null, error: error.message };
  }

  if (!isCompletedSaleReceipt(data)) {
    return { receipt: null, error: "The sale response could not be read." };
  }

  return { receipt: data, error: null };
}
