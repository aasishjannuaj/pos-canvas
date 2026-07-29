import { describe, expect, it } from "vitest";
import {
  GENERATED_POS_CONFIG_SCHEMA_VERSION,
  createGeneratedPosConfig,
  createGeneratedPosConfigFilename,
  getGeneratedPosExportEligibility,
  isGeneratedPosConfig,
} from "@/lib/generatedPosConfig";
import { defaultProjectConfig, cloneProjectConfig } from "@/lib/projectConfig";
import type { ProjectConfig } from "@/lib/projectConfig";
import { DEFAULT_POS_LAYOUT } from "@/lib/posLayout";
import { templates } from "@/data/templates";

const BASE_INPUT = {
  projectId: "project-123",
  projectName: "Test Project",
  templateId: "restaurant",
};

describe("createGeneratedPosConfig", () => {
  // 1. all six canonical templates
  it("generates a valid config for every canonical template", () => {
    expect(templates.length).toBe(6);

    for (const template of templates) {
      const result = createGeneratedPosConfig({
        projectId: "project-1",
        projectName: `${template.name} Project`,
        templateId: template.id,
        config: template.starterConfig,
      });

      expect(result.schemaVersion).toBe(1);
      expect(result.project.templateId).toBe(template.id);
      expect(result.project.layout).toBe(template.layout);
      expect(Array.isArray(result.menuItems)).toBe(true);
      expect(result.menuItems.length).toBeGreaterThan(0);
      expect(result.businessProfile.businessName.length).toBeGreaterThan(0);
    }
  });

  // 2. schemaVersion is exactly 1
  it("always sets schemaVersion to exactly 1", () => {
    const result = createGeneratedPosConfig({
      ...BASE_INPUT,
      config: defaultProjectConfig,
    });

    expect(result.schemaVersion).toBe(1);
    expect(GENERATED_POS_CONFIG_SCHEMA_VERSION).toBe(1);
  });

  // 3. injected generatedAt is deterministic and canonicalized
  it("uses an injected generatedAt deterministically and canonicalizes it", () => {
    const fixedIso = "2024-01-01T00:00:00.000Z";

    const result = createGeneratedPosConfig(
      { ...BASE_INPUT, config: defaultProjectConfig },
      { generatedAt: fixedIso }
    );

    expect(result.generatedAt).toBe(fixedIso);

    // A parseable-but-non-canonical date string is re-serialized to a
    // canonical ISO string rather than passed through verbatim.
    const nonCanonical = createGeneratedPosConfig(
      { ...BASE_INPUT, config: defaultProjectConfig },
      { generatedAt: "2024-01-01T00:00:00Z" }
    );

    expect(nonCanonical.generatedAt).toBe(fixedIso);
  });

  // 4. invalid generatedAt throws
  it("throws for an invalid generatedAt override", () => {
    expect(() =>
      createGeneratedPosConfig(
        { ...BASE_INPUT, config: defaultProjectConfig },
        { generatedAt: "not-a-real-date" }
      )
    ).toThrow();
  });

  // 5/6/7. empty identity fields throw
  it("throws for an empty or whitespace-only projectId", () => {
    expect(() =>
      createGeneratedPosConfig({
        ...BASE_INPUT,
        projectId: "   ",
        config: defaultProjectConfig,
      })
    ).toThrow();
  });

  it("throws for an empty or whitespace-only projectName", () => {
    expect(() =>
      createGeneratedPosConfig({
        ...BASE_INPUT,
        projectName: "",
        config: defaultProjectConfig,
      })
    ).toThrow();
  });

  it("throws for an empty or whitespace-only templateId", () => {
    expect(() =>
      createGeneratedPosConfig({
        ...BASE_INPUT,
        templateId: "  ",
        config: defaultProjectConfig,
      })
    ).toThrow();
  });

  // 8. unknown templateId preserves the id and falls back to the default layout
  it("preserves an unknown templateId and falls back to DEFAULT_POS_LAYOUT", () => {
    const result = createGeneratedPosConfig({
      ...BASE_INPUT,
      templateId: "not-a-real-template",
      config: defaultProjectConfig,
    });

    expect(result.project.templateId).toBe("not-a-real-template");
    expect(result.project.layout).toBe(DEFAULT_POS_LAYOUT);
  });

  // 9. legacy config migrates
  it("migrates a pre-13.1 legacy config (no businessProfile, old branding/receipt fields)", () => {
    const legacyConfig = {
      menuItems: [
        {
          id: "legacy-1",
          name: "Legacy Item",
          price: 5,
          category: "Food",
          trackInventory: true,
          stockQuantity: 10,
        },
      ],
      branding: {
        businessName: "Legacy Business Name",
        accentColor: "#123456",
      },
      tax: {
        enabled: true,
        rate: 5,
        pricesIncludeTax: false,
        showTaxSeparately: true,
      },
      receipt: {
        currency: "USD",
        footer: "Thanks!",
        orderPrefix: "ORD-",
        tipsEnabled: false,
        showBusinessName: true,
        businessAddress: "123 Main St",
        businessPhone: "555-1234",
        headerMessage: "",
        showTaxLine: true,
        showTipLine: true,
        showPaymentMethod: true,
        showOrderNumber: true,
      },
      // no businessProfile at all
    } as unknown as ProjectConfig;

    const result = createGeneratedPosConfig({
      ...BASE_INPUT,
      config: legacyConfig,
    });

    expect(result.businessProfile.businessName).toBe("Legacy Business Name");
    expect(result.businessProfile.addressLine1).toBe("123 Main St");
    expect(result.businessProfile.phone).toBe("555-1234");
    expect(result.businessProfile.email).toBe("");
    expect(result.businessProfile.website).toBe("");
  });

  // 10. output does not mutate input config
  it("does not mutate the input config", () => {
    const input = cloneProjectConfig(defaultProjectConfig);
    const before = JSON.parse(JSON.stringify(input));

    createGeneratedPosConfig({ ...BASE_INPUT, config: input });

    expect(input).toEqual(before);
  });

  // 11. output is deep-safe
  it("returns a deep-safe copy that mutating afterward does not affect the input", () => {
    const input = cloneProjectConfig(defaultProjectConfig);
    const originalPrice = input.menuItems[0].price;
    const originalBusinessName = input.businessProfile.businessName;

    const result = createGeneratedPosConfig({ ...BASE_INPUT, config: input });

    result.menuItems[0].price = 999999;
    result.businessProfile.businessName = "Mutated";

    expect(input.menuItems[0].price).toBe(originalPrice);
    expect(input.businessProfile.businessName).toBe(originalBusinessName);
  });

  // 12. JSON serialization round-trip
  it("round-trips through JSON serialization unchanged", () => {
    const result = createGeneratedPosConfig({
      ...BASE_INPUT,
      config: defaultProjectConfig,
    });

    const roundTripped = JSON.parse(JSON.stringify(result));

    expect(roundTripped).toEqual(result);
  });

  // 13. empty menu is valid
  it("accepts an empty menu", () => {
    const config: ProjectConfig = {
      ...cloneProjectConfig(defaultProjectConfig),
      menuItems: [],
    };

    const result = createGeneratedPosConfig({ ...BASE_INPUT, config });

    expect(result.menuItems).toEqual([]);
  });

  // 14. salon untracked services
  it("keeps salon's untracked services untracked with zero stock", () => {
    const salon = templates.find((template) => template.id === "salon");
    expect(salon).toBeDefined();

    const result = createGeneratedPosConfig({
      ...BASE_INPUT,
      templateId: "salon",
      config: salon!.starterConfig,
    });

    expect(result.menuItems.length).toBeGreaterThan(0);
    for (const item of result.menuItems) {
      expect(item.trackInventory).toBe(false);
      expect(item.stockQuantity).toBe(0);
    }
  });

  // 15. retail/liquor tracked inventory fields
  it("preserves retail and liquor-store tracked inventory fields", () => {
    for (const templateId of ["retail", "liquor-store"]) {
      const template = templates.find((candidate) => candidate.id === templateId);
      expect(template).toBeDefined();

      const result = createGeneratedPosConfig({
        ...BASE_INPUT,
        templateId,
        config: template!.starterConfig,
      });

      expect(result.menuItems.length).toBeGreaterThan(0);
      for (const item of result.menuItems) {
        expect(item.trackInventory).toBe(true);
        expect(item.stockQuantity).toBeGreaterThan(0);
      }
    }
  });

  // 16. invalid/non-finite/negative prices normalize to 0
  it("normalizes invalid, non-finite, and negative prices to 0", () => {
    const config: ProjectConfig = {
      ...cloneProjectConfig(defaultProjectConfig),
      menuItems: [
        { id: "a", name: "NaN price", price: NaN, category: "Food", trackInventory: false, stockQuantity: 0 },
        { id: "b", name: "Infinite price", price: Infinity, category: "Food", trackInventory: false, stockQuantity: 0 },
        { id: "c", name: "Negative price", price: -5, category: "Food", trackInventory: false, stockQuantity: 0 },
        { id: "d", name: "Valid price", price: 9.99, category: "Food", trackInventory: false, stockQuantity: 0 },
      ],
    };

    const result = createGeneratedPosConfig({ ...BASE_INPUT, config });

    expect(result.menuItems[0].price).toBe(0);
    expect(result.menuItems[1].price).toBe(0);
    expect(result.menuItems[2].price).toBe(0);
    expect(result.menuItems[3].price).toBe(9.99);
  });

  // 17. invalid/negative/non-integer stock normalizes safely
  it("normalizes invalid, negative, and non-integer stock quantities safely", () => {
    const config: ProjectConfig = {
      ...cloneProjectConfig(defaultProjectConfig),
      menuItems: [
        { id: "a", name: "NaN stock", price: 1, category: "Food", trackInventory: true, stockQuantity: NaN },
        { id: "b", name: "Negative stock", price: 1, category: "Food", trackInventory: true, stockQuantity: -3 },
        { id: "c", name: "Fractional stock", price: 1, category: "Food", trackInventory: true, stockQuantity: 5.7 },
        { id: "d", name: "Valid stock", price: 1, category: "Food", trackInventory: true, stockQuantity: 12 },
      ],
    };

    const result = createGeneratedPosConfig({ ...BASE_INPUT, config });

    expect(result.menuItems[0].stockQuantity).toBe(0);
    expect(result.menuItems[1].stockQuantity).toBe(0);
    expect(result.menuItems[2].stockQuantity).toBe(5);
    expect(result.menuItems[3].stockQuantity).toBe(12);
  });

  // 18. invalid tax rate normalizes/clamps to 0-100
  it("clamps the tax rate to the 0-100 range and normalizes invalid values to 0", () => {
    const negative: ProjectConfig = {
      ...cloneProjectConfig(defaultProjectConfig),
      tax: { ...defaultProjectConfig.tax, rate: -10 },
    };
    const tooHigh: ProjectConfig = {
      ...cloneProjectConfig(defaultProjectConfig),
      tax: { ...defaultProjectConfig.tax, rate: 150 },
    };
    const notFinite: ProjectConfig = {
      ...cloneProjectConfig(defaultProjectConfig),
      tax: { ...defaultProjectConfig.tax, rate: NaN },
    };
    const valid: ProjectConfig = {
      ...cloneProjectConfig(defaultProjectConfig),
      tax: { ...defaultProjectConfig.tax, rate: 8.25 },
    };

    expect(
      createGeneratedPosConfig({ ...BASE_INPUT, config: negative }).tax.rate
    ).toBe(0);
    expect(
      createGeneratedPosConfig({ ...BASE_INPUT, config: tooHigh }).tax.rate
    ).toBe(100);
    expect(
      createGeneratedPosConfig({ ...BASE_INPUT, config: notFinite }).tax.rate
    ).toBe(0);
    expect(
      createGeneratedPosConfig({ ...BASE_INPUT, config: valid }).tax.rate
    ).toBe(8.25);
  });

  // 19. invalid category becomes General
  it("falls back invalid/empty categories to General", () => {
    const config: ProjectConfig = {
      ...cloneProjectConfig(defaultProjectConfig),
      menuItems: [
        { id: "a", name: "Empty", price: 1, category: "", trackInventory: false, stockQuantity: 0 },
        { id: "b", name: "Whitespace", price: 1, category: "   ", trackInventory: false, stockQuantity: 0 },
        {
          id: "c",
          name: "Non-string",
          price: 1,
          category: 123 as unknown as string,
          trackInventory: false,
          stockQuantity: 0,
        },
      ],
    };

    const result = createGeneratedPosConfig({ ...BASE_INPUT, config });

    expect(result.menuItems[0].category).toBe("General");
    expect(result.menuItems[1].category).toBe("General");
    expect(result.menuItems[2].category).toBe("General");
  });

  // 20. receipt/business display strings are trimmed
  it("trims business profile and receipt display strings", () => {
    const config: ProjectConfig = {
      ...cloneProjectConfig(defaultProjectConfig),
      businessProfile: {
        ...defaultProjectConfig.businessProfile,
        businessName: "  My Shop  ",
        email: "  owner@example.com  ",
      },
      receipt: {
        ...defaultProjectConfig.receipt,
        footer: "  Thanks for visiting!  ",
        headerMessage: "  Welcome  ",
      },
    };

    const result = createGeneratedPosConfig({ ...BASE_INPUT, config });

    expect(result.businessProfile.businessName).toBe("My Shop");
    expect(result.businessProfile.email).toBe("owner@example.com");
    expect(result.receipt.footer).toBe("Thanks for visiting!");
    expect(result.receipt.headerMessage).toBe("Welcome");
  });

  // 21. no Builder/session-only fields are present
  it("contains only the documented top-level fields, no Builder/session-only data", () => {
    const result = createGeneratedPosConfig({
      ...BASE_INPUT,
      config: defaultProjectConfig,
    });

    expect(Object.keys(result).sort()).toEqual(
      [
        "branding",
        "businessProfile",
        "generatedAt",
        "menuItems",
        "project",
        "receipt",
        "schemaVersion",
        "tax",
      ].sort()
    );

    expect(Object.keys(result.project).sort()).toEqual(
      ["layout", "projectId", "projectName", "templateId"].sort()
    );

    // Explicitly confirm none of the excluded Builder/session-only concepts
    // leaked onto the top-level object.
    const serialized = result as unknown as Record<string, unknown>;
    for (const forbiddenKey of [
      "cart",
      "checkoutOpen",
      "checkoutStatus",
      "completedOrders",
      "onboarding",
      "editorMode",
      "editorSection",
      "saveStatus",
      "isDirty",
      "selectedItemId",
      "inventoryTransactions",
      "orderTotals",
      "userId",
      "email",
      "supabase",
    ]) {
      expect(serialized[forbiddenKey]).toBeUndefined();
    }
  });
});

