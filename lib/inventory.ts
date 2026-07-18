import { createClient } from "@/lib/supabase/client";
import type { RestockInventoryResult } from "@/lib/inventory.types";

type RestockInventoryInput = {
  projectId: string;
  itemId: string;
  quantity: number;
};

type RestockInventoryRpcResponse = {
  transaction_id: string;
  item_id: string;
  item_name: string;
  quantity_before: number;
  quantity_change: number;
  quantity_after: number;
};

export async function restockInventory({
  projectId,
  itemId,
  quantity,
}: RestockInventoryInput): Promise<{
  result: RestockInventoryResult | null;
  error: string | null;
}> {
  const supabase = createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return {
      result: null,
      error: "You must be signed in to restock inventory.",
    };
  }

  if (!projectId) {
    return {
      result: null,
      error: "A project is required to restock inventory.",
    };
  }

  if (!itemId || itemId.trim() === "") {
    return {
      result: null,
      error: "An item is required to restock inventory.",
    };
  }

  if (!Number.isInteger(quantity) || quantity <= 0) {
    return {
      result: null,
      error: "Quantity must be a positive whole number.",
    };
  }

  const { data, error } = await supabase.rpc("restock_inventory", {
    p_project_id: projectId,
    p_item_id: itemId,
    p_quantity: quantity,
  });

  if (error) {
    return { result: null, error: error.message };
  }

  const row = data as RestockInventoryRpcResponse;

  const result: RestockInventoryResult = {
    transactionId: row.transaction_id,
    itemId: row.item_id,
    itemName: row.item_name,
    quantityBefore: row.quantity_before,
    quantityChange: row.quantity_change,
    quantityAfter: row.quantity_after,
  };

  return { result, error: null };
}
