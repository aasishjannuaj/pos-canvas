// v1.3 Feature 1E-A — the lines the barcode foundation must not cross.
//
// THREE THINGS THIS FEATURE IS NOT, and each would be an easy accident:
//
// 1. IT IS NOT A SCANNER ENGINE. There is no global key listener, no buffer, no
//    inter-key timing, no prefix framing and no way to tell a scanner from a
//    keyboard. A wedge scanner IS a keyboard, and the moment this repository
//    starts guessing otherwise it owns a heuristic that will misfire into an
//    Employee ID or a PIN field.
//
// 2. IT IS NOT A TEMPLATE FEATURE. The capability belongs to the PROJECT. If
//    `templateId` ever decided whether barcodes work, the capability could not
//    be turned on for a convenience store or off for a liquor store without a
//    scanner.
//
// 3. IT IS NOT A SEARCH FIELD. Lane 2 already owns the one Search/Scan input.
//    A second one built here would be a competing implementation, which is the
//    single outcome the cross-lane reconciliation exists to prevent.
//
// These guards read CODE, not prose: the comments above deliberately name the
// things that must not happen, and a scan that matched its own explanation
// would pass while the code did the opposite.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** Source with comments removed: these guards are about code, not prose. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const BARCODE = "lib/barcode.ts";
const FEATURES = "lib/projectFeatures.ts";
const ACTIVATION = "lib/itemActivation.ts";
const GENERATED = "lib/generatedPosConfig.ts";
const PROJECT_CONFIG = "lib/projectConfig.ts";
const POS_RUNTIME = "components/runtime/PosRuntime.tsx";
const DEVICE_APP = "components/device/DeviceApp.tsx";
const PANEL = "components/editor/EditorPropertiesPanel.tsx";

const NEW_MODULES = [BARCODE, FEATURES, ACTIVATION];

const walk = (dir: string): string[] => {
  const out: string[] = [];

  for (const entry of readdirSync(join(repoRoot, dir))) {
    const child = join(dir, entry);

    if (statSync(join(repoRoot, child)).isDirectory()) out.push(...walk(child));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(child);
  }

  return out;
};

// ---------------------------------------------------------------------------
// No scanner engine
// ---------------------------------------------------------------------------