describe("createGeneratedPosConfigFilename", () => {
  it("sanitizes normal spaces into hyphens", () => {
    expect(createGeneratedPosConfigFilename("My Cafe")).toBe(
      "pos-canvas-my-cafe-v1.json"
    );
  });

  it("sanitizes slashes into hyphens", () => {
    expect(createGeneratedPosConfigFilename("A/B Test Store")).toBe(
      "pos-canvas-a-b-test-store-v1.json"
    );
  });

  it("sanitizes punctuation", () => {
    expect(createGeneratedPosConfigFilename("  Shop!!!  ")).toBe(
      "pos-canvas-shop-v1.json"
    );
  });

  it("collapses repeated separators into a single hyphen", () => {
    expect(createGeneratedPosConfigFilename("Coffee   &&&   Co")).toBe(
      "pos-canvas-coffee-co-v1.json"
    );
  });

  it("strips leading and trailing separators", () => {
    expect(createGeneratedPosConfigFilename("---Shop---")).toBe(
      "pos-canvas-shop-v1.json"
    );
  });

  it("falls back to 'project' when nothing survives sanitization", () => {
    expect(createGeneratedPosConfigFilename("!!!")).toBe(
      "pos-canvas-project-v1.json"
    );
    expect(createGeneratedPosConfigFilename("   ")).toBe(
      "pos-canvas-project-v1.json"
    );
  });

  it("never includes reserved filesystem characters", () => {
    const filename = createGeneratedPosConfigFilename(
      'Weird / \\ : * ? " < > | Name'
    );

    for (const char of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
      expect(filename.includes(char)).toBe(false);
    }
  });

  it("uses the real schema-version constant by default", () => {
    const filename = createGeneratedPosConfigFilename("My Cafe");
    expect(filename).toBe(
      `pos-canvas-my-cafe-v${GENERATED_POS_CONFIG_SCHEMA_VERSION}.json`
    );
  });

  it("does not mutate the projectName input", () => {
    const name = "  My Cafe  ";
    const before = name;
    createGeneratedPosConfigFilename(name);
    expect(name).toBe(before);
  });
});

