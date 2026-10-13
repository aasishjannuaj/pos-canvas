// v1.3 D-1 — the price refusal must stay wired where it was put.
//
// The pure rule is tested in menuItemPricing.test.ts. These assert that the
// editor actually CONSULTS it, because a correct rule nothing calls is exactly
// the state this defect was found in: the price input already carried min="0",
// and nothing read the verdict.
import { readFileSync } from "node:fs";
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

const SHELL = "components/editor/EditorShell.tsx";
const PANEL = "components/editor/EditorPropertiesPanel.tsx";

describe("the save boundary refuses an invalid price", () => {
  const shell = code(read(SHELL));

  it("asks the pure rule, on the config being saved", () => {
    expect(shell).toContain("getPriceSaveBlockerMessage(projectConfig)");
    expect(shell).toContain("if (priceSaveBlocker !== null)");
  });

  it("uses the same refusal mechanism as the modifier and empty-name checks", () => {
    // Not a new blocking concept: the same setSaveStatus("error") + setSaveError
    // pair the editor has always used, so the message surfaces where owners
    // already look for save failures.
    const at = shell.indexOf("priceSaveBlocker !== null");
    const block = shell.slice(at, at + 200);

    expect(block).toContain('setSaveStatus("error")');
    expect(block).toContain("setSaveError(priceSaveBlocker)");
    expect(block).toContain("return;");
  });

  it("refuses BEFORE anything is persisted", () => {
    // The check must sit above the network call, or it would be reporting on a
    // save that already happened.
    const blocker = shell.indexOf("priceSaveBlocker");
    const persists = shell.indexOf("setSaveStatus(\"saving\")");

    expect(blocker).toBeGreaterThan(-1);
    expect(persists).toBeGreaterThan(-1);
    expect(blocker).toBeLessThan(persists);
  });

  it("does not silently rewrite the price instead", () => {
    // A clamp would change a number the owner typed without telling them. The
    // fix is a refusal, so no clamping of item price may appear in the editor.
    expect(shell).not.toContain("Math.max(0, price)");
    expect(shell).not.toContain("Math.abs(price)");
  });
});

describe("the owner is told at the field, not only at the Save button", () => {
  const panel = code(read(PANEL));

  it("shows an inline message on the price field", () => {
    expect(panel).toContain("isValidMenuItemPrice(selectedItem.price)");
    expect(panel).toContain("Price cannot be negative. Enter 0 or more.");
  });

  it("keeps min=\"0\" as the browser hint it is", () => {
    // Retained deliberately: it drives the stepper and the native constraint.
    // It is not the enforcement, which is why this fix exists.
    expect(panel).toContain('min="0"');
  });

  it("still renders the value the owner typed, un-rewritten", () => {
    expect(panel).toContain("value={selectedItem.price}");
  });
});
