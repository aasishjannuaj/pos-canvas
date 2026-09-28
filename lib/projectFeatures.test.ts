// v1.3 Feature 1E-A — optional project capabilities.
//
// THE PROPERTY THAT MATTERS MOST HERE IS COMPATIBILITY. Every project saved
// before this model existed has no `features` key, and every one of them must
// keep working — enabled, unmigrated, and byte-identical in the configuration
// it generates. The tests below are mostly about absence.
import { describe, expect, it } from "vitest";
import {
  isBarcodeScanningEnabled,
  normalizeProjectFeatures,
} from "@/lib/projectFeatures";
import { defaultProjectConfig, isProjectConfig } from "@/lib/projectConfig";

describe("the compatibility default", () => {
  it("treats a project with no features at all as enabled", () => {
    expect(isBarcodeScanningEnabled(undefined)).toBe(true);
  });

  it("treats a project with features but no barcodeScanning as enabled", () => {
    expect(isBarcodeScanningEnabled({})).toBe(true);
  });

  it("keeps an explicit false false", () => {
    expect(isBarcodeScanningEnabled({ barcodeScanning: { enabled: false } })).toBe(false);
  });

  it("keeps an explicit true true", () => {
    expect(isBarcodeScanningEnabled({ barcodeScanning: { enabled: true } })).toBe(true);
  });

  // ======================================================================
  // THE LOCKED COMPATIBILITY MATRIX.
  //
  // ONLY THE LITERAL BOOLEAN `false` DISABLES BARCODE SCANNING. Everything
  // else — absent, null, junk, an empty object, the STRING "false", the number
  // 0 — resolves to enabled. Nothing is coerced: turning "false" into false
  // would be inventing a parser for a field the schema says is boolean, and
  // guessing intent from a value the schema does not define.
  //
  // Fail-open is correct HERE because the capability is benign: a till that
  // silently stopped scanning looks like broken hardware, while one that keeps
  // scanning only adds a product the cashier chose to scan. It is scoped to
  // barcodeScanning in v1.3 and must not be inherited by any capability that
  // gates money, identity or access — see the note on isBarcodeScanningEnabled.
  // ======================================================================
  const MATRIX: [label: string, features: unknown, enabled: boolean][] = [
    ["features absent", undefined, true],
    ["features: null", null, true],
    ['features: "bad"', "bad", true],
    ["features: {}", {}, true],
    ["barcodeScanning absent", { somethingElse: true }, true],
    ["barcodeScanning: null", { barcodeScanning: null }, true],
    ["barcodeScanning: {}", { barcodeScanning: {} }, true],
    ["enabled: true", { barcodeScanning: { enabled: true } }, true],
    ["enabled: false", { barcodeScanning: { enabled: false } }, false],
    ['enabled: "false"', { barcodeScanning: { enabled: "false" } }, true],
    ["enabled: 0", { barcodeScanning: { enabled: 0 } }, true],
  ];

  it("only the literal boolean false disables barcode scanning", () => {
    for (const [label, features, enabled] of MATRIX) {
      const normalized = normalizeProjectFeatures(features);

      expect(`${label}: ${isBarcodeScanningEnabled(normalized)}`).toBe(`${label}: ${enabled}`);
    }

    // Exactly one row in the whole matrix disables it.
    expect(MATRIX.filter(([, , enabled]) => !enabled)).toHaveLength(1);
  });

  // The accessor is robust whether it is handed a normalized value or a raw
  // one, so a caller that skipped normalization cannot get a different answer.
  it("gives the same answer for raw and normalized input", () => {
    for (const [label, features, enabled] of MATRIX) {
      expect(`${label}: ${isBarcodeScanningEnabled(features as never)}`).toBe(
        `${label}: ${enabled}`
      );
    }
  });

  // NEGATIVE CONTROL: no coercion anywhere. If someone later "helpfully" parsed
  // truthiness, these two rows would flip and this fails.
  it("does not coerce truthy or falsy values", () => {
    expect(isBarcodeScanningEnabled({ barcodeScanning: { enabled: "false" } } as never)).toBe(true);
    expect(isBarcodeScanningEnabled({ barcodeScanning: { enabled: 0 } } as never)).toBe(true);
    expect(isBarcodeScanningEnabled({ barcodeScanning: { enabled: "" } } as never)).toBe(true);
    expect(isBarcodeScanningEnabled({ barcodeScanning: { enabled: null } } as never)).toBe(true);
  });

  // A malformed optional flag must never make a whole project unloadable.
  it("a malformed features block does not invalidate the project config", () => {
    for (const [, features] of MATRIX) {
      expect(
        isProjectConfig({ ...defaultProjectConfig, features } as never)
      ).toBe(true);
    }
  });
});

describe("normalization", () => {
  // THE HASH RULE. Returning a defaults object here would put a `features` key
  // into every generated config, change its canonical hash, and ask every
  // paired till to re-pin to record what its silence already meant.
  it("returns undefined when nothing was ever configured", () => {
    for (const value of [undefined, null, {}, [], "features", 7]) {
      expect(normalizeProjectFeatures(value)).toBeUndefined();
    }
  });

  it("returns undefined when nothing recognizable survives", () => {
    expect(normalizeProjectFeatures({ barcodeScanning: { enabled: "yes" } })).toBeUndefined();
    expect(normalizeProjectFeatures({ someFutureFeature: { enabled: true } })).toBeUndefined();
  });

  it("preserves an explicitly persisted value, either way", () => {
    expect(normalizeProjectFeatures({ barcodeScanning: { enabled: false } })).toEqual({
      barcodeScanning: { enabled: false },
    });
    expect(normalizeProjectFeatures({ barcodeScanning: { enabled: true } })).toEqual({
      barcodeScanning: { enabled: true },
    });
  });

  it("drops unknown keys rather than carrying them through", () => {
    expect(
      normalizeProjectFeatures({
        barcodeScanning: { enabled: false, extra: "ignored" },
        notAFeature: true,
      })
    ).toEqual({ barcodeScanning: { enabled: false } });
  });

  it("copies rather than aliasing the input", () => {
    const input = { barcodeScanning: { enabled: false } };
    const normalized = normalizeProjectFeatures(input);

    expect(normalized).not.toBe(input);
    expect(normalized?.barcodeScanning).not.toBe(input.barcodeScanning);
  });
});
