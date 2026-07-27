import type { PaymentMethod } from "@/components/editor/EditorShell";

// Feature 10.3 — per-line-item detail, needed for Product Performance's
// per-product aggregation. itemCount below stays a flat sum for the
// Dashboard/Sales Report, which never needed to know *which* product the
// units belonged to.
export type OrderLineItem = {
  itemId: string;
  itemName: string;
  quantity: number;
  lineTotal: number;
};

export type OrderTotal = {
  id: string;
  orderNumber: string;
  subtotal: number;
  taxAmount: number;
  tip: number;
  total: number;
  paymentMethod: PaymentMethod;
  itemCount: number;
  items: OrderLineItem[];
  createdAt: string;
};
