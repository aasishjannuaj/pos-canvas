// Feature 12.1 — the single, canonical template registry. Every page/
// component that lists templates, links to one, or needs a template's
// starter configuration must import from here rather than maintaining its
// own copy — this file replaces six previously-independent, inconsistent
// hardcoded lists (see the Feature 12.1 plan for the full inventory).
//
// Deliberately depends only on lib/projectConfig.ts and lib/posLayout.ts
// (both neutral modules with no "use client" component in their import
// chain), never on components/editor/EditorShell.tsx or any React
// component — that keeps the dependency graph a straight line
// (lib/projectConfig.ts/lib/posLayout.ts <- data/templates.ts, and
// separately <- EditorShell.tsx / the pos-layouts component registry)
// instead of a cycle. The UI-layer layout component registry
// (components/editor/pos-layouts/index.ts) imports PosLayout from
// lib/posLayout.ts too, never from this file.
import type {
  BusinessProfile,
  MenuItem,
  ProjectConfig,
  ReceiptSettings,
  TaxSettings,
} from "@/lib/projectConfig";
import { defaultProjectConfig, cloneProjectConfig } from "@/lib/projectConfig";
import type { PosLayout } from "@/lib/posLayout";

export type Template = {
  id: string;
  name: string;
  category: string;
  description: string;
  icon: string;
  features: string[];
  // Feature 12.2 — each template now points at its own starter
  // configuration (see below) rather than all six sharing the identical
  // restaurant-style default. getStarterConfig() below always returns a
  // fresh clone of whatever this points to, never this reference itself.
  starterConfig: ProjectConfig;
  // Feature 12.3 — layout identity lives here, in the canonical registry,
  // not in ProjectConfig — it's derived from template_id at render time
  // (see app/editor/[id]/page.tsx), never persisted separately.
  layout: PosLayout;
};

// Feature 12.1 correction — all six templates run on the exact same shared
// POS engine and layout today (see components/editor/EditorShell.tsx). None
// has a distinct business-specific workflow, so every template lists the
// same, honest, currently-implemented capabilities rather than
// business-specific features that don't exist.
const SHARED_FEATURES = [
  "Customizable products and categories",
  "Prices and taxes",
  "Inventory tracking",
  "Checkout and completed sales",
  "Receipt settings and printing",
  "Sales and inventory reports",
];

// Feature 12.2 — tax defaults are identical across all six templates (no
// confirmed reason to differ yet). cloneProjectConfig() copies this object
// fresh for every new editor session regardless of how many templates
// happen to reference the same source object here, so sharing this
// reference across template entries never risks cross-session mutation.
const SHARED_TAX: TaxSettings = {
  enabled: true,
  rate: 6.35,
  pricesIncludeTax: false,
  showTaxSeparately: true,
};

// Feature 12.2 — every receipt setting except footer/tipsEnabled is
// identical across templates (no confirmed reason to differ yet).
// Feature 13.1 — businessAddress/businessPhone removed: receipt formatting
// no longer carries business identity/contact data (see buildBusinessProfile
// below).
function buildReceiptSettings(
  footer: string,
  tipsEnabled: boolean
): ReceiptSettings {
  return {
    currency: "USD",
    footer,
    orderPrefix: "ORD-",
    tipsEnabled,
    showBusinessName: true,
    headerMessage: "",
    showTaxLine: true,
    showTipLine: true,
    showPaymentMethod: true,
    showOrderNumber: true,
  };
}

// Feature 13.1 — every template's starter business profile carries only its
// real business name forward from the old branding.businessName field;
// address/phone/email/website all start empty (no confirmed real-world
// value to invent, matching the "no fabricated completeness" convention
// from Feature 12.1).
function buildBusinessProfile(businessName: string): BusinessProfile {
  return {
    businessName,
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    phone: "",
    email: "",
    website: "",
  };
}

// Feature 12.2 — Cafe starter menu. Item ids are prefixed "cafe-" so they
// can never collide with another template's ids.
const cafeMenuItems: MenuItem[] = [
  { id: "cafe-1", name: "Drip Coffee", price: 2.75, category: "Coffee", trackInventory: true, stockQuantity: 20 },
  { id: "cafe-2", name: "Latte", price: 4.25, category: "Coffee", trackInventory: true, stockQuantity: 20 },
  { id: "cafe-3", name: "Cappuccino", price: 4.0, category: "Coffee", trackInventory: true, stockQuantity: 20 },
  { id: "cafe-4", name: "Croissant", price: 3.25, category: "Pastries", trackInventory: true, stockQuantity: 20 },
  { id: "cafe-5", name: "Blueberry Muffin", price: 3.0, category: "Pastries", trackInventory: true, stockQuantity: 20 },
  { id: "cafe-6", name: "Iced Tea", price: 2.75, category: "Drinks", trackInventory: true, stockQuantity: 20 },
  { id: "cafe-7", name: "Bottled Water", price: 1.75, category: "Drinks", trackInventory: true, stockQuantity: 20 },
];

