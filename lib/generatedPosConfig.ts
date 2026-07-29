// Feature 14.1 — the Generated POS Configuration contract: a stable,
// versioned, dependency-free export shape that a future Web POS runtime,
// Android/Capacitor wrapper, desktop wrapper, or build-queue worker can
// consume, independent of the Builder's own editable ProjectConfig shape.
//
// This module has no React, Supabase, or browser-API dependency, and it
// deliberately imports from both lib/projectConfig.ts (for the shared
// normalization pipeline and nested value types) and data/templates.ts/
// lib/posLayout.ts (for canonical layout resolution) — the same two
// modules EditorShell.tsx already depends on. It cannot live inside
// lib/projectConfig.ts itself: data/templates.ts already depends on
// lib/projectConfig.ts, so lib/projectConfig.ts importing back from
// data/templates.ts would create a circular import. This module sits
// above both, exactly where EditorShell.tsx already sits today.
import { normalizeProjectConfig } from "@/lib/projectConfig";
import type {
  BrandingSettings,
  BusinessProfile,
  MenuItem,
  ProjectConfig,
  ReceiptSettings,
  TaxSettings,
} from "@/lib/projectConfig";
import { getTemplateById } from "@/data/templates";
import { DEFAULT_POS_LAYOUT } from "@/lib/posLayout";
import type { PosLayout } from "@/lib/posLayout";

// Feature 14.1 — schemaVersion is a data-contract version, completely
// independent of package.json's application version: an app release can
// ship with no contract change at all, and a contract change is a
// consumer-facing breaking event regardless of which app release it first
// appears in. A literal type (not `number`) so a real future version is a
// deliberate, compiler-enforced change — e.g. widening this to
// `1 | 2` or introducing a discriminated union of
// `GeneratedPosConfigV1 | GeneratedPosConfigV2` — rather than something
// that silently type-checks against an arbitrary number.
//
// There is no migration framework here, and none should be built until a
// second version genuinely exists. The convention any future reader of a
// generated config must follow: branch explicitly on `schemaVersion`, and
// reject (never silently reinterpret) a value it doesn't recognize — a
// generated file with an unknown future schemaVersion is not the same
// shape as this one and must not be guessed at.
export const GENERATED_POS_CONFIG_SCHEMA_VERSION = 1 as const;

// Feature 14.1 — the runtime/export contract. Structurally distinct from
// ProjectConfig (wrapper metadata, a `project` grouping, no Builder-only
// concepts such as onboarding/save-state/editor UI), but its nested value
// types (BusinessProfile, BrandingSettings, MenuItem, TaxSettings,
// ReceiptSettings) are reused directly from lib/projectConfig.ts rather
// than redeclared — those are genuinely the same data at the field level
// whether the Builder is editing them or a runtime is consuming them, and
// duplicating ~30 fields across 5 types would just create a second copy
// that silently drifts out of sync with the first.
//
// currency is intentionally not duplicated at the top level — it remains
// accessible at receipt.currency, the same single source of truth the
// Builder itself already reads everywhere.
export type GeneratedPosConfig = {
  schemaVersion: typeof GENERATED_POS_CONFIG_SCHEMA_VERSION;
  generatedAt: string;
  project: {
    projectId: string;
    projectName: string;
    templateId: string;
    layout: PosLayout;
  };
  businessProfile: BusinessProfile;
  branding: BrandingSettings;
  menuItems: MenuItem[];
  tax: TaxSettings;
  receipt: ReceiptSettings;
};

export type CreateGeneratedPosConfigInput = {
  projectId: string;
  projectName: string;
  templateId: string;
  config: ProjectConfig;
};

// Feature 14.1 — trims and requires a non-empty value for the three
// critical identity fields (projectId, projectName, templateId). These are
// the fields that identify *which* generated package this is; a missing or
// whitespace-only value here is a caller bug, not legacy/malformed data to
// silently coerce, so this throws rather than normalizing — unlike every
// other field below, which is normalized instead of rejected (see the
// per-field rules further down).
function requireNonEmptyTrimmed(value: string, fieldName: string): string {
  const trimmed = value.trim();

  if (trimmed === "") {
    throw new Error(`createGeneratedPosConfig: ${fieldName} must not be empty.`);
  }

  return trimmed;
}

