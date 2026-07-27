import "server-only";

import { createClient } from "@/lib/supabase/server";
import type {
  InventoryTransaction,
  InventoryTransactionType,
} from "@/lib/inventory.types";

type InventoryTransactionRow = {
  id: string;
  order_id: string | null;
  item_id: string;
  item_name: string;
  transaction_type: InventoryTransactionType;
  quantity_change: number;
  quantity_before: number;
  quantity_after: number;
  created_at: string;
};

function mapInventoryTransactionRow(
  row: InventoryTransactionRow
): InventoryTransaction {
  return {
    id: row.id,
    orderId: row.order_id,
    itemId: row.item_id,
    itemName: row.item_name,
    transactionType: row.transaction_type,
    quantityChange: row.quantity_change,
    quantityBefore: row.quantity_before,
    quantityAfter: row.quantity_after,
    createdAt: row.created_at,
  };
}

// Feature 9.4/10.4 — shared inventory-history loader. Used by the Inventory
// Activity panel (which only ever displays the first 10 entries itself) and
// by the Inventory Summary report (which needs full history for "All Time"
// movement, and correct totals for narrower ranges too). Previously capped
// at 50 rows — that cap was a DB-safety default, not a business rule tied to
// the number 50 anywhere in the UI, so it's removed here rather than adding
// a second, duplicate unbounded query against the same table.
export async function getProjectInventoryTransactions(
  projectId: string
): Promise<{
  transactions: InventoryTransaction[];
  error: string | null;
}> {
  const supabase = await createClient();

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsData?.claims ?? null;

  if (claimsError || !claims) {
    return {
      transactions: [],
      error: "You must be signed in to view inventory activity.",
    };
  }

  const { data, error } = await supabase
    .from("inventory_transactions")
    .select(
      "id, order_id, item_id, item_name, transaction_type, quantity_change, quantity_before, quantity_after, created_at"
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (error) {
    return { transactions: [], error: error.message };
  }

  const transactions: InventoryTransaction[] = (data ?? []).map((row) =>
    mapInventoryTransactionRow(row as InventoryTransactionRow)
  );

  return { transactions, error: null };
}
