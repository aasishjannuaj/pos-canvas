// Feature 18.2 Phase 4 — behavioral tests for owner modifier authoring.
//
// Every editor gesture is a pure function here, so these test the real code the
// Builder runs rather than a re-implementation of it. The component itself is
// covered by lib/modifierAuthoring.guards.test.ts (this repository has no DOM
// test setup, per its standing convention).
import { describe, expect, it } from "vitest";
import {
  addModifierGroup,
  addModifierOption,
  canAddModifierGroup,
  canAddModifierOption,
  createModifierGroup,
  createModifierId,
  createModifierOption,
  findItemsWithUnsaveableModifiers,
  getItemSelectionCapacityNotice,
  getMaxSelectableOptions,
  getModifierGroupNotice,
  getModifierSaveBlockerMessage,
  isModifierGroupLossy,
  normalizeConfigModifiers,
  previewNormalizedGroup,
  toEditableModifierGroups,
  removeModifierGroup,
  removeModifierOption,
  setModifierGroupMaxSelections,
  setModifierGroupSelection,
  updateModifierGroup,
  updateModifierOption,
} from "@/lib/modifierAuthoring";
import {
  MAX_MODIFIER_GROUPS_PER_ITEM,
  MAX_OPTIONS_PER_GROUP,
  MAX_SELECTED_OPTIONS_PER_LINE,
  normalizeModifierGroups,
  validateModifierSelections,
} from "@/lib/modifiers";
import type { ModifierGroup } from "@/lib/modifiers";
import { defaultProjectConfig, normalizeProjectConfig } from "@/lib/projectConfig";
import type { MenuItem, ProjectConfig } from "@/lib/projectConfig";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";

