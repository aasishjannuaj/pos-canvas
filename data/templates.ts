// Feature 12.1 — the single, canonical template registry. Every page/
// component that lists templates, links to one, or needs a template's
// starter configuration must import from here rather than maintaining its
// own copy — this file replaces six previously-independent, inconsistent
// hardcoded lists (see the Feature 12.1 plan for the full inventory).
//
// Deliberately depends only on lib/projectConfig.ts (a neutral module with
// no "use client" component in its import chain), never on
// components/editor/EditorShell.tsx — that keeps the dependency graph a
// straight line (lib/projectConfig.ts <- data/templates.ts, and separately
// lib/projectConfig.ts <- EditorShell.tsx) instead of a cycle.
import type { ProjectConfig } from "@/lib/projectConfig";
import { defaultProjectConfig, cloneProjectConfig } from "@/lib/projectConfig";

export type Template = {
  id: string;
  name: string;
  category: string;
  description: string;
  icon: string;
  features: string[];
  // Feature 12.1 — every template currently points at the exact same
  // shared starter configuration (see lib/projectConfig.ts). This is
  // intentional and honest: the six templates do not yet have distinct
  // layouts, navigation, or starter content — only branding/copy differs.
  // getStarterConfig() below always returns a fresh clone of whatever this
  // points to, never this reference itself.
  starterConfig: ProjectConfig;
};

// Feature 12.1 correction — all six templates run on the exact same shared
// POS engine, layout, and starter configuration today (see
// lib/projectConfig.ts). None has a distinct business-specific workflow yet,
// so every template lists the same, honest, currently-implemented
// capabilities rather than business-specific features that don't exist.
const SHARED_FEATURES = [
  "Customizable products and categories",
  "Prices and taxes",
  "Inventory tracking",
  "Checkout and completed sales",
  "Receipt settings and printing",
  "Sales and inventory reports",
];

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
    starterConfig: defaultProjectConfig,
  },
  {
    id: "cafe",
    name: "Cozy Cafe",
    category: "Cafe",
    description:
      "A customizable point-of-sale for cafe and coffee-shop menus, with the same checkout, tax, inventory, receipt, and reporting tools.",
    icon: "☕",
    features: SHARED_FEATURES,
    starterConfig: defaultProjectConfig,
  },
  {
    id: "retail",
    name: "Modern Retail",
    category: "Retail",
    description:
      "A customizable point-of-sale for a retail product catalog, with checkout, tax, inventory tracking, receipts, and sales reporting built in.",
    icon: "🛍",
    features: SHARED_FEATURES,
    starterConfig: defaultProjectConfig,
  },
  {
    id: "liquor-store",
    name: "Liquor Store Essentials",
    category: "Liquor Store",
    description:
      "A customizable point-of-sale for a liquor store's product list, with checkout, tax, inventory tracking, receipts, and sales reporting built in.",
    icon: "🍺",
    features: SHARED_FEATURES,
    starterConfig: defaultProjectConfig,
  },
  {
    id: "food-truck",
    name: "Street Food Truck",
    category: "Food Truck",
    description:
      "A customizable point-of-sale for a food truck menu, with checkout, tax, inventory tracking, receipts, and sales reporting built in.",
    icon: "🚚",
    features: SHARED_FEATURES,
    starterConfig: defaultProjectConfig,
  },
  {
    id: "salon",
    name: "Salon & Spa",
    category: "Salon",
    description:
      "A customizable point-of-sale for salon and spa service menus, with checkout, tax, inventory tracking, receipts, and sales reporting built in.",
    icon: "💇",
    features: SHARED_FEATURES,
    starterConfig: defaultProjectConfig,
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
// mutate the shared module-level default or leak into another session or
// template entry through a shared array/object reference. Falls back to the
// shared default for any id that doesn't match a known template — a brand
// new, not-yet-saved project must never fail to load just because its URL
// used an unrecognized template id.
export function getStarterConfig(templateId: string): ProjectConfig {
  const template = getTemplateById(templateId);
  return cloneProjectConfig(template?.starterConfig ?? defaultProjectConfig);
}
