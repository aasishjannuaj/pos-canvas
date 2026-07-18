export type InventoryTransactionType = "sale" | "restock" | "adjustment";

export type InventoryTransaction = {
  id: string;
  orderId: string | null;
  itemId: string;
  itemName: string;
  transactionType: InventoryTransactionType;
  quantityChange: number;
  quantityBefore: number;
  quantityAfter: number;
  createdAt: string;
};

export type RestockInventoryResult = {
  transactionId: string;
  itemId: string;
  itemName: string;
  quantityBefore: number;
  quantityChange: number;
  quantityAfter: number;
};
