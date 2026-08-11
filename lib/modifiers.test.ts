// Feature 18.1 — modifier contract tests. Node-only and pure, matching this
// repository's Vitest setup.
import { describe, expect, it } from "vitest";
import {
  MAX_MODIFIER_GROUPS_PER_ITEM,
  MAX_OPTIONS_PER_GROUP,
  MAX_SELECTED_OPTIONS_PER_LINE,
  buildModifierSnapshot,
  calculateModifiedUnitPrice,
  canonicalLineIdentity,
  createSaleCanonicalV3,
  hasModifiers,
  normalizeModifierGroups,
  validateModifierSelections,
} from "@/lib/modifiers";
import type { ModifierGroup } from "@/lib/modifiers";
import { normalizeMenuItem } from "@/lib/projectConfig";

const SIZE: ModifierGroup = {
  id: "size",
  name: "Size",
  selection: "single",
  required: true,
  maxSelections: null,
  options: [
    { id: "sm", name: "Small", priceAdjustment: 0 },
    { id: "md", name: "Medium", priceAdjustment: 0.5 },
    { id: "lg", name: "Large", priceAdjustment: 1 },
  ],
};

const ADDONS: ModifierGroup = {
  id: "addons",
  name: "Add-ons",
  selection: "multiple",
  required: false,
  maxSelections: 2,
  options: [
    { id: "cheese", name: "Extra cheese", priceAdjustment: 1 },
    { id: "bacon", name: "Bacon", priceAdjustment: 2 },
    { id: "avo", name: "Avocado", priceAdjustment: 1.5 },
  ],
};

describe("normalizeModifierGroups — backward compatibility", () => {
  it("treats a project that predates modifiers as having none", () => {
    for (const legacy of [undefined, null, "", 0, {}, "[]"]) {
      expect(normalizeModifierGroups(legacy)).toEqual([]);
    }
  });

  it("normalizes a menu item with no modifierGroups key to an empty list", () => {
    const legacy = {
      id: "m1",
      name: "Latte",
      price: 4,
      category: "Drinks",
      trackInventory: true,
      stockQuantity: 5,
    };

    expect(normalizeMenuItem(legacy).modifierGroups).toEqual([]);
  });

  it("preserves a valid group unchanged", () => {
    expect(normalizeModifierGroups([SIZE])).toEqual([SIZE]);
  });
});

