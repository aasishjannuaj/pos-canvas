// Feature 12.1 — the neutral home for ProjectConfig and its nested types,
// plus the single shared default/starter configuration value. This module
// has no dependency on EditorShell.tsx (or any "use client" component) so
// that data/templates.ts (the template registry) can reference ProjectConfig
// and the starter default without creating a circular import between the
// registry and the Builder. EditorShell.tsx imports from here too, and
// re-exports the same bindings so every existing
// `import type { ProjectConfig } from "@/components/editor/EditorShell"`
// call site elsewhere in the app keeps working unchanged.

export const MENU_CATEGORIES = ["Breakfast", "Lunch", "Drinks"] as const;

export type MenuCategory = (typeof MENU_CATEGORIES)[number];

export type MenuItem = {
  id: string;
  name: string;
  price: number;
  category: MenuCategory;
  trackInventory: boolean;
  stockQuantity: number;
};

export type Currency = "USD" | "CAD" | "EUR" | "GBP";

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  USD: "$",
  CAD: "CA$",
  EUR: "€",
  GBP: "£",
};

export type TaxSettings = {
  enabled: boolean;
  rate: number;
  pricesIncludeTax: boolean;
  showTaxSeparately: boolean;
};

export type ReceiptSettings = {
  currency: Currency;
  footer: string;
  orderPrefix: string;
  tipsEnabled: boolean;
  // Feature 11.1 — printable receipt configuration.
  showBusinessName: boolean;
  businessAddress: string;
  businessPhone: string;
  headerMessage: string;
  showTaxLine: boolean;
  showTipLine: boolean;
  showPaymentMethod: boolean;
  showOrderNumber: boolean;
};

export type BrandingSettings = {
  businessName: string;
  accentColor: string;
};

export type ProjectConfig = {
  menuItems: MenuItem[];
  branding: BrandingSettings;
  tax: TaxSettings;
  receipt: ReceiptSettings;
};

const defaultMenuItems: MenuItem[] = [
  {
    id: "1",
    name: "Bacon Egg & Cheese",
    price: 6.49,
    category: "Breakfast",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "2",
    name: "Egg & Cheese",
    price: 4.99,
    category: "Breakfast",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "3",
    name: "Hash Browns",
    price: 2.49,
    category: "Breakfast",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "4",
    name: "Coffee",
    price: 2.25,
    category: "Breakfast",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "5",
    name: "Turkey Grinder",
    price: 8.95,
    category: "Lunch",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "6",
    name: "Roast Beef",
    price: 9.25,
    category: "Lunch",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "7",
    name: "Chicken Grinder",
    price: 8.75,
    category: "Lunch",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "8",
    name: "Coke",
    price: 1.99,
    category: "Drinks",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "9",
    name: "Sprite",
    price: 1.99,
    category: "Drinks",
    trackInventory: true,
    stockQuantity: 20,
  },
  {
    id: "10",
    name: "Water",
    price: 1.49,
    category: "Drinks",
    trackInventory: true,
    stockQuantity: 20,
  },
];

// Feature 12.1 — the one shared starter configuration every template
// currently points to (see data/templates.ts). Value is unchanged from
// before this feature — only its location moved, so existing behavior for
// brand-new projects is identical.
export const defaultProjectConfig: ProjectConfig = {
  menuItems: defaultMenuItems,
  branding: {
    businessName: "Restaurant POS",
    accentColor: "#2563EB",
  },
  tax: {
    enabled: true,
    rate: 6.35,
    pricesIncludeTax: false,
    showTaxSeparately: true,
  },
  receipt: {
    currency: "USD",
    footer: "Thank you for visiting!",
    orderPrefix: "ORD-",
    tipsEnabled: false,
    showBusinessName: true,
    businessAddress: "",
    businessPhone: "",
    headerMessage: "",
    showTaxLine: true,
    showTipLine: true,
    showPaymentMethod: true,
    showOrderNumber: true,
  },
};

// Feature 12.1 — a safe, independent copy of a ProjectConfig. Used whenever
// a starter/registry configuration is handed to a new editor session, so
// that session's local edits (menu items, branding, etc.) can never mutate
// the shared module-level default or any other session's data through a
// shared nested array/object reference.
export function cloneProjectConfig(config: ProjectConfig): ProjectConfig {
  return {
    menuItems: config.menuItems.map((item) => ({ ...item })),
    branding: { ...config.branding },
    tax: { ...config.tax },
    receipt: { ...config.receipt },
  };
}
