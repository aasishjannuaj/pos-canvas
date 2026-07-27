import type { PaymentMethod } from "@/components/editor/EditorShell";

export type OrderTotal = {
  id: string;
  orderNumber: string;
  subtotal: number;
  taxAmount: number;
  tip: number;
  total: number;
  paymentMethod: PaymentMethod;
  itemCount: number;
  createdAt: string;
};