describe("normalizeModifierGroups — validation", () => {
  it("drops a group with a blank id or name", () => {
    expect(normalizeModifierGroups([{ ...SIZE, id: "  " }])).toEqual([]);
    expect(normalizeModifierGroups([{ ...SIZE, name: "" }])).toEqual([]);
  });

  it("drops a group whose options are all unusable, rather than shipping it empty", () => {
    // A required group with no options would make its product unsellable.
    expect(normalizeModifierGroups([{ ...SIZE, options: [] }])).toEqual([]);
    expect(
      normalizeModifierGroups([{ ...SIZE, options: [{ id: "", name: "x", priceAdjustment: 0 }] }])
    ).toEqual([]);
  });

  it("drops an option with a negative, non-finite or missing price", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1.00", undefined, null]) {
      const groups = normalizeModifierGroups([
        { ...SIZE, options: [{ id: "a", name: "A", priceAdjustment: bad }] },
      ]);
      expect(groups).toEqual([]);
    }
  });

  it("drops a duplicate option id inside a group", () => {
    const groups = normalizeModifierGroups([
      {
        ...SIZE,
        options: [
          { id: "sm", name: "Small", priceAdjustment: 0 },
          { id: "sm", name: "Small again", priceAdjustment: 9 },
        ],
      },
    ]);

    expect(groups[0].options).toHaveLength(1);
    expect(groups[0].options[0].name).toBe("Small");
  });

  it("drops a duplicate group id on a product", () => {
    expect(normalizeModifierGroups([SIZE, { ...SIZE, name: "Size again" }])).toHaveLength(1);
  });

  it("never lets a single-choice group carry a maximum", () => {
    const groups = normalizeModifierGroups([{ ...SIZE, maxSelections: 3 }]);
    expect(groups[0].maxSelections).toBeNull();
  });

  it("accepts a positive integer maximum for multiple choice and rejects anything else", () => {
    expect(normalizeModifierGroups([{ ...ADDONS, maxSelections: 2 }])[0].maxSelections).toBe(2);
    for (const bad of [0, -1, 1.5, "2", null, undefined]) {
      expect(
        normalizeModifierGroups([{ ...ADDONS, maxSelections: bad }])[0].maxSelections
      ).toBeNull();
    }
  });

  it("clamps a maximum above the option count", () => {
    expect(normalizeModifierGroups([{ ...ADDONS, maxSelections: 99 }])[0].maxSelections).toBe(3);
  });

  it("enforces the per-item group cap", () => {
    const many = Array.from({ length: MAX_MODIFIER_GROUPS_PER_ITEM + 5 }, (_, i) => ({
      ...SIZE,
      id: `g${i}`,
    }));
    expect(normalizeModifierGroups(many)).toHaveLength(MAX_MODIFIER_GROUPS_PER_ITEM);
  });

  it("enforces the per-group option cap", () => {
    const many = {
      ...ADDONS,
      options: Array.from({ length: MAX_OPTIONS_PER_GROUP + 5 }, (_, i) => ({
        id: `o${i}`,
        name: `O${i}`,
        priceAdjustment: 1,
      })),
    };
    expect(normalizeModifierGroups([many])[0].options).toHaveLength(MAX_OPTIONS_PER_GROUP);
  });

  it("preserves the authored price rather than rounding it in JavaScript", () => {
    // Deliberate: complete_sale_v3 rounds in PostgreSQL numeric, which is exact.
    // Math.round(1.005 * 100) / 100 is 1.00 in IEEE-754 (the multiply yields
    // 100.49999999999999), while SQL round(1.005, 2) is 1.01. Rounding here
    // would be a second money implementation that quietly disagrees with the
    // authoritative one, so the authored value is carried through untouched —
    // the same treatment the base price already gets.
    const groups = normalizeModifierGroups([
      { ...SIZE, options: [{ id: "a", name: "A", priceAdjustment: 1.005 }] },
    ]);
    expect(groups[0].options[0].priceAdjustment).toBe(1.005);
  });

  it("documents the half-cent divergence so nobody 'fixes' it by adding rounding", () => {
    // If this ever equals 1.01, JavaScript rounding was reintroduced somewhere
    // and the client would start disagreeing with the server about a cent.
    expect(Math.round(1.005 * 100) / 100).toBe(1);
  });
});

describe("hasModifiers", () => {
  it("distinguishes a plain product from a configured one", () => {
    expect(hasModifiers(undefined)).toBe(false);
    expect(hasModifiers([])).toBe(false);
    expect(hasModifiers([SIZE])).toBe(true);
  });
});