// Feature 14.1 — generatedAt is the one intentionally non-deterministic
// input (per the "pure except for the default clock" requirement). An
// explicit override is validated (it must parse as a real date) and always
// re-serialized to a canonical ISO string via toISOString() — so a
// non-canonical-but-parseable input is normalized, and an already-canonical
// ISO input round-trips to the exact same string, making injected values
// fully deterministic for tests. Omitting it uses the real current time.
function resolveGeneratedAt(candidate: string | undefined): string {
  if (candidate === undefined) {
    return new Date().toISOString();
  }

  const parsed = new Date(candidate);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error("createGeneratedPosConfig: generatedAt is not a valid date.");
  }

  return parsed.toISOString();
}

// Feature 14.1 — runtime-safe menu item cleanup, layered *on top of* the
// Builder-compatible normalizeProjectConfig (called before this), not
// merged into it — changing normalizeProjectConfig itself to add numeric
// clamping could alter Builder-visible behavior (e.g. what a malformed
// price displays as while editing), which is out of scope here. This pass
// only tightens what the generated *runtime* contract accepts:
//   - id: preserved if a valid non-empty string; otherwise a deterministic
//     `item-{index}` fallback, so every menu item in the output always has
//     a usable, stable-for-this-generation id.
//   - name/category: trimmed for display; category has already gone
//     through normalizeCategory's General-fallback via
//     normalizeProjectConfig, so it's reused as-is here.
//   - trackInventory: already guaranteed boolean by normalizeProjectConfig;
//     re-checked defensively rather than assumed.
//   - price: any non-finite or negative value becomes 0; a valid
//     non-negative finite value is preserved exactly.
//   - stockQuantity: any non-finite or negative value becomes 0; a valid
//     value is floored to a whole number, since a fractional unit count
//     isn't meaningful for inventory.
function toRuntimeSafeMenuItem(item: MenuItem, index: number): MenuItem {
  const id = typeof item.id === "string" && item.id.trim() !== ""
    ? item.id
    : `item-${index}`;

  const name = typeof item.name === "string" ? item.name.trim() : "";

  const trackInventory =
    typeof item.trackInventory === "boolean" ? item.trackInventory : false;

  const price = Number.isFinite(item.price) && item.price >= 0 ? item.price : 0;

  const stockQuantity =
    Number.isFinite(item.stockQuantity) && item.stockQuantity >= 0
      ? Math.floor(item.stockQuantity)
      : 0;

  return {
    id,
    name,
    category: item.category,
    trackInventory,
    price,
    stockQuantity,
  };
}

// Feature 14.1 — runtime-safe tax cleanup. normalizeProjectConfig does not
// touch the tax object at all today (it passes through unnormalized via
// the top-level `...config` spread), so this is the first place any
// safety is actually applied to it. Booleans fall back to this app's own
// starter defaults (enabled: true, pricesIncludeTax: false,
// showTaxSeparately: true — see defaultProjectConfig in
// lib/projectConfig.ts) rather than an arbitrary choice. rate is clamped
// to the valid 0–100 percentage range; a non-finite rate becomes 0.
function toRuntimeSafeTax(tax: TaxSettings): TaxSettings {
  const rate = Number.isFinite(tax.rate) ? Math.min(100, Math.max(0, tax.rate)) : 0;

  return {
    enabled: typeof tax.enabled === "boolean" ? tax.enabled : true,
    rate,
    pricesIncludeTax:
      typeof tax.pricesIncludeTax === "boolean" ? tax.pricesIncludeTax : false,
    showTaxSeparately:
      typeof tax.showTaxSeparately === "boolean" ? tax.showTaxSeparately : true,
  };
}

// Feature 14.1 — trims every business-facing display string for the
// generated output. Values themselves are already migrated/defaulted by
// normalizeProjectConfig (via normalizeBusinessProfile) before this runs;
// this only trims for presentation, it never invents or rejects a value.
function toRuntimeSafeBusinessProfile(profile: BusinessProfile): BusinessProfile {
  return {
    businessName: profile.businessName.trim(),
    addressLine1: profile.addressLine1.trim(),
    addressLine2: profile.addressLine2.trim(),
    city: profile.city.trim(),
    state: profile.state.trim(),
    postalCode: profile.postalCode.trim(),
    phone: profile.phone.trim(),
    email: profile.email.trim(),
    website: profile.website.trim(),
  };
}

