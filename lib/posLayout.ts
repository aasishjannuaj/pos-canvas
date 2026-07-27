// Feature 12.3 — the neutral layout-identity type. Lives separately from
// lib/projectConfig.ts (scoped to ProjectConfig and its nested types) since
// layout is a template-presentation concern, not part of the mutable,
// persisted project configuration. data/templates.ts imports this type to
// tag each template registry entry; the UI-layer layout component registry
// (components/editor/pos-layouts/index.ts) imports the same type — neither
// imports the other, so there is no circular or cross-layer dependency.
export type PosLayout = "menu-grid" | "product-grid" | "service-grid";

// Feature 12.3 — safe fallback for a saved project whose template_id is
// legacy or doesn't match any registered template. "menu-grid" is today's
// only existing visual, so this never surprises anyone — it only decides
// which product-browser component renders; it never touches the project's
// own saved config.
export const DEFAULT_POS_LAYOUT: PosLayout = "menu-grid";
