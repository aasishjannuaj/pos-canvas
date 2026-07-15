import { createClient } from "@/lib/supabase/client";
import type { CartItem, PaymentMethod } from "@/components/editor/EditorShell";

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
