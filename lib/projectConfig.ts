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

// Feature 14.1 — the structural validity guard for a raw, possibly-legacy
// `projects.config` JSON value, moved here (unchanged) from
// app/editor/[id]/page.tsx so both the Builder's page-load path and any
// future non-React caller (e.g. the generated-config export in
// lib/generatedPosConfig.ts) can reuse the exact same check instead of each
// defining their own copy. Deliberately loose: it only confirms the value
// is shaped enough to normalize safely below (an array for menuItems, plain
// objects for branding/tax/receipt) — it does not require businessProfile
// to exist, since that's exactly the field a pre-13.1 saved project won't
// have yet, and normalizeBusinessProfile below is what recovers it.
export function isProjectConfig(value: unknown): value is ProjectConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    Array.isArray(candidate.menuItems) &&
    typeof candidate.branding === "object" &&
    candidate.branding !== null &&
    typeof candidate.tax === "object" &&
    candidate.tax !== null &&
    typeof candidate.receipt === "object" &&
    candidate.receipt !== null
  );
}

// Feature 12.2 — normalize a loaded category: trim it, and fall back to
// "General" only when the trimmed result is empty or the value is missing/
// invalid. A valid existing category (e.g. "Breakfast") is never rewritten —
// trimming a value that already has no leading/trailing whitespace returns
// that exact same string.
//
// Feature 14.1 — moved here (unchanged) from components/editor/EditorShell.tsx
// along with every other normalize* function below and isProjectConfig
// above. None of them ever depended on React, the browser, Supabase, or
// data/templates.ts — their previous location was incidental, not required
// — so this module stays exactly as dependency-free as it was before this
// move; nothing here creates a path back to data/templates.ts (which is
// what would create a circular import, since that file already depends on
// this one).
export function normalizeCategory(category: unknown): string {
  if (typeof category !== "string") {
    return "General";
  }

  const trimmed = category.trim();
  return trimmed === "" ? "General" : trimmed;
}

// Feature 7.5 — normalize menu items loaded from older saved projects that
// predate stockQuantity/trackInventory, so the app never crashes on missing fields.
export function normalizeMenuItem(item: MenuItem): MenuItem {
  return {
    ...item,
    category: normalizeCategory(item.category),
    trackInventory:
      typeof item.trackInventory === "boolean" ? item.trackInventory : false,
    stockQuantity:
      typeof item.stockQuantity === "number" && Number.isFinite(item.stockQuantity)
        ? item.stockQuantity
        : 0,
  };
}

// Feature 11.1 — normalize receipt settings loaded from older saved projects
// that predate these fields, so the app never crashes on missing values and
// existing valid values are always preserved as-is. Mirrors
// normalizeMenuItem's convention above.
//
// Feature 13.1 — rebuilt field-by-field (no `...receipt` spread) rather than
// spreading the incoming object, so a legacy `businessAddress`/
// `businessPhone` key still sitting on an old saved project's raw JSON is
// never carried forward into the normalized result — those values are read
// once, by normalizeBusinessProfile below, and nowhere else. This also
// guarantees the first Save after opening an old project persists only the
// current canonical ReceiptSettings shape.
export function normalizeReceiptSettings(receipt: ReceiptSettings): ReceiptSettings {
  return {
    currency: receipt.currency,
    footer: receipt.footer,
    orderPrefix: receipt.orderPrefix,
    tipsEnabled: receipt.tipsEnabled,
    showBusinessName:
      typeof receipt.showBusinessName === "boolean"
        ? receipt.showBusinessName
        : true,
    headerMessage:
      typeof receipt.headerMessage === "string" ? receipt.headerMessage : "",
    showTaxLine:
      typeof receipt.showTaxLine === "boolean" ? receipt.showTaxLine : true,
    showTipLine:
      typeof receipt.showTipLine === "boolean" ? receipt.showTipLine : true,
    showPaymentMethod:
      typeof receipt.showPaymentMethod === "boolean"
        ? receipt.showPaymentMethod
        : true,
    showOrderNumber:
      typeof receipt.showOrderNumber === "boolean"
        ? receipt.showOrderNumber
        : true,
  };
}

// Feature 13.1 — rebuilt field-by-field for the same reason as
// normalizeReceiptSettings above: a legacy `businessName` key on an old
// saved project's raw branding JSON must never be carried forward once
// BrandingSettings no longer declares it.
export function normalizeBranding(branding: BrandingSettings): BrandingSettings {
  return {
    accentColor: branding.accentColor,
  };
}

// Feature 13.1 — the one place in the app allowed to read a project's
// *raw* legacy JSON shape (branding.businessName, receipt.businessAddress,
// receipt.businessPhone) — all three were removed from their respective
// typed fields this feature, so `config` is widened back to that legacy
// shape here only for reading, never for writing, and never anywhere else
// after this function returns.
//
// Handles every case safely:
//   - No businessProfile at all (pre-13.1 project): synthesize it from the
//     three legacy fields, defaulting every other new field to "".
//   - A partially migrated businessProfile (e.g. saved once already under a
//     future version, or hand-edited): every valid existing string value on
//     it is preserved as-is; only a missing/invalid value falls back to the
//     matching legacy field (businessName/addressLine1/phone) or "".
//   - A brand-new template starter config: businessProfile is already
//     complete and valid, so every field resolves straight from `existing`
//     with no legacy fallback ever used.
type LegacyProjectConfigShape = {
  branding?: { businessName?: unknown };
  receipt?: { businessAddress?: unknown; businessPhone?: unknown };
  businessProfile?: Partial<Record<keyof BusinessProfile, unknown>>;
};

export function normalizeBusinessProfile(config: ProjectConfig): BusinessProfile {
  const legacy = config as unknown as LegacyProjectConfigShape;

  const legacyBusinessName =
    typeof legacy.branding?.businessName === "string"
      ? legacy.branding.businessName
      : "";
  const legacyAddressLine1 =
    typeof legacy.receipt?.businessAddress === "string"
      ? legacy.receipt.businessAddress
      : "";
  const legacyPhone =
    typeof legacy.receipt?.businessPhone === "string"
      ? legacy.receipt.businessPhone
      : "";

  const existing = legacy.businessProfile ?? {};

  function resolve(key: keyof BusinessProfile, legacyFallback: string): string {
    const value = existing[key];
    return typeof value === "string" ? value : legacyFallback;
  }

  return {
    businessName: resolve("businessName", legacyBusinessName),
    addressLine1: resolve("addressLine1", legacyAddressLine1),
    addressLine2: resolve("addressLine2", ""),
    city: resolve("city", ""),
    state: resolve("state", ""),
    postalCode: resolve("postalCode", ""),
    phone: resolve("phone", legacyPhone),
    email: resolve("email", ""),
    website: resolve("website", ""),
  };
}

export function normalizeProjectConfig(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    menuItems: config.menuItems.map(normalizeMenuItem),
    branding: normalizeBranding(config.branding),
    businessProfile: normalizeBusinessProfile(config),
    receipt: normalizeReceiptSettings(config.receipt),
  };
}