describe("getGeneratedPosExportEligibility", () => {
  it("returns save-first when projectId is null", () => {
    const result = getGeneratedPosExportEligibility({
      projectId: null,
      isDirty: false,
      saveStatus: "idle",
    });

    expect(result).toEqual({ canExport: false, reason: "save-first" });
  });

  it("returns saving when a save is in progress", () => {
    const result = getGeneratedPosExportEligibility({
      projectId: "project-1",
      isDirty: true,
      saveStatus: "saving",
    });

    expect(result).toEqual({ canExport: false, reason: "saving" });
  });

  it("returns save-changes-first for a dirty saved project", () => {
    const result = getGeneratedPosExportEligibility({
      projectId: "project-1",
      isDirty: true,
      saveStatus: "saved",
    });

    expect(result).toEqual({ canExport: false, reason: "save-changes-first" });
  });

  it("returns ready for a clean saved project", () => {
    const result = getGeneratedPosExportEligibility({
      projectId: "project-1",
      isDirty: false,
      saveStatus: "saved",
    });

    expect(result).toEqual({ canExport: true, reason: "ready" });
  });

  it("does not mutate its input", () => {
    const input = {
      projectId: "project-1",
      isDirty: false,
      saveStatus: "saved" as const,
    };
    const before = { ...input };

    getGeneratedPosExportEligibility(input);

    expect(input).toEqual(before);
  });
});