// Feature 14.1 — trims display/text receipt fields for the generated
// output. currency and every boolean toggle are passed through exactly as
// normalizeReceiptSettings already left them — currency is never replaced
// with an invented/guessed code, and no unsupported currency value is
// introduced here.
function toRuntimeSafeReceipt(receipt: ReceiptSettings): ReceiptSettings {
  return {
    ...receipt,
    footer: receipt.footer.trim(),
    orderPrefix: receipt.orderPrefix.trim(),
    headerMessage: receipt.headerMessage.trim(),
  };
}

// Feature 14.1 — the single pure export function. No React, no Supabase,
// no browser API — every dependency is either a plain value passed in or a
// pure function imported from lib/projectConfig.ts/data/templates.ts/
// lib/posLayout.ts. Deterministic except for the default clock (see
// resolveGeneratedAt). Never mutates input.config: normalizeProjectConfig
// already reconstructs every nested object/array fresh rather than
// reusing input references, and every runtime-safe helper above does the
// same on top of that already-fresh result — so nothing in the returned
// object shares a reference with input.config anywhere in the chain.
export function createGeneratedPosConfig(
  input: CreateGeneratedPosConfigInput,
  options?: { generatedAt?: string }
): GeneratedPosConfig {
  const projectId = requireNonEmptyTrimmed(input.projectId, "projectId");
  const projectName = requireNonEmptyTrimmed(input.projectName, "projectName");
  const templateId = requireNonEmptyTrimmed(input.templateId, "templateId");
  const generatedAt = resolveGeneratedAt(options?.generatedAt);

  // Feature 14.1 — the same Builder-compatible normalization EditorShell
  // applies on load (legacy business-profile/receipt migration, category
  // fallback, menu-item defaults). Applied first so every runtime-safe
  // helper below can assume an already-sound, already-migrated shape.
  const normalizedConfig = normalizeProjectConfig(input.config);

  // Feature 14.1 — the same canonical registry lookup + safe fallback
  // already used in app/editor/[id]/page.tsx. templateId is preserved
  // verbatim in the output even when it matches no registered template —
  // an unknown legacy template id must never make a saved project's
  // generated output impossible, only fall back to a safe default layout.
  const layout = getTemplateById(templateId)?.layout ?? DEFAULT_POS_LAYOUT;

  return {
    schemaVersion: GENERATED_POS_CONFIG_SCHEMA_VERSION,
    generatedAt,
    project: {
      projectId,
      projectName,
      templateId,
      layout,
    },
    businessProfile: toRuntimeSafeBusinessProfile(normalizedConfig.businessProfile),
    branding: { accentColor: normalizedConfig.branding.accentColor.trim() },
    menuItems: normalizedConfig.menuItems.map(toRuntimeSafeMenuItem),
    tax: toRuntimeSafeTax(normalizedConfig.tax),
    receipt: toRuntimeSafeReceipt(normalizedConfig.receipt),
  };
}

// Feature 14.2 — export eligibility as a small, pure, independently testable
// function. Deliberately takes plain scalars (not the whole EditorShell
// state) and returns a value, never a side effect — it never creates or
// saves a project, never retries a failed save, and never touches
// project-name validation itself (that's still exclusively
// createGeneratedPosConfig's job, and Feature 13.2's save flow's job).
// `saveStatus`'s type is written out as the same literal union
// EditorShell's own SaveStatus uses, rather than imported from
// components/editor/EditorShell.tsx — this module stays independent of any
// "use client" component, matching lib/generatedPosConfig.ts's existing
// dependency-free design from Feature 14.1.
export type GeneratedPosExportEligibility =
  | { canExport: true; reason: "ready" }
  | {
      canExport: false;
      reason: "save-first" | "save-changes-first" | "saving";
    };