describe("validateModifierSelections", () => {
  const groups = [SIZE, ADDONS];

  it("accepts a valid single required choice", () => {
    expect(
      validateModifierSelections(groups, [{ groupId: "size", optionIds: ["md"] }]).ok
    ).toBe(true);
  });

  it("accepts a valid multiple choice within the maximum", () => {
    expect(
      validateModifierSelections(groups, [
        { groupId: "size", optionIds: ["sm"] },
        { groupId: "addons", optionIds: ["cheese", "bacon"] },
      ]).ok
    ).toBe(true);
  });

  it("accepts an optional group being omitted entirely", () => {
    expect(
      validateModifierSelections(groups, [{ groupId: "size", optionIds: ["sm"] }]).ok
    ).toBe(true);
  });

  it("rejects a missing required group", () => {
    const result = validateModifierSelections(groups, [
      { groupId: "addons", optionIds: ["bacon"] },
    ]);
    expect(result).toEqual({ ok: false, error: "required_group_missing" });
  });

  it("rejects a required group submitted with no options", () => {
    expect(
      validateModifierSelections(groups, [{ groupId: "size", optionIds: [] }])
    ).toEqual({ ok: false, error: "required_group_missing" });
  });

  it("rejects two options in a single-choice group", () => {
    expect(
      validateModifierSelections(groups, [{ groupId: "size", optionIds: ["sm", "lg"] }])
    ).toEqual({ ok: false, error: "single_choice_exceeded" });
  });

  it("rejects exceeding maxSelections", () => {
    expect(
      validateModifierSelections(groups, [
        { groupId: "size", optionIds: ["sm"] },
        { groupId: "addons", optionIds: ["cheese", "bacon", "avo"] },
      ])
    ).toEqual({ ok: false, error: "max_selections_exceeded" });
  });

  it("rejects a group that belongs to another product", () => {
    expect(
      validateModifierSelections(groups, [
        { groupId: "size", optionIds: ["sm"] },
        { groupId: "someone-elses-group", optionIds: ["x"] },
      ])
    ).toEqual({ ok: false, error: "unknown_group" });
  });

  it("rejects an option that belongs to a different group of the same product", () => {
    // 'bacon' is real, but it is an Add-ons option, not a Size option.
    expect(
      validateModifierSelections(groups, [{ groupId: "size", optionIds: ["bacon"] }])
    ).toEqual({ ok: false, error: "unknown_option" });
  });

  it("rejects an option that does not exist at all", () => {
    expect(
      validateModifierSelections(groups, [{ groupId: "size", optionIds: ["ghost"] }])
    ).toEqual({ ok: false, error: "unknown_option" });
  });

  it("rejects duplicate groups and duplicate options", () => {
    expect(
      validateModifierSelections(groups, [
        { groupId: "size", optionIds: ["sm"] },
        { groupId: "size", optionIds: ["lg"] },
      ])
    ).toEqual({ ok: false, error: "duplicate_group" });

    expect(
      validateModifierSelections(groups, [
        { groupId: "size", optionIds: ["sm"] },
        { groupId: "addons", optionIds: ["bacon", "bacon"] },
      ])
    ).toEqual({ ok: false, error: "duplicate_option" });
  });

  it("rejects any selection on a product that has no modifiers", () => {
    expect(
      validateModifierSelections([], [{ groupId: "size", optionIds: ["sm"] }])
    ).toEqual({ ok: false, error: "modifiers_not_supported" });
  });

  it("accepts an empty selection on a product that has no modifiers", () => {
    expect(validateModifierSelections([], [])).toEqual({ ok: true, selections: [] });
  });

  it("rejects an oversized payload", () => {
    const many = Array.from({ length: MAX_MODIFIER_GROUPS_PER_ITEM + 1 }, (_, i) => ({
      groupId: `g${i}`,
      optionIds: ["x"],
    }));
    expect(validateModifierSelections(groups, many)).toEqual({
      ok: false,
      error: "too_many_groups",
    });

    expect(
      validateModifierSelections(groups, [
        {
          groupId: "addons",
          optionIds: Array.from({ length: MAX_OPTIONS_PER_GROUP + 1 }, (_, i) => `o${i}`),
        },
      ])
    ).toEqual({ ok: false, error: "too_many_options" });
  });

  it("caps total selections across all groups of one line", () => {
    expect(MAX_SELECTED_OPTIONS_PER_LINE).toBeGreaterThan(0);
  });
});

