// Feature 18.2 Phase 4 — static guards for owner modifier authoring.
//
// Source-level assertions, following this repository's existing guard
// convention. Two properties here are genuinely structural and cannot be caught
// by a behavioral test:
//
//   1. ROLLOUT SAFETY. complete_sale_v2 now fails closed on any product that
//      carries modifiers. Exposing authoring while ANY checkout host still
//      called v2 would let an owner author a group that makes their own product
//      unsellable on that surface. The ordering that makes Phase 4 safe is
//      "every host already calls v3", and only a source guard can hold it.
//   2. SINGLE VALIDATION AUTHORITY. The editor must call
//      normalizeModifierGroups rather than restate its rules, or the editor and
//      checkout will eventually disagree about what a sellable group is.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

/** Strips comments so explanatory prose never trips a guard. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Every non-test .ts/.tsx file the app ships, recursively. */
function sourceFiles(relativeDir: string): string[] {
  return readdirSync(join(repoRoot, relativeDir)).flatMap((entry) => {
    const relative = join(relativeDir, entry);
    if (statSync(join(repoRoot, relative)).isDirectory()) {
      return sourceFiles(relative);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [relative] : [];
  });
}

const ALL_APP_SOURCES = [
  ...sourceFiles("lib"),
  ...sourceFiles("components"),
  ...sourceFiles("app"),
];

const AUTHORING_LIB = "lib/modifierAuthoring.ts";
const EDITOR = "components/editor/ModifierGroupsEditor.tsx";
const PANEL = "components/editor/EditorPropertiesPanel.tsx";
const SHELL = "components/editor/EditorShell.tsx";

/**
 * The components that CHOOSE which checkout function to call.
 *
 * Deliberately the hosts, not lib/orders.ts and lib/device.rpc.ts: those are
 * transport modules that still DEFINE a v2 wrapper on purpose (Feature 18.2
 * kept them so the rollout could be reversed). What matters for safety is that
 * no host calls one, which is what these guards assert.
 */
// Feature 18.2 Phase 5A — EditorShell joins the list. Until Phase 5A the Builder
// Preview was not treated as a checkout host at all, which is precisely how it
// stayed on complete_sale v1 while the editor above it began authoring the
// modifier groups v1 cannot price or record. The full version-reachability
// invariant lives in lib/checkoutReachability.guards.test.ts; these assertions
// stay here because they are what makes shipping the AUTHORING UI safe.
const CHECKOUT_HOSTS = [
  "components/runtime/OwnerPosRuntime.tsx",
  "components/device/DeviceApp.tsx",
  "components/editor/EditorShell.tsx",
];

/** The retired entry points, and the one module each is allowed to be defined in. */
const RETIRED_V2_ENTRY_POINTS: [string, string][] = [
  // Phase 5A — v1 joins the list, now that no host calls it either.
  ["completeSaleOrder", "lib/orders.ts"],
  ["completeSaleOrderV2", "lib/orders.ts"],
  ["completeDeviceSale", "lib/device.rpc.ts"],
];

describe("rollout safety: authoring exists only because every host calls v3", () => {
  // complete_sale_v2 fails closed on a modifier-bearing product. If a host were
  // switched back to v2 while this editor still ships, an owner could author a
  // group that silently makes their own product unsellable on that surface.

  it("no checkout host calls a v1 or v2 entry point", () => {
    for (const file of CHECKOUT_HOSTS) {
      const host = code(read(file));
      expect(host).not.toContain("complete_sale_v2");
      expect(host).not.toContain("completeSaleOrderV2");
      // Word-boundary with a negative lookahead: completeSaleOrderV3 and
      // completeDeviceSaleV3 are the correct calls and must not match their
      // retired prefixes.
      expect(host).not.toMatch(/completeSaleOrder\b(?!V\d)/);
      expect(host).not.toMatch(/completeDeviceSale\b(?!V3)/);
    }
  });

  it("every checkout host calls a v3 entry point", () => {
    // Asserted per host rather than over a filtered list, so a host that stops
    // submitting sales entirely fails loudly instead of passing vacuously.
    expect(code(read("components/runtime/OwnerPosRuntime.tsx"))).toContain(
      "completeSaleOrderV3"
    );
    expect(code(read("components/device/DeviceApp.tsx"))).toContain(
      "completeDeviceSaleV3"
    );
    expect(code(read("components/editor/EditorShell.tsx"))).toContain(
      "completeSaleOrderV3"
    );
  });

  it("the Builder Preview submits through v3, like every other host", () => {
    // The Phase 4 gap: authoring shipped in the Builder while the Builder's own
    // checkout was still v1, so an owner could author a group, sell it in
    // Preview, and have the adjusted money persisted with no record of what was
    // chosen. Authoring and this checkout must stay on the same version.
    const shell = code(read(SHELL));
    expect(shell).toContain("completeSaleOrderV3({");
    expect(shell).toContain("saleRequestId: plan.request.id");
  });

  it("the retired v1/v2 wrappers are defined but called by nobody", () => {
    // This is the regression this whole block exists to prevent: authoring
    // shipping while some host has been wired back to v2, which fails closed on
    // exactly the modifier-bearing products the editor now creates.
    for (const [entryPoint, definedIn] of RETIRED_V2_ENTRY_POINTS) {
      const callers = ALL_APP_SOURCES.filter(
        (file) =>
          file !== definedIn &&
          new RegExp(`\\b${entryPoint}\\b(?!V3)`).test(code(read(file)))
      );

      expect(callers).toEqual([]);
    }
  });

  it("the device transport submits through v3", () => {
    const device = code(read("lib/device.rpc.ts"));
    expect(device).toContain('rpc("complete_sale_v3"');
  });

  it("the owner runtime host submits through v3", () => {
    const owner = code(read("components/runtime/OwnerPosRuntime.tsx"));
    expect(owner).toContain("completeSaleOrderV3");
    expect(owner).not.toContain("completeSaleOrderV2");
  });

  it("the authoring UI is reachable only from the Builder", () => {
    // A till must never be able to rewrite the menu it is selling from.
    for (const file of [
      "components/runtime/PosRuntime.tsx",
      "components/device/DeviceApp.tsx",
      "components/runtime/OwnerPosRuntime.tsx",
    ]) {
      expect(code(read(file))).not.toContain("ModifierGroupsEditor");
      expect(code(read(file))).not.toContain("@/lib/modifierAuthoring");
    }
  });

  it("only the Builder panel renders the authoring editor", () => {
    expect(code(read(PANEL))).toContain("<ModifierGroupsEditor");
    expect(code(read(EDITOR))).toContain("export default function ModifierGroupsEditor");
  });
});

describe("validation has exactly one authority", () => {
  const lib = code(read(AUTHORING_LIB));
  const editor = code(read(EDITOR));

  it("the authoring library defers to normalizeModifierGroups", () => {
    expect(lib).toContain("normalizeModifierGroups");
    expect(lib).toContain("from \"@/lib/modifiers\"");
  });

  it("the notice is computed from the normalizer, never from restated rules", () => {
    // previewNormalizedGroup runs the real normalizer over one group and reads
    // the answer; it does not re-derive "what makes a group valid".
    expect(lib).toContain("normalizeModifierGroups([group])[0]");
    expect(lib).toContain("previewNormalizedGroup(group)");
  });

  it("re-implements none of the normalizer's own checks", () => {
    // Each of these appears in lib/modifiers.ts. A copy here would be a second
    // implementation that can drift from the one checkout actually uses.
    expect(lib).not.toContain("MAX_PRICE_ADJUSTMENT");
    expect(lib).not.toContain("isPlainObject");
    expect(lib).not.toContain("isNonEmptyString");
    expect(lib).not.toMatch(/options\.length === 0/);
  });

  it("uses the shared caps rather than its own numbers", () => {
    expect(lib).toContain("MAX_MODIFIER_GROUPS_PER_ITEM");
    expect(lib).toContain("MAX_OPTIONS_PER_GROUP");
    expect(editor).toContain("MAX_MODIFIER_GROUPS_PER_ITEM");
    expect(editor).toContain("MAX_OPTIONS_PER_GROUP");
    // No hardcoded cap anywhere in either file. `length > 0` and `length > 1`
    // are emptiness/singularity checks, not caps, so they are allowed; any
    // comparison against a larger literal would be a copy of a shared constant.
    const HARDCODED_CAP = /length\s*[<>]=?\s*(?!0\b|1\b)\d+/;
    expect(lib).not.toMatch(HARDCODED_CAP);
    expect(editor).not.toMatch(HARDCODED_CAP);
  });

  it("never rounds money", () => {
    // SQL round(numeric, 2) and Math.round(x * 100) / 100 disagree at half-cent
    // boundaries; complete_sale_v3 is the authority.
    expect(lib).not.toContain("Math.round");
    expect(lib).not.toContain("toFixed");
    expect(editor).not.toContain("Math.round");
    expect(editor).not.toContain("toFixed");
  });
});

describe("the editor is presentational and owns no state", () => {
  const editor = code(read(EDITOR));

  it("holds no React state, ref or effect of its own", () => {
    // Draft modifier data lives in exactly one place: EditorShell's
    // projectConfig. A local copy here would be a second storage model.
    expect(editor).not.toContain("useState");
    expect(editor).not.toContain("useEffect");
    expect(editor).not.toContain("useRef");
  });

  it("mutates groups only through the pure operations", () => {
    for (const operation of [
      "addModifierGroup",
      "removeModifierGroup",
      "updateModifierGroup",
      "setModifierGroupSelection",
      "setModifierGroupMaxSelections",
      "addModifierOption",
      "removeModifierOption",
      "updateModifierOption",
    ]) {
      expect(editor).toContain(operation);
    }
  });

  it("never constructs a group or option literal inline", () => {
    // Inline construction would be a place for an id to be minted, or omitted.
    expect(editor).not.toMatch(/priceAdjustment:\s*\d/);
    expect(editor).not.toMatch(/selection:\s*"(single|multiple)"\s*,/);
    expect(editor).not.toContain("createModifierGroup(");
    expect(editor).not.toContain("createModifierOption(");
  });

  it("never generates an id itself, and never exposes one to the owner", () => {
    expect(editor).not.toContain("randomUUID");
    expect(editor).not.toContain("Date.now");
    // No id is rendered or editable anywhere: owners must not type ids.
    expect(editor).not.toMatch(/value=\{(group|option)\.id\}/);
    expect(editor).not.toMatch(/\{(group|option)\.id\}</);
  });

  it("touches no Supabase, server action, or storage", () => {
    for (const banned of ["supabase", "@/lib/projects", "localStorage", "fetch("]) {
      expect(editor).not.toContain(banned);
    }
  });
});

describe("authoring reuses the existing menu-item update path", () => {
  const panel = code(read(PANEL));

  it("routes changes through the same onUpdate the other item fields use", () => {
    expect(panel).toContain("onUpdate(selectedItem.id, { modifierGroups })");
  });

  it("adds no new handler prop for modifiers", () => {
    // The smallest possible insertion: no new plumbing through EditorShell.
    expect(panel).not.toContain("onModifierGroupsChange");
    expect(panel).not.toContain("onAddModifierGroup");
  });

  it("renders the editor beneath the existing item fields", () => {
    const stockIndex = panel.indexOf("Stock Quantity");
    const editorIndex = panel.indexOf("<ModifierGroupsEditor");
    expect(stockIndex).toBeGreaterThan(-1);
    expect(editorIndex).toBeGreaterThan(stockIndex);
  });

  it("renders the RAW draft, never the persistence normalizer", () => {
    // Phase 5B — this guard previously asserted the opposite and so ENFORCED the
    // defect: rendering normalizeModifierGroups(selectedItem.modifierGroups)
    // deleted every incomplete group on its way back to the screen, which is why
    // "Add modifier group" appeared to do nothing.
    expect(panel).toContain("toEditableModifierGroups(selectedItem.modifierGroups)");
    expect(panel).not.toContain("normalizeModifierGroups");
  });

  it("the authoring surface never imports the persistence normalizer at all", () => {
    // Stronger than the render-site check: no future edit may reach for it here.
    for (const file of [PANEL, EDITOR]) {
      expect(code(read(file))).not.toContain("normalizeModifierGroups");
    }
  });

  it("a legacy item with no modifierGroups key still shows the empty state", () => {
    // The one transformation toEditableModifierGroups is allowed to make.
    const lib = code(read(AUTHORING_LIB));
    expect(lib).toContain("Array.isArray(groups) ? groups : []");
  });

  it("shows 'No modifiers' when an item has none", () => {
    expect(code(read(EDITOR))).toContain("No modifiers");
  });

  it("reuses the panel's existing currency symbol rather than a second lookup", () => {
    expect(panel).toContain("currencySymbol={currencySymbol}");
  });
});

describe("the save boundary", () => {
  const shell = code(read(SHELL));

  it("normalizes modifiers on the way to the database", () => {
    expect(shell).toContain("normalizeConfigModifiers(projectConfig)");
  });

  it("uses the normalized config for both the create and the update path", () => {
    const saves = [...shell.matchAll(/config:\s*([A-Za-z]+),/g)].map((m) => m[1]);
    // Three call sites: saveNewProject, updateProject, and the export path
    // (which normalizes independently inside createGeneratedPosConfig).
    expect(saves.filter((name) => name === "configToPersist")).toHaveLength(2);
  });

  it("leaves the React draft un-normalized, so typing stays free-form", () => {
    // The draft must never be rewritten mid-keystroke; only the value sent to
    // the database is normalized.
    expect(shell).not.toContain("setProjectConfig(normalizeConfigModifiers");
    expect(shell).not.toContain("normalizeConfigModifiers(prev)");
  });

  it("does not run the whole config normalizer on save", () => {
    // That would change persistence behavior for every unrelated field, which
    // is outside this feature.
    expect(shell).not.toContain("normalizeProjectConfig(projectConfig)");
  });
});

describe("the save boundary blocks rather than discards (Phase 5A)", () => {
  const shell = code(read(SHELL));

  it("refuses the save when a modifier group would be lost", () => {
    expect(shell).toContain("getModifierSaveBlockerMessage(projectConfig)");
    expect(shell).toContain("if (modifierSaveBlocker !== null)");
  });

  it("uses the same refusal mechanism as the empty-name check", () => {
    // Deliberately not a new blocking concept: same setSaveStatus("error") +
    // setSaveError pair the editor has always used, so the message surfaces
    // through EditorTopBar with no new plumbing.
    const blocker = shell.slice(shell.indexOf("modifierSaveBlocker"));
    expect(blocker.slice(0, blocker.indexOf("configToPersist"))).toContain(
      'setSaveStatus("error")'
    );
  });

  it("refuses BEFORE anything is persisted", () => {
    // If the blocker ran after saveNewProject/updateProject it would be theatre.
    expect(shell.indexOf("modifierSaveBlocker")).toBeLessThan(
      shell.indexOf("saveNewProject({")
    );
    expect(shell.indexOf("modifierSaveBlocker")).toBeLessThan(
      shell.indexOf("updateProject({")
    );
  });

  it("still normalizes on the way out, as defense in depth", () => {
    // The blocker removes the LOSSY cases; normalizeConfigModifiers still runs
    // so the harmless ones (a clamped maximum, a trimmed id) are applied.
    expect(shell).toContain("normalizeConfigModifiers(projectConfig)");
  });

  it("the blocker reads the normalizer rather than restating its rules", () => {
    const lib = code(read(AUTHORING_LIB));
    expect(lib).toContain("previewNormalizedGroup(group)");
    expect(lib).toContain("normalizeModifierGroups(authored).length !== authored.length");
  });
});

describe("the per-item selection ceiling is visible on both surfaces (Phase 5A)", () => {
  it("the authoring editor shows the ceiling notice", () => {
    const editor = code(read(EDITOR));
    expect(editor).toContain("getItemSelectionCapacityNotice(groups)");
    expect(editor).toContain("{capacityNotice}");
  });

  it("the notice comes from the shared cap, never a literal", () => {
    const lib = code(read(AUTHORING_LIB));
    expect(lib).toContain("MAX_SELECTED_OPTIONS_PER_LINE");
    expect(lib).not.toMatch(/\b50\b/);
  });

  it("the selector explains the ceiling instead of silently disabling Add to Cart", () => {
    const selector = code(read("components/runtime/ModifierSelector.tsx"));
    expect(selector).toContain("MAX_SELECTED_OPTIONS_PER_LINE");
    expect(selector).toContain("atLineLimit");
  });

  it("the server cap is unchanged", () => {
    // Phase 5A deliberately did NOT move the SQL bound: the client was made to
    // explain the existing limit, not to negotiate a new one.
    const migration = read(
      "supabase/migrations/20260810120000_modifier_contract_and_complete_sale_v3.sql"
    );
    expect(migration).toContain("c_max_mod_selected constant integer := 50");
    expect(code(read("lib/modifiers.ts"))).toContain(
      "export const MAX_SELECTED_OPTIONS_PER_LINE = 50"
    );
  });
});

describe("preview integration reuses the Phase 2 selector", () => {
  const layouts = code(read("components/editor/pos-layouts/index.tsx"));

  it("the Builder preview and the runtime share one product browser", () => {
    expect(code(read("components/editor/EditorPreview.tsx"))).toContain(
      'from "./pos-layouts"'
    );
    expect(code(read("components/runtime/PosRuntime.tsx"))).toContain(
      '@/components/editor/pos-layouts'
    );
  });

  it("that shared browser opens the Phase 2 ModifierSelector", () => {
    expect(layouts).toContain("@/components/runtime/ModifierSelector");
    expect(layouts).toContain("<ModifierSelector");
  });

  it("it reads the item's own groups, so the preview follows the live draft", () => {
    // No copy, no snapshot: the preview renders whatever projectConfig holds
    // right now, which is what makes an edit visible immediately.
    expect(layouts).toContain("normalizeModifierGroups(menuItem.modifierGroups)");
  });

  it("Phase 4 added no second preview path", () => {
    expect(code(read(EDITOR))).not.toContain("ModifierSelector");
    expect(code(read(PANEL))).not.toContain("ModifierSelector");
  });
});

describe("templates are untouched", () => {
  it("no template ships a modifier group", () => {
    const templates = read("data/templates.ts");
    expect(templates).not.toContain("modifierGroups");
  });

  it("the default project config ships no modifier group", () => {
    expect(code(read("lib/projectConfig.ts"))).not.toMatch(
      /defaultProjectConfig[\s\S]*?modifierGroups:\s*\[\s*\{/
    );
  });
});

describe("negative price adjustments stay out of scope", () => {
  it("the price input refuses negatives at the boundary", () => {
    expect(code(read(EDITOR))).toContain('min="0"');
  });

  it("the operation floors at zero as a second line of defense", () => {
    expect(code(read(AUTHORING_LIB))).toContain("Math.max(0,");
  });

  it("no discount vocabulary leaked into the editor", () => {
    const editor = code(read(EDITOR));
    expect(editor).not.toMatch(/discount/i);
    expect(editor).not.toContain('min="-');
  });
});
