// Batch A (PRINT-1) — static guards on the overlay print correction.
//
// What these pin: printing from inside the device overlay (Sales-history
// reprint, Cash Drop slips) produces ONE complete copy. The behaviour was
// reproduced and verified in Chromium print-to-PDF at 80 x 297 mm against the
// built stylesheet (evidence: pos-canvas-localfirst-analysis/evidence/printing);
// these guards keep the rules and the class they depend on from drifting.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** The `@media print { … }` block of globals.css, comments stripped. */
function printBlock(): string {
  const css = read("app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const start = css.indexOf("@media print {");

  expect(start, "@media print block not found").toBeGreaterThan(-1);

  let depth = 0;

  for (let i = css.indexOf("{", start); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    if (depth === 0) return css.slice(start, i + 1);
  }

  throw new Error("unterminated @media print block");
}

const squash = (s: string) => s.replace(/\s+/g, " ");

describe("overlay printing prints one complete copy", () => {
  const block = squash(printBlock());

  it("a suppressed print area leaves layout (display:none), for both exclusivity levels", () => {
    expect(block).toContain(
      "body:has(.receipt-print-area[data-print-exclusive]) .receipt-print-area:not([data-print-exclusive]) { display: none; }"
    );
    expect(block).toContain(
      'body:has(.receipt-print-area[data-print-exclusive="cash-movement"]) .receipt-print-area:not([data-print-exclusive="cash-movement"]) { display: none; }'
    );
  });

  it("the fixed overlay hosting the exclusive area is laid out in flow for print, unclipped", () => {
    expect(block).toMatch(
      /\.fixed:has\(\.receipt-print-area\[data-print-exclusive\]\) \{ position: absolute; inset: 0 auto auto 0; width: 100%; height: auto; overflow: visible; \}/
    );
  });

  it("the overlay's screen-only content is removed from print layout; ancestors of the area collapse", () => {
    expect(block).toContain(
      ".fixed:has(.receipt-print-area[data-print-exclusive]) *:not(:has(.receipt-print-area)):not(.receipt-print-area):not(.receipt-print-area *) { display: none; }"
    );
    expect(block).toMatch(
      /\.fixed:has\(\.receipt-print-area\[data-print-exclusive\]\) \*:has\(\.receipt-print-area\) \{ min-height: 0; height: auto; padding: 0; border: 0; \}/
    );
  });

  it("the device overlay still carries the `fixed` class these rules select on", () => {
    expect(read("components/device/DeviceApp.tsx")).toContain(
      '<div className="fixed inset-0 z-30 overflow-y-auto bg-neutral-50">{activeOverlay}</div>'
    );
  });

  it("both overlay print surfaces still claim exclusivity", () => {
    expect(read("components/runtime/SalesHistoryDetail.tsx")).toContain('<div className="receipt-print-area" data-print-exclusive>');
    expect(read("components/device/PosGates.tsx")).toContain('data-print-exclusive="cash-movement"');
  });

  it("no print path gained a second dispatch: each surface calls window.print() exactly once", () => {
    const count = (file: string) => (read(file).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").match(/window\.print\(\)/g) ?? []).length;

    expect(count("components/runtime/PosCheckoutPanel.tsx")).toBe(1);
    expect(count("components/runtime/SalesHistoryDetail.tsx")).toBe(1);
    expect(count("components/device/PosGates.tsx")).toBe(1);
  });
});
