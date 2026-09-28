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

  // NEGATIVE CONTROL: only an explicit false may disable. Anything unreadable
  // must fall back to working, never to silently-off — a till that stopped
  // scanning because of a malformed config would look like broken hardware.
  it("falls back to enabled for anything it cannot read", () => {
    for (const features of [
      { barcodeScanning: {} },
      { barcodeScanning: { enabled: "false" } },
      { barcodeScanning: { enabled: 0 } },
      { barcodeScanning: null },
    ] as never[]) {
      expect(isBarcodeScanningEnabled(normalizeProjectFeatures(features))).toBe(true);
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