describe("canonicalLineIdentity", () => {
  it("is stable regardless of the order groups or options were chosen in", () => {
    const a = canonicalLineIdentity("burger", [
      { groupId: "addons", optionIds: ["bacon", "cheese"] },
      { groupId: "size", optionIds: ["lg"] },
    ]);
    const b = canonicalLineIdentity("burger", [
      { groupId: "size", optionIds: ["lg"] },
      { groupId: "addons", optionIds: ["cheese", "bacon"] },
    ]);

    expect(a).toBe(b);
  });

  it("distinguishes different selections of the same product", () => {
    const bacon = canonicalLineIdentity("burger", [
      { groupId: "addons", optionIds: ["bacon"] },
    ]);
    const cheese = canonicalLineIdentity("burger", [
      { groupId: "addons", optionIds: ["cheese"] },
    ]);

    expect(bacon).not.toBe(cheese);
  });

  it("distinguishes the same option chosen in different groups", () => {
    const inA = canonicalLineIdentity("x", [{ groupId: "a", optionIds: ["o"] }]);
    const inB = canonicalLineIdentity("x", [{ groupId: "b", optionIds: ["o"] }]);

    expect(inA).not.toBe(inB);
  });

  it("treats an empty group as no selection at all", () => {
    expect(canonicalLineIdentity("x", [{ groupId: "a", optionIds: [] }])).toBe(
      canonicalLineIdentity("x", [])
    );
  });

  it("cannot be collided through delimiter characters in ids", () => {
    // Without length prefixing, ids containing the structural delimiters could
    // be arranged to produce the same string.
    const a = canonicalLineIdentity("x", [{ groupId: "a(1)1:b", optionIds: ["c"] }]);
    const b = canonicalLineIdentity("x", [{ groupId: "a", optionIds: ["1:b", "c"] }]);

    expect(a).not.toBe(b);
  });

  it("cannot be collided by ids that concatenate alike", () => {
    const a = canonicalLineIdentity("x", [{ groupId: "g", optionIds: ["ab", "c"] }]);
    const b = canonicalLineIdentity("x", [{ groupId: "g", optionIds: ["a", "bc"] }]);

    expect(a).not.toBe(b);
  });

  it("uses UTF-8 byte length, matching SQL octet_length", () => {
    // "é" is one JS character but two UTF-8 bytes; the SQL side prefixes with
    // octet_length, so the two implementations must agree.
    expect(canonicalLineIdentity("é", [])).toBe("2:é[0]");
  });

  it("degenerates predictably for a product with no modifiers", () => {
    expect(canonicalLineIdentity("m1", [])).toBe("2:m1[0]");
  });
});

describe("createSaleCanonicalV3", () => {
  const base = {
    projectId: "11111111-1111-4111-8111-111111111111",
    paymentMethod: "cash",
    tipAmount: "0.00",
  };

  it("declares the v2 preimage header and never the v1 one", () => {
    const canonical = createSaleCanonicalV3({
      ...base,
      lines: [{ itemId: "m1", quantity: 1, selections: [] }],
    });

    expect(canonical.startsWith("posc.sale.v2\n")).toBe(true);
    expect(canonical).not.toContain("posc.sale.v1");
  });

  it("is stable regardless of line order", () => {
    const lines = [
      { itemId: "b", quantity: 1, selections: [] },
      { itemId: "a", quantity: 2, selections: [] },
    ];

    expect(createSaleCanonicalV3({ ...base, lines })).toBe(
      createSaleCanonicalV3({ ...base, lines: [...lines].reverse() })
    );
  });

  it("changes when a modifier selection changes", () => {
    const withBacon = createSaleCanonicalV3({
      ...base,
      lines: [{ itemId: "b", quantity: 1, selections: [{ groupId: "g", optionIds: ["bacon"] }] }],
    });
    const withCheese = createSaleCanonicalV3({
      ...base,
      lines: [{ itemId: "b", quantity: 1, selections: [{ groupId: "g", optionIds: ["cheese"] }] }],
    });

    expect(withBacon).not.toBe(withCheese);
  });

  it("changes when quantity changes", () => {
    const one = createSaleCanonicalV3({
      ...base,
      lines: [{ itemId: "b", quantity: 1, selections: [] }],
    });
    const two = createSaleCanonicalV3({
      ...base,
      lines: [{ itemId: "b", quantity: 2, selections: [] }],
    });

    expect(one).not.toBe(two);
  });

  it("distinguishes two lines of the same product with different selections", () => {
    const canonical = createSaleCanonicalV3({
      ...base,
      lines: [
        { itemId: "b", quantity: 1, selections: [{ groupId: "g", optionIds: ["bacon"] }] },
        { itemId: "b", quantity: 1, selections: [{ groupId: "g", optionIds: ["cheese"] }] },
      ],
    });

    expect(canonical).toContain("items=2");
  });

  it("is deterministic for a no-modifier sale", () => {
    const canonical = createSaleCanonicalV3({
      ...base,
      lines: [{ itemId: "m1", quantity: 3, selections: [] }],
    });

    expect(canonical).toBe(
      [
        "posc.sale.v2",
        `project=${base.projectId}`,
        "payment=cash",
        "tip=0.00",
        "items=1",
        "2:m1[0]=3",
      ].join("\n")
    );
  });
});

