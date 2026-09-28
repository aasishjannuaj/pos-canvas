/**
 * v1.3 Feature 1E-A — optional project capabilities, in one place.
 *
 * THE MODEL, AND WHY IT IS NOT THE TEMPLATE. A template says how a till looks
 * and which workflow it presents. A FEATURE says what this business can do.
 * Those are different questions, and answering the second with the first is how
 * a product ends up with `templateId === "liquor-store"` scattered through its
 * engine — at which point the capability cannot be turned on for a convenience
 * store, cannot be turned off for a liquor store that does not own a scanner,
 * and cannot be tested without pretending to be a particular template.
 *
 * So: the PROJECT owns the capability, templates merely consume it.
 *
 * ONLY barcodeScanning LIVES HERE TODAY. Employee management, the Time Clock,
 * cash movements, reports and inventory are all real capabilities and none of
 * them is retrofitted into this model now — a later Features checkpoint owns
 * that, along with any management UI. This module is the shape that makes such
 * a checkpoint possible, not the checkpoint itself.
 *
 * ABSENCE MEANS ENABLED, AND ABSENCE IS THE NORMAL CASE. Every project saved
 * before this feature existed has no `features` key at all, and every one of
 * them should be able to scan. So the default is resolved when the value is
 * READ, and a project that never said anything is never rewritten to say
 * something — see the hash note in lib/generatedPosConfig.ts for why that
 * matters more than it looks.
 */

/** The one capability this checkpoint models. */
export type BarcodeScanningFeature = {
  enabled: boolean;
};

/**
 * The project's optional capabilities.
 *
 * Every member is optional, and an absent member resolves to its default
 * through the accessors below rather than through a written value.
 */
export type ProjectFeatures = {
  barcodeScanning?: BarcodeScanningFeature;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads a stored `features` value into the canonical shape.
 *
 * RETURNS undefined RATHER THAN A DEFAULT OBJECT, deliberately. A project that
 * never configured a feature must keep having no `features` key: inventing one
 * during normalization would put it into the generated configuration, change
 * that configuration's canonical hash, and ask every already-paired till to
 * re-pin — for a value that means exactly what its absence already meant.
 *
 * An explicitly persisted value is preserved, including an explicit `true`,
 * because that is a choice somebody made and a later reader may want to see the
 * difference between "chose on" and "never asked".
 *
 * Malformed input is dropped rather than carried through unvalidated, matching
 * normalizeMenuItem's convention for modifierGroups.
 */
export function normalizeProjectFeatures(value: unknown): ProjectFeatures | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const normalized: ProjectFeatures = {};

  const barcodeScanning = value.barcodeScanning;

  if (isPlainObject(barcodeScanning) && typeof barcodeScanning.enabled === "boolean") {
    normalized.barcodeScanning = { enabled: barcodeScanning.enabled };
  }

  // Nothing recognizable survived: treat it as never having been configured,
  // so an empty or junk object cannot change a generated config's hash either.
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

/**
 * May this project use barcode scanning?
 *
 * ONLY AN EXPLICIT `false` DISABLES IT. Missing `features`, missing
 * `barcodeScanning`, and a malformed value all mean yes — which is what makes
 * every pre-1E project work without being migrated or rewritten.
 *
 * Takes the features value, never a template id and never a whole config, so
 * nothing downstream can accidentally make the answer depend on presentation.
 */
export function isBarcodeScanningEnabled(features: ProjectFeatures | undefined): boolean {
  return features?.barcodeScanning?.enabled !== false;
}