describe("nothing here is a scanner engine", () => {
  it("the new modules register no listener and touch no DOM", () => {
    for (const file of NEW_MODULES) {
      const source = stripComments(read(file));

      for (const banned of [
        "addEventListener",
        "document",
        "window",
        "KeyboardEvent",
        "keydown",
        "keypress",
        "keyup",
        "setTimeout",
        "setInterval",
        "performance.now",
        "Date.now",
      ]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("no scanner-source, timing or framing vocabulary exists anywhere in the feature", () => {
    for (const file of [...NEW_MODULES, GENERATED, PROJECT_CONFIG, PANEL]) {
      const source = stripComments(read(file));

      for (const banned of ["wedge", "prefix", "terminator", "interKey", "scanBuffer", "isScanner"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  // NEGATIVE CONTROL ON THE HOST. 1E-A adds no capture anywhere, so the device
  // host must be untouched by it — this is what keeps the obsolete "DeviceApp
  // scanner listener" design from creeping back in.
  it("the device host learned nothing about barcodes", () => {
    const source = stripComments(read(DEVICE_APP));

    for (const banned of ["barcode", "Barcode", "scan", "Scan"]) {
      expect(`${DEVICE_APP}: ${banned}`).toBe(`${DEVICE_APP}: ${banned}`);
      expect(source).not.toContain(banned);
    }
  });

  it("the runtime still has exactly one listener, and it is beforeunload", () => {
    const runtime = stripComments(read(POS_RUNTIME));

    expect(runtime.match(/addEventListener\((["'])(\w+)\1/g) ?? []).toEqual([
      'addEventListener("beforeunload"',
    ]);

    for (const banned of ["keydown", "keypress", "keyup", "document.addEventListener", ".focus()"]) {
      expect(`${POS_RUNTIME}: ${banned}`).toBe(`${POS_RUNTIME}: ${banned}`);
      expect(runtime).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// The capability belongs to the project
// ---------------------------------------------------------------------------

describe("barcode is a project capability, never a template one", () => {
  it("no feature module mentions a template id", () => {
    for (const file of [...NEW_MODULES, PROJECT_CONFIG]) {
      const source = stripComments(read(file));

      for (const banned of ["templateId", "liquor", "liquor-store", "LIQUOR"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("the capability is read through one accessor, not scattered booleans", () => {
    const features = read(FEATURES);

    expect(features).toContain("export function isBarcodeScanningEnabled");
    expect(features).toContain("features?.barcodeScanning?.enabled !== false");

    // The names a scattered implementation would have produced.
    for (const file of walk("lib").concat(walk("components"))) {
      const source = stripComments(read(file));

      for (const banned of ["enableBarcode", "scannerEnabled", "liquorBarcode", "barcodeEnabled"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });

  it("only barcodeScanning was added to the features model", () => {
    const source = stripComments(read(FEATURES));

    // The capabilities deliberately NOT retrofitted in this checkpoint.
    for (const banned of [
      "timeClock",
      "cashMovements",
      "employeeManagement",
      "salesReports",
      "inventory",
      "discounts",
      "tips",
      "entitlement",
      "subscription",
      "plan",
    ]) {
      expect(`${FEATURES}: ${banned}`).toBe(`${FEATURES}: ${banned}`);
      expect(source).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// One normalization, one stock rule, one search field
// ---------------------------------------------------------------------------

describe("nothing is implemented twice", () => {
  // Every caller normalizes through lib/barcode.ts. A second regex or trim
  // somewhere else is how two spellings of the same barcode come to exist.
  it("barcode normalization exists in exactly one module", () => {
    for (const file of [GENERATED, PROJECT_CONFIG, PANEL]) {
      const source = stripComments(read(file));

      expect(source).toContain("@/lib/barcode");
      expect(`${file}: local barcode regex`).toBe(`${file}: local barcode regex`);
      expect(source).not.toMatch(/x21|0x21|\\u0021/);
    }
  });

  // THE ONE STOCK DECISION. The cart's add path must go through the shared
  // predicate, not re-derive the ceiling beside it.
  it("the cart add path uses the shared activation predicate", () => {
    const runtime = stripComments(read(POS_RUNTIME));
    const addToCart = runtime.slice(
      runtime.indexOf("function addToCart"),
      runtime.indexOf("function increaseQuantity")
    );

    expect(addToCart).toContain("canActivateItem");
    // The raw predicate must no longer be called here directly.
    expect(addToCart).not.toContain("canAddItemQuantity");
  });

  // v1.3 Feature 1E-A correction — the preflight must never claim a mutation.
  it("the activation contract states no committed-mutation outcome", () => {
    const source = stripComments(read(ACTIVATION));

    expect(source).toContain('"ready"');
    expect(source).not.toContain('"added"');
    expect(source).toContain("ItemActivationDecision");
    expect(source).not.toContain("ItemActivationResult");

    // None of the machinery that would be needed to report a real mutation.
    for (const banned of ["cartRef", "mirror", "useRef", "committed", "receipt"]) {
      expect(`${ACTIVATION}: ${banned}`).toBe(`${ACTIVATION}: ${banned}`);
      expect(source).not.toContain(banned);
    }
  });

  it("the runtime add path returns void and keeps the authoritative prev check", () => {
    const runtime = stripComments(read(POS_RUNTIME));
    const addToCart = runtime.slice(
      runtime.indexOf("function addToCart"),
      runtime.indexOf("function increaseQuantity")
    );

    expect(addToCart).toContain("): void {");
    expect(addToCart).toContain("canActivateItem(menuItem, prev)");
    // NEGATIVE CONTROL: the removed prediction, in any of its shapes.
    for (const banned of ['status: "added"', "return reported", "const reported"]) {
      expect(`${POS_RUNTIME}: ${banned}`).toBe(`${POS_RUNTIME}: ${banned}`);
      expect(addToCart).not.toContain(banned);
    }
  });

  // The fail-open compatibility default is scoped to one benign capability. It
  // must not become a framework that grants money, identity or access
  // capabilities on unreadable config.
  it("fail-open is scoped to barcodeScanning and is not generalized", () => {
    const source = stripComments(read(FEATURES));

    // One accessor, naming the one capability it answers for.
    expect(source.match(/export function is\w+Enabled/g) ?? []).toEqual([
      "export function isBarcodeScanningEnabled",
    ]);
    expect(source).toContain("features?.barcodeScanning?.enabled !== false");

    // No generic resolver that would apply this default to a future capability.
    // Names a generic, default-granting feature resolver would carry. NOT a
    // blanket ban on `Record<string, unknown>`, which is the ordinary shape of
    // the plain-object type guard this module legitimately uses.
    for (const banned of [
      "isFeatureEnabled",
      "resolveFeature",
      "featureDefaults",
      "DEFAULT_FEATURES",
      "Record<string, boolean>",
      "[featureName",
      "features[",
    ]) {
      expect(`${FEATURES}: ${banned}`).toBe(`${FEATURES}: ${banned}`);
      expect(source).not.toContain(banned);
    }

    // And no coercion of truthy/falsy values into the boolean.
    for (const banned of ["Boolean(", "!!", '=== "false"', "JSON.parse"]) {
      expect(source).not.toContain(banned);
    }
  });

  it("the shared activation module owns no rule of its own", () => {
    const source = stripComments(read(ACTIVATION));

    expect(source).toContain("canAddItemQuantity");
    expect(source).toContain("getItemQuantityInCart");
    // It must use the SAME modifier decision the product path uses.
    expect(source).toContain("normalizeModifierGroups");
    expect(source).not.toContain("hasModifiers");
    // And no stock arithmetic of its own.
    expect(source).not.toMatch(/stockQuantity\s*[<>=]/);
  });

  // LANE 2 OWNS THE ONE SEARCH/SCAN FIELD. Lane 1 must not have built another.
  it("Lane 1 added no search or scan input", () => {
    for (const file of NEW_MODULES) {
      const source = stripComments(read(file));

      for (const banned of ["<input", "placeholder", "onKeyDown", "Search"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }

    // The Builder's barcode field is item DATA ENTRY, not a scan surface.
    const panel = stripComments(read(PANEL));

    expect(panel).toContain("Barcode (optional)");
    for (const banned of ["onKeyDown", "scan", "Scan"]) {
      expect(`${PANEL}: ${banned}`).toBe(`${PANEL}: ${banned}`);
      expect(panel).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Config safety
// ---------------------------------------------------------------------------

describe("the config pipeline keeps its promises", () => {
  it("the generated boundary explicitly carries the barcode", () => {
    const source = stripComments(read(GENERATED));

    expect(source).toContain("runtimeSafe.barcode = barcode");
    // Attached conditionally, so an absent barcode leaves no key behind.
    expect(source).toContain("if (barcode !== undefined)");
  });

  it("duplicates are refused at generation, not resolved", () => {
    const source = stripComments(read(GENERATED));

    expect(source).toContain("findDuplicateBarcode");
    expect(source).toContain("throw new Error");

    for (const banned of ["firstWins", "lastWins", "dedupe", ".pop()", ".shift()"]) {
      expect(source).not.toContain(banned);
    }
  });

  it("features are carried only when the project configured them", () => {
    const source = stripComments(read(GENERATED));

    expect(source).toContain("if (normalizedConfig.features !== undefined)");
    expect(source).toContain("generated.features = normalizedConfig.features");
  });

  // NEGATIVE CONTROL: no SQL migration belongs to this feature.
  it("no migration was created for barcode", () => {
    const migrations = readdirSync(join(repoRoot, "supabase/migrations")).filter((f) =>
      f.endsWith(".sql")
    );

    expect(migrations).toHaveLength(32);

    for (const file of migrations) {
      const sql = read(join("supabase/migrations", file))
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .replace(/'(?:[^']|'')*'/g, "''");

      expect(`${file}: barcode`).toBe(`${file}: barcode`);
      expect(sql.toLowerCase()).not.toContain("barcode");
    }
  });
});