describe("pretty-printed JSON export", () => {
  it("serializes with two-space indentation and parses back to the exact generated object", () => {
    const result = createGeneratedPosConfig({
      projectId: "project-123",
      projectName: "Test Project",
      templateId: "restaurant",
      config: defaultProjectConfig,
    });

    const jsonText = JSON.stringify(result, null, 2);

    // Confirms two-space indentation is actually present in the serialized
    // text, not just that JSON.parse can recover the value.
    expect(jsonText).toContain('\n  "schemaVersion"');

    expect(JSON.parse(jsonText)).toEqual(result);
  });

  it("a trailing newline does not affect parsing", () => {
    const result = createGeneratedPosConfig({
      projectId: "project-123",
      projectName: "Test Project",
      templateId: "restaurant",
      config: defaultProjectConfig,
    });

    const jsonTextWithNewline = `${JSON.stringify(result, null, 2)}\n`;

    expect(JSON.parse(jsonTextWithNewline)).toEqual(result);
  });
});

describe("isGeneratedPosConfig", () => {
  function makeValidConfig() {
    return createGeneratedPosConfig({
      ...BASE_INPUT,
      config: defaultProjectConfig,
    });
  }

  it("accepts a real schema v1 config", () => {
    expect(isGeneratedPosConfig(makeValidConfig())).toBe(true);
  });

  it("rejects schemaVersion 2", () => {
    const config = { ...makeValidConfig(), schemaVersion: 2 };
    expect(isGeneratedPosConfig(config)).toBe(false);
  });

  it("rejects a missing schemaVersion", () => {
    const config = { ...makeValidConfig() } as Record<string, unknown>;
    delete config.schemaVersion;
    expect(isGeneratedPosConfig(config)).toBe(false);
  });

  it("rejects an invalid generatedAt", () => {
    const config = { ...makeValidConfig(), generatedAt: "not-a-date" };
    expect(isGeneratedPosConfig(config)).toBe(false);
  });

  it("rejects an arbitrary layout string", () => {
    const valid = makeValidConfig();
    const config = {
      ...valid,
      project: { ...valid.project, layout: "carousel-grid" },
    };
    expect(isGeneratedPosConfig(config)).toBe(false);
  });

  it("accepts every known PosLayout value", () => {
    const valid = makeValidConfig();
    for (const layout of ["menu-grid", "product-grid", "service-grid"]) {
      const config = { ...valid, project: { ...valid.project, layout } };
      expect(isGeneratedPosConfig(config)).toBe(true);
    }
  });

  it("rejects missing project fields", () => {
    const valid = makeValidConfig();
    const config = {
      ...valid,
      project: { ...valid.project, projectId: "" },
    };
    expect(isGeneratedPosConfig(config)).toBe(false);
  });

  it("rejects a missing project object entirely", () => {
    const config = { ...makeValidConfig() } as Record<string, unknown>;
    delete config.project;
    expect(isGeneratedPosConfig(config)).toBe(false);
  });

  it("rejects malformed menuItems", () => {
    const config = { ...makeValidConfig(), menuItems: "not-an-array" };
    expect(isGeneratedPosConfig(config)).toBe(false);
  });

  it("rejects malformed top-level required objects", () => {
    const valid = makeValidConfig();

    for (const key of ["businessProfile", "branding", "tax", "receipt"] as const) {
      const config = { ...valid, [key]: "not-an-object" };
      expect(isGeneratedPosConfig(config)).toBe(false);
    }
  });

  it("rejects a non-object value", () => {
    expect(isGeneratedPosConfig(null)).toBe(false);
    expect(isGeneratedPosConfig(undefined)).toBe(false);
    expect(isGeneratedPosConfig("a string")).toBe(false);
    expect(isGeneratedPosConfig(42)).toBe(false);
    expect(isGeneratedPosConfig([])).toBe(false);
  });
});
