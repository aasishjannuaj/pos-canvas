import type { PaymentMethod } from "@/lib/cart";

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
  /**
   * v1.3 Feature 1F — who rang this sale, or null.
   *
   * NULL IS A REAL AND PERMANENT ANSWER. Legacy v1.2 sales predate employees
   * entirely, and an offline sale can be recorded with only partial
   * attribution. Such a sale is "Unattributed": it stays in every total, it is
   * never reassigned, and it is never rewritten.
   */
  employeeId: string | null;
  /**
   * The register session this sale belongs to, or null.
   *
   * Its presence is what decides whether an authoritative business date exists
   * for this order (see list_order_business_dates). Null means this product
   * never recorded a business day for the sale -- not that the sale is invalid.
   */
  registerSessionId: string | null;
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