const cafeStarterConfig: ProjectConfig = {
  menuItems: cafeMenuItems,
  branding: { accentColor: "#B45309" },
  businessProfile: buildBusinessProfile("Daily Grind Cafe"),
  tax: SHARED_TAX,
  receipt: buildReceiptSettings(
    "Thanks for stopping in — see you tomorrow!",
    false
  ),
};

// Feature 12.2 — Retail starter catalog. Item ids prefixed "retail-".
const retailMenuItems: MenuItem[] = [
  { id: "retail-1", name: "Bread Loaf", price: 3.49, category: "Grocery", trackInventory: true, stockQuantity: 20 },
  { id: "retail-2", name: "Milk (1 Gal)", price: 3.99, category: "Grocery", trackInventory: true, stockQuantity: 20 },
  { id: "retail-3", name: "Eggs (Dozen)", price: 4.29, category: "Grocery", trackInventory: true, stockQuantity: 20 },
  { id: "retail-4", name: "Paper Towels", price: 5.99, category: "Household", trackInventory: true, stockQuantity: 20 },
  { id: "retail-5", name: "Dish Soap", price: 2.99, category: "Household", trackInventory: true, stockQuantity: 20 },
  { id: "retail-6", name: "Trash Bags", price: 6.49, category: "Household", trackInventory: true, stockQuantity: 20 },
];

const retailStarterConfig: ProjectConfig = {
  menuItems: retailMenuItems,
  branding: { accentColor: "#059669" },
  businessProfile: buildBusinessProfile("Main Street Mercantile"),
  tax: SHARED_TAX,
  receipt: buildReceiptSettings("Thank you for shopping with us!", false),
};

// Feature 12.2 — Liquor Store starter catalog. Item ids prefixed "liquor-".
// Generic descriptive product names only, no real brand names. No
// age-verification behavior or claims are added anywhere — this is starter
// product data only.
const liquorStoreMenuItems: MenuItem[] = [
  { id: "liquor-1", name: "Domestic Lager 6-Pack", price: 9.99, category: "Beer", trackInventory: true, stockQuantity: 20 },
  { id: "liquor-2", name: "IPA 6-Pack", price: 12.99, category: "Beer", trackInventory: true, stockQuantity: 20 },
  { id: "liquor-3", name: "House Red Wine", price: 14.99, category: "Wine", trackInventory: true, stockQuantity: 20 },
  { id: "liquor-4", name: "House White Wine", price: 13.99, category: "Wine", trackInventory: true, stockQuantity: 20 },
  { id: "liquor-5", name: "Vodka 750ml", price: 19.99, category: "Spirits", trackInventory: true, stockQuantity: 20 },
  { id: "liquor-6", name: "Whiskey 750ml", price: 24.99, category: "Spirits", trackInventory: true, stockQuantity: 20 },
];

const liquorStoreStarterConfig: ProjectConfig = {
  menuItems: liquorStoreMenuItems,
  branding: { accentColor: "#7C2D12" },
  businessProfile: buildBusinessProfile("Harborview Liquor"),
  tax: SHARED_TAX,
  receipt: buildReceiptSettings(
    "Please drink responsibly. Thank you for your business!",
    false
  ),
};

// Feature 12.2 — Food Truck starter menu: deliberately small (a single
// window, a moving line). Item ids prefixed "foodtruck-". Stock is 15
// rather than the usual 20 to reflect a truck's smaller storage capacity —
// the one confirmed reason to differ.
const foodTruckMenuItems: MenuItem[] = [
  { id: "foodtruck-1", name: "Street Taco", price: 3.5, category: "Food", trackInventory: true, stockQuantity: 15 },
  { id: "foodtruck-2", name: "Loaded Fries", price: 6.5, category: "Food", trackInventory: true, stockQuantity: 15 },
  { id: "foodtruck-3", name: "Fresh Lemonade", price: 2.75, category: "Drinks", trackInventory: true, stockQuantity: 15 },
  { id: "foodtruck-4", name: "Bottled Water", price: 1.5, category: "Drinks", trackInventory: true, stockQuantity: 15 },
];

const foodTruckStarterConfig: ProjectConfig = {
  menuItems: foodTruckMenuItems,
  branding: { accentColor: "#EA580C" },
  businessProfile: buildBusinessProfile("Rolling Fork Food Truck"),
  tax: SHARED_TAX,
  receipt: buildReceiptSettings("Thanks for grabbing a bite with us!", false),
};

