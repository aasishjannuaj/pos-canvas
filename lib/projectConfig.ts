// Feature 12.1 — the neutral home for ProjectConfig and its nested types,
// plus the single shared default/starter configuration value. This module
// has no dependency on EditorShell.tsx (or any "use client" component) so
// that data/templates.ts (the template registry) can reference ProjectConfig
// and the starter default without creating a circular import between the
// registry and the Builder. EditorShell.tsx imports from here too, and
// re-exports the same bindings so every existing
// `import type { ProjectConfig } from "@/components/editor/EditorShell"`
// call site elsewhere in the app keeps working unchanged.

// Feature 12.2 — category is a plain, project-configurable string rather
// than a fixed union (previously "Breakfast" | "Lunch" | "Drinks", which
// blocked every non-restaurant template from having honest category names).
// Nothing outside the Builder's own Menu editing UI depends on the specific
// value, so widening this is compatible with every existing saved project.
export type MenuItem = {
  id: string;
  name: string;
  price: number;
  category: string;
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
  // Feature 11.1 — printable receipt configuration. businessAddress/
  // businessPhone lived here until Feature 13.1, when they moved into
  // BusinessProfile (core business identity, not receipt formatting) — see
  // BusinessProfile below. ReceiptSettings now holds only formatting/
  // visibility concerns.
  showBusinessName: boolean;
  headerMessage: string;
  showTaxLine: boolean;
  showTipLine: boolean;
  showPaymentMethod: boolean;
  showOrderNumber: boolean;
};

// Feature 13.1 — visual appearance only. businessName moved out to
// BusinessProfile (identity, not appearance) below.
export type BrandingSettings = {
  accentColor: string;
};

// Feature 13.1 — the customer-facing business identity/contact record,
// separate from the project's own internal dashboard name (`projects.name`,
// never stored here) and from BrandingSettings/ReceiptSettings (appearance
// and receipt-formatting concerns respectively). This is the single source
// of truth for business name, address, phone, email, and website across the
// POS header, the receipt, and any future generated-app metadata.
export type BusinessProfile = {
  businessName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  phone: string;
  email: string;
  website: string;
};

export type ProjectConfig = {
  menuItems: MenuItem[];
  branding: BrandingSettings;
  businessProfile: BusinessProfile;
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
    accentColor: "#2563EB",
  },
  businessProfile: {
    businessName: "Restaurant POS",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    phone: "",
    email: "",
    website: "",
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
    businessProfile: { ...config.businessProfile },
    tax: { ...config.tax },
    receipt: { ...config.receipt },
  };
}