export function getGeneratedPosExportEligibility(input: {
  projectId: string | null;
  isDirty: boolean;
  saveStatus: "idle" | "saving" | "saved" | "error";
}): GeneratedPosExportEligibility {
  if (input.projectId === null) {
    return { canExport: false, reason: "save-first" };
  }

  // Feature 14.2 — checked explicitly even though isDirty already blocks
  // export during an in-flight save in practice today (isDirty only
  // becomes false once a save has fully succeeded) — this keeps the
  // helper an accurate model of every UI state on its own terms, rather
  // than relying on that incidental ordering elsewhere.
  if (input.saveStatus === "saving") {
    return { canExport: false, reason: "saving" };
  }

  if (input.isDirty) {
    return { canExport: false, reason: "save-changes-first" };
  }

  return { canExport: true, reason: "ready" };
}

// Feature 14.2 — sanitizes a project name into a filesystem-safe slug for
// the exported filename. A single regex collapses every run of characters
// that isn't an ASCII letter or digit (spaces, slashes, punctuation, and by
// extension every one of / \ : * ? " < > | since none of those are
// alphanumeric) into one hyphen, so repeated/mixed separators can never
// produce a double hyphen; leading/trailing hyphens are then stripped.
// Falls back to "project" only when nothing alphanumeric survives at all
// (e.g. a name of just "!!!" or whitespace) — never produces an empty
// filename segment.
function slugifyProjectName(projectName: string): string {
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug === "" ? "project" : slug;
}

// Feature 14.2 — the exported file's name. Deliberately never includes
// projectId (an internal identifier with no reason to appear in a
// user-facing downloaded filename) — only the sanitized project name and
// the schema version, which defaults to the real
// GENERATED_POS_CONFIG_SCHEMA_VERSION constant so the filename can never
// silently drift out of sync with the contract it actually names.
export function createGeneratedPosConfigFilename(
  projectName: string,
  schemaVersion: number = GENERATED_POS_CONFIG_SCHEMA_VERSION
): string {
  const slug = slugifyProjectName(projectName);
  return `pos-canvas-${slug}-v${schemaVersion}.json`;
}

// Feature 14.3 — the exact three PosLayout values this app currently
// resolves layouts to (lib/posLayout.ts). An explicit allow-list, not a
// bare `typeof value === "string"` check — a malformed or arbitrary layout
// string must be rejected outright here, never silently passed through to
// a runtime consumer.
const KNOWN_LAYOUTS: readonly string[] = [
  "menu-grid",
  "product-grid",
  "service-grid",
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Feature 14.3 — the runtime boundary's own structural validator. Built
// now, even though today's only producer (createGeneratedPosConfig above)
// is already trusted, because this is exactly the reusable check every
// *future* consumer of a generated config (a downloaded-file loader, an
// eventual Android/desktop wrapper) will also need — proving it against
// today's one real producer is the safest way to get it right early.
//
// Deliberately a *structural* check, not a re-run of createGeneratedPosConfig's
// own business-rule normalization (redundant for a config this module
// itself just produced) — schemaVersion is checked for an exact match
// (never coerced, never "close enough"; an unsupported version is rejected
// outright, matching the schema-evolution convention documented above:
// a future reader must branch on schemaVersion, never silently
// reinterpret an unrecognized one) and layout is checked against the exact
// known PosLayout values, never accepted as an arbitrary string.
export function isGeneratedPosConfig(value: unknown): value is GeneratedPosConfig {
  if (!isPlainObject(value)) {
    return false;
  }

  if (value.schemaVersion !== GENERATED_POS_CONFIG_SCHEMA_VERSION) {
    return false;
  }

  if (typeof value.generatedAt !== "string") {
    return false;
  }

  const generatedAtDate = new Date(value.generatedAt);
  if (Number.isNaN(generatedAtDate.getTime())) {
    return false;
  }

  if (!isPlainObject(value.project)) {
    return false;
  }

  const project = value.project;

  if (
    !isNonEmptyString(project.projectId) ||
    !isNonEmptyString(project.projectName) ||
    !isNonEmptyString(project.templateId)
  ) {
    return false;
  }

  if (
    typeof project.layout !== "string" ||
    !KNOWN_LAYOUTS.includes(project.layout)
  ) {
    return false;
  }

  if (!Array.isArray(value.menuItems)) {
    return false;
  }

  if (
    !isPlainObject(value.businessProfile) ||
    !isPlainObject(value.branding) ||
    !isPlainObject(value.tax) ||
    !isPlainObject(value.receipt)
  ) {
    return false;
  }

  return true;
}