/** Deterministic ids, so a test can assert identity without matching a UUID. */
function sequentialIds(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

/** A fully authored, saveable group. */
function completeGroup(overrides: Partial<ModifierGroup> = {}): ModifierGroup {
  return {
    id: "group-1",
    name: "Size",
    selection: "single",
    required: true,
    maxSelections: null,
    options: [
      { id: "option-1", name: "Small", priceAdjustment: 0 },
      { id: "option-2", name: "Large", priceAdjustment: 1.5 },
    ],
    ...overrides,
  };
}

describe("creating groups and options", () => {
  it("adds a group seeded with one empty option", () => {
    const groups = addModifierGroup([], sequentialIds());

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("");
    expect(groups[0].selection).toBe("single");
    expect(groups[0].required).toBe(false);
    expect(groups[0].maxSelections).toBeNull();
    // A group with zero options is unsaveable, so a new one is never empty.
    expect(groups[0].options).toHaveLength(1);
  });

  it("gives every new group and option a distinct id", () => {
    const createId = sequentialIds();
    const groups = addModifierOption(
      addModifierGroup(addModifierGroup([], createId), createId),
      "id-1",
      createId
    );

    const ids = [
      ...groups.map((group) => group.id),
      ...groups.flatMap((group) => group.options.map((option) => option.id)),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("mints a real uuid from crypto when available", () => {
    expect(createModifierId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("falls back to a non-empty id rather than throwing without crypto", () => {
    // Authoring is local editor state, not a money path: losing the ability to
    // add a group would be worse than a weaker id. createSaleRequestId throws
    // in the same situation precisely because ITS id is a money path.
    const id = createModifierId(null);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("adds an option to the named group only", () => {
    const createId = sequentialIds("new");
    const groups = [completeGroup(), completeGroup({ id: "group-2" })];

    const next = addModifierOption(groups, "group-1", createId);

    expect(next[0].options).toHaveLength(3);
    expect(next[1].options).toHaveLength(2);
    expect(next[0].options[2]).toEqual({
      id: "new-1",
      name: "",
      priceAdjustment: 0,
    });
  });
});

describe("ids are stable across every edit", () => {
  // Load-bearing: canonicalLineIdentity builds a cart line's identity from item
  // + group + option ids, complete_sale_v3 hashes it, and order_items.modifiers
  // freezes it into history. A regenerated id would stop two identical carts
  // merging, stop a retry matching its original sale, and break old receipts.
  const original = completeGroup();

  const edits: [string, (groups: ModifierGroup[]) => ModifierGroup[]][] = [
    ["renaming the group", (g) => updateModifierGroup(g, "group-1", { name: "Portion" })],
    ["toggling required", (g) => updateModifierGroup(g, "group-1", { required: false })],
    ["switching to multiple", (g) => setModifierGroupSelection(g, "group-1", "multiple")],
    ["switching back to single", (g) => setModifierGroupSelection(g, "group-1", "single")],
    ["setting a maximum", (g) => setModifierGroupMaxSelections(g, "group-1", 2)],
    [
      "renaming an option",
      (g) => updateModifierOption(g, "group-1", "option-2", { name: "Extra Large" }),
    ],
    [
      "repricing an option",
      (g) => updateModifierOption(g, "group-1", "option-2", { priceAdjustment: 99 }),
    ],
  ];

  for (const [label, edit] of edits) {
    it(`preserves group and option ids when ${label}`, () => {
      const next = edit([original]);

      expect(next[0].id).toBe("group-1");
      expect(next[0].options.map((option) => option.id)).toEqual([
        "option-1",
        "option-2",
      ]);
    });
  }

  it("never mutates the input array", () => {
    const groups = [completeGroup()];
    const snapshot = JSON.parse(JSON.stringify(groups));

    updateModifierGroup(groups, "group-1", { name: "Changed" });
    removeModifierOption(groups, "group-1", "option-1");
    addModifierOption(groups, "group-1", sequentialIds());

    expect(groups).toEqual(snapshot);
  });
});

describe("editing names, prices and flags", () => {
  it("edits the group name", () => {
    const next = updateModifierGroup([completeGroup()], "group-1", { name: "Portion" });
    expect(next[0].name).toBe("Portion");
  });

  it("toggles required without touching options", () => {
    const next = updateModifierGroup([completeGroup()], "group-1", { required: false });
    expect(next[0].required).toBe(false);
    expect(next[0].options).toHaveLength(2);
  });

  it("edits an option name", () => {
    const next = updateModifierOption([completeGroup()], "group-1", "option-1", {
      name: "Regular",
    });
    expect(next[0].options[0].name).toBe("Regular");
    expect(next[0].options[1].name).toBe("Large");
  });

  it("edits a price adjustment and allows zero", () => {
    const next = updateModifierOption([completeGroup()], "group-1", "option-2", {
      priceAdjustment: 0,
    });
    expect(next[0].options[1].priceAdjustment).toBe(0);
  });

  it("floors a negative price adjustment at zero rather than persisting it", () => {
    // normalizeModifierGroups DROPS a negative option rather than coercing it,
    // so allowing a negative into the draft would mean the owner types a
    // discount, sees it, and silently loses the whole option on save.
    const next = updateModifierOption([completeGroup()], "group-1", "option-2", {
      priceAdjustment: -5,
    });

    expect(next[0].options[1].priceAdjustment).toBe(0);
    expect(previewNormalizedGroup(next[0])?.options).toHaveLength(2);
  });

  it("replaces a non-finite price adjustment with zero", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const next = updateModifierOption([completeGroup()], "group-1", "option-1", {
        priceAdjustment: bad,
      });
      expect(next[0].options[0].priceAdjustment).toBe(0);
    }
  });

  it("does not round a price adjustment, leaving money to complete_sale_v3", () => {
    // Math.round(1.005 * 100) / 100 is 1.00 in IEEE-754 while SQL's
    // round(numeric, 2) gives 1.01. A second rounding implementation here would
    // silently disagree with the authoritative one.
    const next = updateModifierOption([completeGroup()], "group-1", "option-1", {
      priceAdjustment: 1.005,
    });
    expect(next[0].options[0].priceAdjustment).toBe(1.005);
  });
});

describe("switching between single and multiple", () => {
  it("clears maxSelections when going multiple -> single", () => {
    const multiple = completeGroup({ selection: "multiple", maxSelections: 2 });
    const next = setModifierGroupSelection([multiple], "group-1", "single");

    expect(next[0].selection).toBe("single");
    expect(next[0].maxSelections).toBeNull();
  });

  it("preserves options and required when going multiple -> single", () => {
    const multiple = completeGroup({
      selection: "multiple",
      maxSelections: 2,
      required: true,
    });
    const next = setModifierGroupSelection([multiple], "group-1", "single");

    expect(next[0].required).toBe(true);
    expect(next[0].options).toHaveLength(2);
    expect(next[0].options.map((option) => option.name)).toEqual(["Small", "Large"]);
  });

  it("starts maxSelections at null when going single -> multiple", () => {
    const next = setModifierGroupSelection([completeGroup()], "group-1", "multiple");

    expect(next[0].selection).toBe("multiple");
    expect(next[0].maxSelections).toBeNull();
  });

  it("never removes options in either direction", () => {
    let groups = [completeGroup()];
    for (const selection of ["multiple", "single", "multiple", "single"] as const) {
      groups = setModifierGroupSelection(groups, "group-1", selection);
      expect(groups[0].options).toHaveLength(2);
    }
  });
});

describe("max selections", () => {
  const multiple = completeGroup({ selection: "multiple" });

  it("accepts a positive integer", () => {
    const next = setModifierGroupMaxSelections([multiple], "group-1", 2);
    expect(next[0].maxSelections).toBe(2);
  });

  it("treats an emptied input as no explicit maximum", () => {
    const next = setModifierGroupMaxSelections([multiple], "group-1", null);
    expect(next[0].maxSelections).toBeNull();
  });

  it("rejects zero, negatives and non-integers", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const next = setModifierGroupMaxSelections([multiple], "group-1", bad);
      expect(next[0].maxSelections).toBeNull();
    }
  });

  it("never stores a maximum on a single-choice group", () => {
    // The selection type already implies a maximum of one; the normalizer would
    // drop the number anyway, so storing it would only mislead the editor.
    const next = setModifierGroupMaxSelections([completeGroup()], "group-1", 3);
    expect(next[0].maxSelections).toBeNull();
  });
});

describe("deleting", () => {
  it("removing an option removes only that option", () => {
    const next = removeModifierOption([completeGroup()], "group-1", "option-1");

    expect(next[0].options).toHaveLength(1);
    expect(next[0].options[0].id).toBe("option-2");
  });

  it("removing a group removes only that group", () => {
    const groups = [completeGroup(), completeGroup({ id: "group-2", name: "Milk" })];
    const next = removeModifierGroup(groups, "group-1");

    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("group-2");
    expect(next[0].options).toHaveLength(2);
  });

  it("removing an option from one group leaves other groups untouched", () => {
    const groups = [completeGroup(), completeGroup({ id: "group-2" })];
    const next = removeModifierOption(groups, "group-1", "option-1");

    expect(next[0].options).toHaveLength(1);
    expect(next[1].options).toHaveLength(2);
  });
});

describe("caps", () => {
  it("stops adding groups at MAX_MODIFIER_GROUPS_PER_ITEM", () => {
    const createId = sequentialIds();
    let groups: ModifierGroup[] = [];

    for (let i = 0; i < MAX_MODIFIER_GROUPS_PER_ITEM + 5; i += 1) {
      groups = addModifierGroup(groups, createId);
    }

    expect(groups).toHaveLength(MAX_MODIFIER_GROUPS_PER_ITEM);
    expect(canAddModifierGroup(groups)).toBe(false);
  });

  it("stops adding options at MAX_OPTIONS_PER_GROUP", () => {
    const createId = sequentialIds();
    let groups = [completeGroup({ options: [] })];

    for (let i = 0; i < MAX_OPTIONS_PER_GROUP + 5; i += 1) {
      groups = addModifierOption(groups, "group-1", createId);
    }

    expect(groups[0].options).toHaveLength(MAX_OPTIONS_PER_GROUP);
    expect(canAddModifierOption(groups[0])).toBe(false);
  });

  it("reports capacity truthfully just below each cap", () => {
    const createId = sequentialIds();
    let groups: ModifierGroup[] = [];
    for (let i = 0; i < MAX_MODIFIER_GROUPS_PER_ITEM - 1; i += 1) {
      groups = addModifierGroup(groups, createId);
    }
    expect(canAddModifierGroup(groups)).toBe(true);
  });

  it("uses the same caps the normalizer enforces", () => {
    // If the editor's cap were higher, the extra groups would be authored,
    // persisted, then silently dropped at build time.
    const createId = sequentialIds();
    let groups: ModifierGroup[] = [];
    for (let i = 0; i < MAX_MODIFIER_GROUPS_PER_ITEM; i += 1) {
      groups = addModifierGroup(groups, createId);
      groups = updateModifierGroup(groups, groups[i].id, { name: `Group ${i}` });
      groups = updateModifierOption(groups, groups[i].id, groups[i].options[0].id, {
        name: "Option",
      });
    }

    expect(normalizeModifierGroups(groups)).toHaveLength(MAX_MODIFIER_GROUPS_PER_ITEM);
  });
});

describe("the notice tells the owner what the save will do", () => {
  it("asks for a name on an unnamed group", () => {
    const groups = addModifierGroup([], sequentialIds());
    expect(getModifierGroupNotice(groups[0])).toContain("Name this group");
  });

  it("asks for an option on a named group with no usable options", () => {
    const group = completeGroup({ options: [{ id: "o", name: "", priceAdjustment: 0 }] });
    expect(getModifierGroupNotice(group)).toContain("at least one option");
  });

  it("counts options that would be dropped for want of a name", () => {
    const group = completeGroup({
      options: [
        { id: "option-1", name: "Small", priceAdjustment: 0 },
        { id: "option-2", name: "", priceAdjustment: 0 },
      ],
    });
    expect(getModifierGroupNotice(group)).toBe(
      "1 option needs a name before it can be saved."
    );
  });

  it("explains a maximum that will be clamped to the option count", () => {
    const group = completeGroup({ selection: "multiple", maxSelections: 9 });
    expect(getModifierGroupNotice(group)).toContain("maximum of 2");
  });

  it("says nothing about a group that saves exactly as authored", () => {
    expect(getModifierGroupNotice(completeGroup())).toBeNull();
  });

  it("is derived from the normalizer itself, not a restatement of its rules", () => {
    // Anything the normalizer would drop must produce a notice, and anything it
    // preserves intact must not. This is the property that keeps the two honest.
    const cases = [
      completeGroup(),
      completeGroup({ name: "" }),
      completeGroup({ options: [] }),
      completeGroup({ selection: "multiple", maxSelections: 99 }),
    ];

    for (const group of cases) {
      const normalized = previewNormalizedGroup(group);
      const savesExactly =
        normalized !== null && JSON.stringify(normalized) === JSON.stringify(group);

      expect(getModifierGroupNotice(group) === null).toBe(savesExactly);
    }
  });
});

describe("the save boundary normalizes without touching the draft", () => {
  function configWith(modifierGroups: unknown): ProjectConfig {
    return {
      ...defaultProjectConfig,
      menuItems: [
        {
          id: "item-1",
          name: "Latte",
          price: 4,
          category: "Drinks",
          trackInventory: false,
          stockQuantity: 0,
          modifierGroups,
        } as unknown as MenuItem,
      ],
    };
  }

  it("drops a half-typed group on the way to the database", () => {
    const config = configWith([completeGroup({ name: "" })]);
    const persisted = normalizeConfigModifiers(config);

    expect(persisted.menuItems[0].modifierGroups).toEqual([]);
  });

  it("drops a group with no usable options", () => {
    const config = configWith([completeGroup({ options: [] })]);
    expect(normalizeConfigModifiers(config).menuItems[0].modifierGroups).toEqual([]);
  });

  it("clamps an oversized maximum to the option count", () => {
    const config = configWith([
      completeGroup({ selection: "multiple", maxSelections: 99 }),
    ]);
    expect(
      normalizeConfigModifiers(config).menuItems[0].modifierGroups?.[0].maxSelections
    ).toBe(2);
  });

  it("keeps a fully authored group byte-for-byte", () => {
    const group = completeGroup();
    const persisted = normalizeConfigModifiers(configWith([group]));

    expect(persisted.menuItems[0].modifierGroups).toEqual([group]);
  });

  it("never mutates the draft config it was given", () => {
    const config = configWith([completeGroup({ name: "" })]);
    const snapshot = JSON.parse(JSON.stringify(config));

    normalizeConfigModifiers(config);

    expect(config).toEqual(snapshot);
  });

  it("leaves every non-modifier field exactly as authored", () => {
    // Deliberately narrower than normalizeProjectConfig: running the whole
    // normalizer on save would change behavior for unrelated fields.
    const config = configWith([]);
    config.menuItems[0].name = "  Latte  ";
    config.menuItems[0].category = "  Drinks  ";

    const persisted = normalizeConfigModifiers(config);

    expect(persisted.menuItems[0].name).toBe("  Latte  ");
    expect(persisted.menuItems[0].category).toBe("  Drinks  ");
    expect(persisted.branding).toEqual(config.branding);
    expect(persisted.tax).toEqual(config.tax);
  });
});

describe("propagation: editor -> config -> build snapshot", () => {
  const authored = completeGroup();

  const config: ProjectConfig = {
    ...defaultProjectConfig,
    menuItems: [
      {
        id: "item-1",
        name: "Latte",
        price: 4,
        category: "Drinks",
        trackInventory: false,
        stockQuantity: 0,
        modifierGroups: [authored],
      },
    ],
  };

  it("survives ProjectConfig normalization on the next load", () => {
    const reloaded = normalizeProjectConfig(normalizeConfigModifiers(config));
    expect(reloaded.menuItems[0].modifierGroups).toEqual([authored]);
  });

  it("reaches GeneratedPosConfig, which is what a build snapshots", () => {
    const generated = createGeneratedPosConfig({
      projectId: "project-1",
      projectName: "Modifier Test",
      templateId: "restaurant",
      config: normalizeConfigModifiers(config),
    });

    expect(generated.menuItems[0].modifierGroups).toEqual([authored]);
  });

  it("carries the exact ids checkout depends on all the way through", () => {
    const generated = createGeneratedPosConfig({
      projectId: "project-1",
      projectName: "Modifier Test",
      templateId: "restaurant",
      config: normalizeConfigModifiers(config),
    });

    const group = generated.menuItems[0].modifierGroups?.[0];
    expect(group?.id).toBe("group-1");
    expect(group?.options.map((option) => option.id)).toEqual([
      "option-1",
      "option-2",
    ]);
  });

  it("introduces no second storage model — it is one field on the menu item", () => {
    const persisted = normalizeConfigModifiers(config);
    expect(persisted.menuItems[0].modifierGroups).toBeDefined();
    // No sibling collection anywhere on the config.
    expect(Object.keys(persisted)).not.toContain("modifierGroups");
    expect(Object.keys(persisted)).not.toContain("modifiers");
  });
});

describe("backward compatibility", () => {
  it("an item with no modifierGroups key at all reads as empty", () => {
    const item = {
      id: "item-1",
      name: "Espresso",
      price: 3,
      category: "Drinks",
      trackInventory: false,
      stockQuantity: 0,
    } as MenuItem;

    expect(normalizeModifierGroups(item.modifierGroups)).toEqual([]);
  });

  it("an item with an empty array reads as empty", () => {
    expect(normalizeModifierGroups([])).toEqual([]);
  });

  it("both cases are indistinguishable to the editor", () => {
    // Which is what lets the "No modifiers" empty state have no special case.
    expect(normalizeModifierGroups(undefined)).toEqual(normalizeModifierGroups([]));
  });

  it("a legacy config survives the save boundary unchanged", () => {
    const legacy: ProjectConfig = {
      ...defaultProjectConfig,
      menuItems: [
        {
          id: "item-1",
          name: "Espresso",
          price: 3,
          category: "Drinks",
          trackInventory: false,
          stockQuantity: 0,
        } as MenuItem,
      ],
    };

    const persisted = normalizeConfigModifiers(legacy);

    expect(persisted.menuItems[0].modifierGroups).toEqual([]);
    expect(persisted.menuItems[0].name).toBe("Espresso");
    expect(persisted.menuItems[0].price).toBe(3);
  });

  it("the default project config ships no modifiers", () => {
    for (const item of defaultProjectConfig.menuItems) {
      expect(normalizeModifierGroups(item.modifierGroups)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Feature 18.2 Phase 5B — the authoring render boundary
//
// REGRESSION SUITE for a defect found in Phase 4 manual validation: clicking
// "Add modifier group" appeared to do nothing, and Save then failed naming items
// whose groups the owner could not see.
//
// ROOT CAUSE: EditorPropertiesPanel rendered the editor with
// normalizeModifierGroups(...) — the PERSISTENCE authority, whose job is to
// delete anything not sellable. A new group is unnamed with one unnamed option,
// so it reached the draft and was deleted on the way back to the screen.
//
// `renderBoundary` below is the exact round trip the Builder performs:
//   draft --(what the panel passes)--> editor --(onChange)--> draft
// Modelling it here is what makes these real regression tests rather than unit
// tests of a function in isolation.
// ---------------------------------------------------------------------------

/** Exactly what EditorPropertiesPanel now hands ModifierGroupsEditor. */
function renderBoundary(draft: ModifierGroup[] | undefined): ModifierGroup[] {
  return toEditableModifierGroups(draft);
}

describe("the authoring render boundary preserves the draft", () => {
  it("a new group survives the round trip and is immediately visible", () => {
    // THE REPORTED BUG. Under the old wiring this rendered [] and the owner saw
    // nothing happen.
    const draft = addModifierGroup(renderBoundary([]), () => "g1");
    const rendered = renderBoundary(draft);

    expect(rendered).toHaveLength(1);
    expect(rendered[0].id).toBe("g1");
    expect(rendered[0].name).toBe("");
    expect(rendered[0].options).toHaveLength(1);
  });

  it("three clicks produce three groups, not one", () => {
    // Under the old wiring each click was computed from an empty rendered list,
    // so each new blank group REPLACED the previous invisible one — which is why
    // manual testing produced exactly one hidden group per item.
    let draft: ModifierGroup[] = [];

    for (const id of ["g1", "g2", "g3"]) {
      draft = addModifierGroup(renderBoundary(draft), () => id);
    }

    expect(renderBoundary(draft).map((group) => group.id)).toEqual(["g1", "g2", "g3"]);
  });

  it("the owner can name the group, edit the seeded option, and add another", () => {
    // The full authoring gesture sequence from requirement 4, each step passing
    // through the render boundary as the real editor does.
    let draft = addModifierGroup(renderBoundary([]), sequentialIds("g"));

    draft = updateModifierGroup(renderBoundary(draft), "g-1", { name: "Size" });
    expect(renderBoundary(draft)[0].name).toBe("Size");

    draft = updateModifierOption(renderBoundary(draft), "g-1", "g-2", {
      name: "Small",
      priceAdjustment: 0,
    });
    expect(renderBoundary(draft)[0].options[0].name).toBe("Small");

    draft = addModifierOption(renderBoundary(draft), "g-1", () => "opt-2");
    expect(renderBoundary(draft)[0].options).toHaveLength(2);

    draft = updateModifierOption(renderBoundary(draft), "g-1", "opt-2", {
      name: "Large",
      priceAdjustment: 1.5,
    });

    // Complete: it now saves cleanly.
    expect(renderBoundary(draft)[0].options.map((o) => o.name)).toEqual(["Small", "Large"]);
    expect(isModifierGroupLossy(renderBoundary(draft)[0])).toBe(false);
  });

  it("an incomplete group stays visible until completed or deleted", () => {
    let draft = addModifierGroup(renderBoundary([]), () => "g1");

    // Still visible after unrelated edits elsewhere in the item.
    draft = addModifierGroup(renderBoundary(draft), () => "g2");
    draft = updateModifierGroup(renderBoundary(draft), "g2", { name: "Milk" });
    expect(renderBoundary(draft).map((g) => g.id)).toEqual(["g1", "g2"]);

    // Deleting is the owner's explicit act, and it works.
    draft = removeModifierGroup(renderBoundary(draft), "g1");
    expect(renderBoundary(draft).map((g) => g.id)).toEqual(["g2"]);
  });

  it("clearing a group's name no longer makes it and its options disappear", () => {
    // Previously this vanished from the UI, and the next edit — computed from a
    // list that no longer contained it — destroyed the options outright.
    const draft = updateModifierGroup(renderBoundary([completeGroup()]), "group-1", {
      name: "",
    });

    const rendered = renderBoundary(draft);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].options).toHaveLength(2);

    // And retyping a name restores a saveable group with its options intact.
    const renamed = updateModifierGroup(rendered, "group-1", { name: "Size" });
    expect(isModifierGroupLossy(renamed[0])).toBe(false);
    expect(renamed[0].options.map((o) => o.name)).toEqual(["Small", "Large"]);
  });

  it("does not rewrite a typed Max Selections", () => {
    // getModifierGroupNotice promises to say what the SAVE will do to a value the
    // draft still holds. Normalizing at render made that promise false.
    const group = completeGroup({ selection: "multiple", maxSelections: 9 });

    expect(renderBoundary([group])[0].maxSelections).toBe(9);
    expect(getModifierGroupNotice(renderBoundary([group])[0])).toContain("maximum of 2");
  });

  it("does not trim names while the owner is typing", () => {
    const draft = updateModifierOption(
      renderBoundary([completeGroup()]),
      "group-1",
      "option-1",
      { name: "Extra " }
    );

    expect(renderBoundary(draft)[0].options[0].name).toBe("Extra ");
  });

  it("renders an existing valid group completely unchanged", () => {
    const groups = [completeGroup(), completeGroup({ id: "group-2", name: "Milk" })];
    expect(renderBoundary(groups)).toEqual(groups);
    expect(renderBoundary(groups)[0]).toBe(groups[0]);
  });

  it("maps a missing or legacy modifierGroups safely to []", () => {
    for (const absent of [undefined, null, "nope", 0, {}]) {
      expect(renderBoundary(absent as never)).toEqual([]);
    }
  });

  it("is NOT the persistence normalizer: it drops nothing", () => {
    // The distinction this whole fix rests on. Same input, two boundaries, two
    // deliberately different answers.
    const incomplete = [createModifierGroup(sequentialIds())];

    expect(renderBoundary(incomplete)).toHaveLength(1);
    expect(normalizeModifierGroups(incomplete)).toHaveLength(0);
  });
});

describe("the save blocker still governs the visible draft", () => {
  function configFor(groups: ModifierGroup[]): ProjectConfig {
    return {
      ...defaultProjectConfig,
      menuItems: [
        {
          id: "item-1",
          name: "Latte",
          price: 3,
          category: "Drinks",
          trackInventory: false,
          stockQuantity: 0,
          modifierGroups: groups,
        } as MenuItem,
      ],
    };
  }

  it("blocks while an incomplete group is on screen", () => {
    const draft = addModifierGroup(renderBoundary([]), sequentialIds("g"));

    // Visible AND blocking — the pair that was broken before: it blocked while
    // being invisible, which is what made the message unactionable.
    expect(renderBoundary(draft)).toHaveLength(1);
    expect(getModifierSaveBlockerMessage(configFor(draft))).toContain("Latte");
  });

  it("allows the save once the owner completes it", () => {
    let draft = addModifierGroup(renderBoundary([]), sequentialIds("g"));
    draft = updateModifierGroup(renderBoundary(draft), "g-1", { name: "Size" });
    draft = updateModifierOption(renderBoundary(draft), "g-1", "g-2", { name: "Large" });

    expect(getModifierSaveBlockerMessage(configFor(draft))).toBeNull();
  });

  it("allows the save once the owner deletes it", () => {
    let draft = addModifierGroup(renderBoundary([completeGroup()]), () => "blank");
    expect(getModifierSaveBlockerMessage(configFor(draft))).not.toBeNull();

    draft = removeModifierGroup(renderBoundary(draft), "blank");

    expect(getModifierSaveBlockerMessage(configFor(draft))).toBeNull();
    expect(renderBoundary(draft)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Feature 18.2 Phase 5A — the per-ITEM selection ceiling
// ---------------------------------------------------------------------------

/** A multiple-choice group with `count` named options and no explicit maximum. */
function unlimitedGroup(id: string, count: number): ModifierGroup {
  return {
    id,
    name: `Group ${id}`,
    selection: "multiple",
    required: false,
    maxSelections: null,
    options: Array.from({ length: count }, (_, i) => ({
      id: `${id}-option-${i}`,
      name: `Option ${i}`,
      priceAdjustment: 0,
    })),
  };
}

describe("the per-item selection ceiling", () => {
  it("counts a single-choice group as exactly one", () => {
    expect(getMaxSelectableOptions([completeGroup()])).toBe(1);
  });

  it("counts a multiple-choice group by its explicit maximum when it has one", () => {
    expect(
      getMaxSelectableOptions([{ ...unlimitedGroup("g1", 20), maxSelections: 3 }])
    ).toBe(3);
  });

  it("counts a multiple-choice group by its option count when it has no maximum", () => {
    expect(getMaxSelectableOptions([unlimitedGroup("g1", 20)])).toBe(20);
  });

  it("stays silent for a realistic menu", () => {
    // A size choice plus fifteen toppings — the shape the caps were sized for.
    const groups = [completeGroup(), unlimitedGroup("toppings", 15)];

    expect(getMaxSelectableOptions(groups)).toBe(16);
    expect(getItemSelectionCapacityNotice(groups)).toBeNull();
  });

  it("says nothing at exactly the ceiling", () => {
    // Boundary: 50 is allowed, so a notice here would be a false alarm.
    const groups = [unlimitedGroup("a", 20), unlimitedGroup("b", 20), unlimitedGroup("c", 10)];

    expect(getMaxSelectableOptions(groups)).toBe(MAX_SELECTED_OPTIONS_PER_LINE);
    expect(getItemSelectionCapacityNotice(groups)).toBeNull();
  });

  it("warns one option past the ceiling, naming both numbers", () => {
    const groups = [unlimitedGroup("a", 20), unlimitedGroup("b", 20), unlimitedGroup("c", 11)];
    const notice = getItemSelectionCapacityNotice(groups);

    expect(notice).toContain("51");
    expect(notice).toContain(String(MAX_SELECTED_OPTIONS_PER_LINE));
    expect(notice).toContain("Max Selections");
  });

  it("warns about the worst case the editor's own caps permit", () => {
    // 10 groups x 20 options — the exact mismatch the Phase 4 review flagged.
    const groups = Array.from({ length: MAX_MODIFIER_GROUPS_PER_ITEM }, (_, i) =>
      unlimitedGroup(`g${i}`, MAX_OPTIONS_PER_GROUP)
    );

    expect(getMaxSelectableOptions(groups)).toBe(200);
    expect(getItemSelectionCapacityNotice(groups)).not.toBeNull();
  });

  it("clears once the owner sets maximums that fit", () => {
    // The documented fix actually works: this is the whole point of naming
    // Max Selections in the notice.
    const groups = Array.from({ length: MAX_MODIFIER_GROUPS_PER_ITEM }, (_, i) => ({
      ...unlimitedGroup(`g${i}`, MAX_OPTIONS_PER_GROUP),
      maxSelections: 5,
    }));

    expect(getMaxSelectableOptions(groups)).toBe(50);
    expect(getItemSelectionCapacityNotice(groups)).toBeNull();
  });

  it("a selection at the ceiling still validates, and one past it does not", () => {
    // The notice is advisory; validateModifierSelections is what actually stops
    // an over-ceiling line, and the two must agree on where the line is.
    const groups = [unlimitedGroup("a", 20), unlimitedGroup("b", 20), unlimitedGroup("c", 11)];

    const atCeiling = [
      { groupId: "a", optionIds: groups[0].options.slice(0, 20).map((o) => o.id) },
      { groupId: "b", optionIds: groups[1].options.slice(0, 20).map((o) => o.id) },
      { groupId: "c", optionIds: groups[2].options.slice(0, 10).map((o) => o.id) },
    ];

    expect(validateModifierSelections(groups, atCeiling).ok).toBe(true);

    const overCeiling = [
      ...atCeiling.slice(0, 2),
      { groupId: "c", optionIds: groups[2].options.slice(0, 11).map((o) => o.id) },
    ];

    const result = validateModifierSelections(groups, overCeiling);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("too_many_options");
  });
});

// ---------------------------------------------------------------------------
// Feature 18.2 Phase 5A — the blocking save boundary
// ---------------------------------------------------------------------------

function configWith(groupsByItem: Record<string, ModifierGroup[]>): ProjectConfig {
  return {
    ...defaultProjectConfig,
    menuItems: Object.entries(groupsByItem).map(
      ([name, modifierGroups], index) =>
        ({
          id: `item-${index + 1}`,
          name,
          price: 3,
          category: "Drinks",
          trackInventory: false,
          stockQuantity: 0,
          modifierGroups,
        }) as MenuItem
    ),
  };
}

describe("a lossy group blocks the save instead of vanishing", () => {
  it("an unnamed group is lossy", () => {
    expect(isModifierGroupLossy(completeGroup({ name: "" }))).toBe(true);
  });

  it("a group with an unnamed option is lossy", () => {
    const group = completeGroup({
      options: [
        { id: "option-1", name: "Small", priceAdjustment: 0 },
        { id: "option-2", name: "", priceAdjustment: 0 },
      ],
    });

    expect(isModifierGroupLossy(group)).toBe(true);
  });

  it("a freshly added group is lossy from the moment it appears", () => {
    // createModifierGroup seeds an unnamed group with one unnamed option, which
    // is precisely the half-created state Phase 4 used to discard on save.
    const [group] = addModifierGroup([], sequentialIds());
    expect(isModifierGroupLossy(group)).toBe(true);
  });

  it("a complete group is not lossy", () => {
    expect(isModifierGroupLossy(completeGroup())).toBe(false);
  });

  it("a clamped maxSelections is NOT lossy — it saves as it always did", () => {
    // Clamping 9 to 2 changes no behavior; getModifierGroupNotice explains it,
    // and blocking a save over it would be obstruction rather than protection.
    const group = completeGroup({ selection: "multiple", maxSelections: 9 });

    expect(isModifierGroupLossy(group)).toBe(false);
    expect(getModifierGroupNotice(group)).toContain("maximum of 2");
    expect(getModifierSaveBlockerMessage(configWith({ Espresso: [group] }))).toBeNull();
  });

  it("a clean project saves", () => {
    expect(getModifierSaveBlockerMessage(configWith({ Espresso: [completeGroup()] }))).toBeNull();
  });

  it("a project with no modifiers anywhere saves", () => {
    expect(getModifierSaveBlockerMessage(configWith({ Espresso: [] }))).toBeNull();
  });

  it("a legacy item with no modifierGroups key at all saves", () => {
    // Every project written before Feature 18.1. It must never be blocked.
    const legacy: ProjectConfig = {
      ...defaultProjectConfig,
      menuItems: [
        {
          id: "item-1",
          name: "Espresso",
          price: 3,
          category: "Drinks",
          trackInventory: false,
          stockQuantity: 0,
        } as MenuItem,
      ],
    };

    expect(getModifierSaveBlockerMessage(legacy)).toBeNull();
    expect(findItemsWithUnsaveableModifiers(legacy)).toEqual([]);
  });

  it("names the one item holding the incomplete group", () => {
    const config = configWith({
      Espresso: [completeGroup()],
      Latte: [completeGroup({ name: "" })],
    });

    const message = getModifierSaveBlockerMessage(config);

    expect(message).toContain("Latte");
    expect(message).not.toContain("Espresso");
    expect(message).toMatch(/delete/i);
  });

  it("names every affected item when there is more than one", () => {
    const config = configWith({
      Latte: [completeGroup({ name: "" })],
      Mocha: [completeGroup({ id: "group-2", options: [] })],
    });

    const message = getModifierSaveBlockerMessage(config);

    expect(message).toContain("2 items");
    expect(message).toContain("Latte");
    expect(message).toContain("Mocha");
  });

  it("falls back to a placeholder for an unnamed item", () => {
    expect(getModifierSaveBlockerMessage(configWith({ "  ": [completeGroup({ name: "" })] }))).toContain(
      "Untitled item"
    );
  });

  it("catches a duplicate group id, which would silently drop the later group", () => {
    const config = configWith({
      Espresso: [completeGroup(), completeGroup({ name: "Size again" })],
    });

    expect(getModifierSaveBlockerMessage(config)).not.toBeNull();
  });

  it("blocking and normalizing agree: nothing is lost once the save is allowed", () => {
    // The invariant that makes this safe. If the blocker says a config is fine,
    // then normalizeConfigModifiers must not drop a group or an option from it.
    const config = configWith({
      Espresso: [completeGroup()],
      Latte: [completeGroup({ id: "group-2", selection: "multiple", maxSelections: 9 })],
    });

    expect(getModifierSaveBlockerMessage(config)).toBeNull();

    const persisted = normalizeConfigModifiers(config);

    for (const [index, item] of config.menuItems.entries()) {
      const saved = persisted.menuItems[index].modifierGroups ?? [];
      expect(saved).toHaveLength((item.modifierGroups ?? []).length);
      for (const [g, group] of (item.modifierGroups ?? []).entries()) {
        expect(saved[g].options).toHaveLength(group.options.length);
      }
    }
  });
});

describe("createModifierOption / createModifierGroup shapes", () => {
  it("a new option is free and unnamed", () => {
    expect(createModifierOption(sequentialIds())).toEqual({
      id: "id-1",
      name: "",
      priceAdjustment: 0,
    });
  });

  it("a new group is single-choice and optional", () => {
    const group = createModifierGroup(sequentialIds());
    expect(group.selection).toBe("single");
    expect(group.required).toBe(false);
    expect(group.maxSelections).toBeNull();
  });
});