// Feature 12.2 — Salon starter service menu. Item ids prefixed "salon-".
// Services, so every item is trackInventory: false / stockQuantity: 0 — no
// appointment scheduling or other service-specific logic is added anywhere,
// this is starter data only, rendered by the exact same shared engine.
const salonMenuItems: MenuItem[] = [
  { id: "salon-1", name: "Haircut", price: 35.0, category: "Hair", trackInventory: false, stockQuantity: 0 },
  { id: "salon-2", name: "Hair Color", price: 75.0, category: "Hair", trackInventory: false, stockQuantity: 0 },
  { id: "salon-3", name: "Manicure", price: 25.0, category: "Nails", trackInventory: false, stockQuantity: 0 },
  { id: "salon-4", name: "Pedicure", price: 35.0, category: "Nails", trackInventory: false, stockQuantity: 0 },
  { id: "salon-5", name: "60-Minute Massage", price: 90.0, category: "Spa", trackInventory: false, stockQuantity: 0 },
];

const salonStarterConfig: ProjectConfig = {
  menuItems: salonMenuItems,
  branding: { accentColor: "#DB2777" },
  businessProfile: buildBusinessProfile("Bloom Hair & Spa"),
  tax: SHARED_TAX,
  // Feature 12.2 — the one approved starter-value difference beyond
  // business name/menu/footer: tipping is on by default for salon services,
  // matching common real-world norms. Still just a pre-set value on the
  // existing, fully generic tipsEnabled toggle — no new logic.
  receipt: buildReceiptSettings(
    "Thank you for visiting — we can't wait to see you again!",
    true
  ),
};

// Feature 12.1 — the six templates with consistent representation across
// the app today. "Barber Shop" and "Corner Convenience" previously appeared
// only in the old templates-gallery list, with no matching detail-page copy
// or editor display name anywhere else — dropped rather than fabricated to
// match, per the decision not to invent template completeness that doesn't
// exist. They can be added for real later.
export const templates: Template[] = [
  {
    id: "restaurant",
    name: "Classic Restaurant",
    category: "Restaurant",
    description:
      "A customizable point-of-sale for restaurant-style menus, with checkout, tax, inventory tracking, receipts, and sales reporting built in.",
    icon: "🍔",
    features: SHARED_FEATURES,
    // Feature 12.2 — unchanged: this is still the exact same starter
    // configuration restaurant has always used (also EditorShell's own
    // fallback-of-last-resort default).
    starterConfig: defaultProjectConfig,
    layout: "menu-grid",
  },
  {
    id: "cafe",
    name: "Cozy Cafe",
    category: "Cafe",
    description:
      "A customizable point-of-sale for cafe and coffee-shop menus, with the same checkout, tax, inventory, receipt, and reporting tools.",
    icon: "☕",
    features: SHARED_FEATURES,
    starterConfig: cafeStarterConfig,
    layout: "menu-grid",
  },
  {
    id: "retail",
    name: "Modern Retail",
    category: "Retail",
    description:
      "A customizable point-of-sale for a retail product catalog, with checkout, tax, inventory tracking, receipts, and sales reporting built in.",
    icon: "🛍",
    features: SHARED_FEATURES,
    starterConfig: retailStarterConfig,
    layout: "product-grid",
  },
  {
    id: "liquor-store",
    name: "Liquor Store Essentials",
    category: "Liquor Store",
    description:
      "A customizable point-of-sale for a liquor store's product list, with checkout, tax, inventory tracking, receipts, and sales reporting built in.",
    icon: "🍺",
    features: SHARED_FEATURES,
    starterConfig: liquorStoreStarterConfig,
    layout: "product-grid",
  },
  {
    id: "food-truck",
    name: "Street Food Truck",
    category: "Food Truck",
    description:
      "A customizable point-of-sale for a food truck menu, with checkout, tax, inventory tracking, receipts, and sales reporting built in.",
    icon: "🚚",
    features: SHARED_FEATURES,
    starterConfig: foodTruckStarterConfig,
    layout: "menu-grid",
  },
  {
    id: "salon",
    name: "Salon & Spa",
    category: "Salon",
    description:
      "A customizable point-of-sale for salon and spa service menus, with checkout, tax, inventory tracking, receipts, and sales reporting built in.",
    icon: "💇",
    features: SHARED_FEATURES,
    starterConfig: salonStarterConfig,
    layout: "service-grid",
  },
];

// Feature 12.1 — used as the display/registry fallback for a legacy or
// unrecognized template id (see getStarterConfig below). Never used to
// overwrite or replace an existing saved project's own configuration — a
// saved project's `config` column is always loaded instead, regardless of
// whether its template_id matches a known template.
export const DEFAULT_TEMPLATE_ID = "restaurant";

export function getTemplateById(id: string): Template | undefined {
  return templates.find((template) => template.id === id);
}

// Feature 12.1 — the only way any caller should obtain a starter
// configuration. Always returns an independent clone (see
// cloneProjectConfig), so a new editor session's local edits can never
// mutate the shared module-level default/template entries or leak into
// another session through a shared array/object reference. Falls back to
// the shared default for any id that doesn't match a known template.
export function getStarterConfig(templateId: string): ProjectConfig {
  const template = getTemplateById(templateId);
  return cloneProjectConfig(template?.starterConfig ?? defaultProjectConfig);
}
