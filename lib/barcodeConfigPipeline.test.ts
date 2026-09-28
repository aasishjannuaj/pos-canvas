// v1.3 Feature 1E-A — barcode and capability data through the whole config path.
//
// THE PATH THIS COVERS:
//   projects.config -> normalizeProjectConfig -> createGeneratedPosConfig
//   -> (build_jobs.config_snapshot / CachedPinnedConfig.configSnapshot) -> runtime
//
// TWO PROPERTIES MATTER MOST, AND BOTH ARE ABOUT WHAT DOES *NOT* CHANGE.
//
// 1. toRuntimeSafeMenuItem builds field-by-field with no spread. An unknown key
//    is dropped there. Without an explicit carry, a barcode would work in the
//    Builder and silently vanish from every device — the worst kind of bug,
//    because the owner sees it saved.
//
// 2. canonicalizeGeneratedPosConfig hashes every key at every depth, that hash
//    becomes build_jobs.config_hash, and config_hash drives build dedupe and the
//    device config-update offer. A project with no barcodes and no configured
//    features must therefore produce a BYTE-IDENTICAL canonical string after
//    this feature, or every existing till is asked to re-pin for nothing.
import { describe, expect, it } from "vitest";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import { canonicalizeGeneratedPosConfig } from "@/lib/buildJobs";
import { defaultProjectConfig, normalizeProjectConfig } from "@/lib/projectConfig";
import type { MenuItem, ProjectConfig } from "@/lib/projectConfig";
import { buildBarcodeIndex, lookupBarcode } from "@/lib/barcode";
import { isBarcodeScanningEnabled } from "@/lib/projectFeatures";

const GENERATED_AT = "2026-09-28T00:00:00.000Z";

const configWith = (menuItems: MenuItem[], features?: ProjectConfig["features"]): ProjectConfig => ({
  ...defaultProjectConfig,
  menuItems,
  ...(features === undefined ? {} : { features }),
});

const product = (over: Partial<MenuItem> = {}): MenuItem => ({
  id: "item-1",
  name: "Vodka 750ml",
  price: 19.99,
  category: "Spirits",
  trackInventory: false,
  stockQuantity: 0,
  ...over,
});

const generate = (config: ProjectConfig) =>
  createGeneratedPosConfig({
    projectId: "p1",
    projectName: "Shop",
    templateId: "liquor-store",
    config,
    generatedAt: GENERATED_AT,
  } as never);

describe("barcode survives the whole path", () => {
  it("reaches the generated config, trimmed and case-intact", () => {
    const generated = generate(
      configWith([product({ barcode: "  0AbC012345678905  " })])
    );

    expect(generated.menuItems[0].barcode).toBe("0AbC012345678905");
  });

  it("keeps leading zeros as a string", () => {
    const generated = generate(configWith([product({ barcode: "012345678905" })]));

    expect(generated.menuItems[0].barcode).toBe("012345678905");
    expect(typeof generated.menuItems[0].barcode).toBe("string");
    // And through a JSON round trip, which is how a snapshot is actually stored.
    const roundTripped = JSON.parse(JSON.stringify(generated)) as typeof generated;
    expect(roundTripped.menuItems[0].barcode).toBe("012345678905");
  });

  it("keeps case-different barcodes distinct end to end", () => {
    const generated = generate(
      configWith([
        product({ id: "a", barcode: "ABC123" }),
        product({ id: "b", barcode: "abc123" }),
      ])
    );

    const built = buildBarcodeIndex(generated.menuItems);

    expect(built.ok).toBe(true);
    expect(built.ok && lookupBarcode(built.lookup, "ABC123")).toBe("a");
    expect(built.ok && lookupBarcode(built.lookup, "abc123")).toBe("b");
  });

  it("drops a blank or unusable barcode rather than storing it", () => {
    for (const barcode of ["", "   ", "01 23", "x".repeat(65), "café"]) {
      const generated = generate(configWith([product({ barcode })]));

      expect("barcode" in generated.menuItems[0]).toBe(false);
    }
  });

  // THE HASH RULE, stated as bytes.
  it("produces a canonical string with no barcode key when no item has one", () => {
    const generated = generate(configWith([product()]));

    expect(canonicalizeGeneratedPosConfig(generated)).not.toContain("barcode");
  });

  it("a project with no barcodes canonicalizes identically before and after", () => {
    const withoutKey = generate(configWith([product()]));
    // The same project whose items carry an explicitly blank barcode: normalizing
    // must erase the difference entirely.
    const withBlank = generate(configWith([product({ barcode: "   " })]));

    expect(canonicalizeGeneratedPosConfig(withBlank)).toBe(
      canonicalizeGeneratedPosConfig(withoutKey)
    );
  });
});

