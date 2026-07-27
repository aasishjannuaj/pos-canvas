import { createClient } from "@/lib/supabase/client";
import type {
  AdjustmentInventoryResult,
  RestockInventoryResult,
} from "@/lib/inventory.types";

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

function isValidInventoryRpcRow(value: unknown): value is RestockInventoryRpcResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const row = value as Record<string, unknown>;

  return (
    typeof row.transaction_id === "string" &&
    row.transaction_id.trim() !== "" &&
    typeof row.item_id === "string" &&
    row.item_id.trim() !== "" &&
    typeof row.item_name === "string" &&
    Number.isInteger(row.quantity_before) &&
    Number.isInteger(row.quantity_change) &&
    Number.isInteger(row.quantity_after)
  );
}

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

  if (!isValidInventoryRpcRow(data)) {
    return {
      result: null,
      error: "Invalid response from restock inventory.",
    };
  }

  const result: RestockInventoryResult = {
    transactionId: data.transaction_id,
    itemId: data.item_id,
    itemName: data.item_name,
    quantityBefore: data.quantity_before,
    quantityChange: data.quantity_change,
    quantityAfter: data.quantity_after,
  };

  return { result, error: null };
}

type AdjustInventoryInput = {
  projectId: string;
  itemId: string;
  newQuantity: number;
};

// Feature 9.7B — manual inventory adjustment. Unlike restockInventory (which
// sends a positive delta), this sends the exact final stock value; the
// database computes the signed quantity_change itself.
export async function adjustInventory({
  projectId,
  itemId,
  newQuantity,
}: AdjustInventoryInput): Promise<{
  result: AdjustmentInventoryResult | null;
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
      error: "You must be signed in to adjust inventory.",
    };
  }

  if (!projectId) {
    return {
      result: null,
      error: "A project is required to adjust inventory.",
    };
  }

  if (!itemId || itemId.trim() === "") {
    return {
      result: null,
      error: "An item is required to adjust inventory.",
    };
  }

  if (!Number.isInteger(newQuantity) || newQuantity < 0) {
    return {
      result: null,
      error: "New stock must be a whole number of 0 or more.",
    };
  }

  const { data, error } = await supabase.rpc("adjust_inventory", {
    p_project_id: projectId,
    p_item_id: itemId,
    p_new_quantity: newQuantity,
  });

  if (error) {
    return { result: null, error: error.message };
  }

  if (!isValidInventoryRpcRow(data)) {
    return {
      result: null,
      error: "Invalid response from adjust inventory.",
    };
  }

  const result: AdjustmentInventoryResult = {
    transactionId: data.transaction_id,
    itemId: data.item_id,
    itemName: data.item_name,
    quantityBefore: data.quantity_before,
    quantityChange: data.quantity_change,
    quantityAfter: data.quantity_after,
  };

  return { result, error: null };
}