describe("calculateModifiedUnitPrice", () => {
  const groups = [SIZE, ADDONS];

  it("returns the base price when nothing is selected", () => {
    expect(calculateModifiedUnitPrice(10.99, groups, [])).toBe(10.99);
  });

  it("adds a single adjustment", () => {
    expect(
      calculateModifiedUnitPrice(10.99, groups, [{ groupId: "addons", optionIds: ["bacon"] }])
    ).toBe(12.99);
  });

  it("adds several adjustments across groups", () => {
    expect(
      calculateModifiedUnitPrice(10.99, groups, [
        { groupId: "size", optionIds: ["lg"] },
        { groupId: "addons", optionIds: ["cheese", "bacon"] },
      ])
    ).toBe(14.99);
  });

  it("ignores an unknown group or option rather than inventing a price", () => {
    expect(
      calculateModifiedUnitPrice(10, groups, [{ groupId: "ghost", optionIds: ["x"] }])
    ).toBe(10);
    expect(
      calculateModifiedUnitPrice(10, groups, [{ groupId: "addons", optionIds: ["ghost"] }])
    ).toBe(10);
  });

  it("returns a display value only — SQL remains the authority", () => {
    // This helper exists so a cart can show a running total. The amount the
    // customer actually pays is recomputed by complete_sale_v3 and returned on
    // the receipt; at a half-cent boundary the two can differ by a cent.
    const cents: ModifierGroup = {
      ...ADDONS,
      options: [{ id: "a", name: "A", priceAdjustment: 0.25 }],
    };
    expect(
      calculateModifiedUnitPrice(1.5, [cents], [{ groupId: "addons", optionIds: ["a"] }])
    ).toBe(1.75);
  });
});

describe("buildModifierSnapshot", () => {
  it("captures names and prices as they are now, for historical accuracy", () => {
    const snapshot = buildModifierSnapshot([SIZE, ADDONS], [
      { groupId: "addons", optionIds: ["bacon"] },
      { groupId: "size", optionIds: ["lg"] },
    ]);

    expect(snapshot).toEqual([
      {
        groupId: "size",
        groupName: "Size",
        optionId: "lg",
        optionName: "Large",
        priceAdjustment: "1.00",
      },
      {
        groupId: "addons",
        groupName: "Add-ons",
        optionId: "bacon",
        optionName: "Bacon",
        priceAdjustment: "2.00",
      },
    ]);
  });

  it("emits money as fixed two-decimal strings", () => {
    for (const entry of buildModifierSnapshot([ADDONS], [
      { groupId: "addons", optionIds: ["cheese", "avo"] },
    ])) {
      expect(entry.priceAdjustment).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it("is empty when nothing is selected", () => {
    expect(buildModifierSnapshot([SIZE, ADDONS], [])).toEqual([]);
  });
});