describe("duplicate barcodes are refused where it counts", () => {
  it("createGeneratedPosConfig throws rather than picking a winner", () => {
    expect(() =>
      generate(
        configWith([
          product({ id: "a", barcode: "012345678905" }),
          product({ id: "b", barcode: "  012345678905  " }),
        ])
      )
    ).toThrow(/012345678905/);
  });

  it("allows the same catalogue once the clash is resolved", () => {
    expect(() =>
      generate(
        configWith([
          product({ id: "a", barcode: "012345678905" }),
          product({ id: "b", barcode: "012345678906" }),
        ])
      )
    ).not.toThrow();
  });

  // NEGATIVE CONTROL: items with no barcode are not duplicates of each other.
  it("does not treat several barcode-less items as a clash", () => {
    expect(() =>
      generate(configWith([product({ id: "a" }), product({ id: "b" }), product({ id: "c" })]))
    ).not.toThrow();
  });
});

describe("the capability travels with the project, not the template", () => {
  it("omits features entirely when the project never configured one", () => {
    const generated = generate(configWith([product()]));

    expect(generated.features).toBeUndefined();
    expect(canonicalizeGeneratedPosConfig(generated)).not.toContain("features");
    // And the runtime still resolves the compatibility default.
    expect(isBarcodeScanningEnabled(generated.features)).toBe(true);
  });

  it("carries an explicit setting through to the pinned contract", () => {
    const off = generate(configWith([product()], { barcodeScanning: { enabled: false } }));

    expect(off.features).toEqual({ barcodeScanning: { enabled: false } });
    expect(isBarcodeScanningEnabled(off.features)).toBe(false);

    const roundTripped = JSON.parse(JSON.stringify(off)) as typeof off;
    expect(isBarcodeScanningEnabled(roundTripped.features)).toBe(false);
  });

  // THE POINT OF THE WHOLE FEATURES MODEL. Two different templates, same
  // feature state, same answer — the capability belongs to the project.
  it("answers identically for different templates with the same feature state", () => {
    for (const features of [
      undefined,
      { barcodeScanning: { enabled: true } },
      { barcodeScanning: { enabled: false } },
    ] as ProjectConfig["features"][]) {
      const answers = ["liquor-store", "retail", "cafe", "restaurant"].map((templateId) => {
        const generated = createGeneratedPosConfig({
          projectId: "p1",
          projectName: "Shop",
          templateId,
          config: configWith([product({ barcode: "111" })], features),
          generatedAt: GENERATED_AT,
        } as never);

        return isBarcodeScanningEnabled(generated.features);
      });

      expect(new Set(answers).size).toBe(1);
    }
  });

  it("a disabled project keeps its barcode DATA, it just cannot resolve it", () => {
    const generated = generate(
      configWith([product({ barcode: "012345678905" })], { barcodeScanning: { enabled: false } })
    );

    // Non-destructive: the value is still on the item.
    expect(generated.menuItems[0].barcode).toBe("012345678905");

    const built = buildBarcodeIndex(generated.menuItems, {
      enabled: isBarcodeScanningEnabled(generated.features),
    });

    expect(built.ok && built.lookup.size).toBe(0);
    expect(built.ok && lookupBarcode(built.lookup, "012345678905")).toBeNull();
  });
});

describe("pre-1E configurations remain valid", () => {
  it("normalizes a config that has neither features nor barcodes", () => {
    const legacy = normalizeProjectConfig(configWith([product()]));

    expect("features" in legacy).toBe(false);
    expect("barcode" in legacy.menuItems[0]).toBe(false);
  });

  it("erases a persisted blank barcode and a junk features block", () => {
    const normalized = normalizeProjectConfig(
      configWith([product({ barcode: "" })], { barcodeScanning: { enabled: "no" } } as never)
    );

    expect("features" in normalized).toBe(false);
    expect("barcode" in normalized.menuItems[0]).toBe(false);
  });

  // The pinned config is what a till actually resolves against: a config
  // REPLACEMENT must remap the lookup, with no barcode-specific update channel.
  it("a replaced config remaps the lookup", () => {
    const before = generate(configWith([product({ id: "a", barcode: "X1" })]));
    const after = generate(configWith([product({ id: "b", barcode: "X1" })]));

    const beforeIndex = buildBarcodeIndex(before.menuItems);
    const afterIndex = buildBarcodeIndex(after.menuItems);

    expect(beforeIndex.ok && lookupBarcode(beforeIndex.lookup, "X1")).toBe("a");
    expect(afterIndex.ok && lookupBarcode(afterIndex.lookup, "X1")).toBe("b");
  });
});
