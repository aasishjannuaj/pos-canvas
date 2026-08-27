// Feature 25.5 — ONE receipt per print job.
//
// The print mechanism reveals `.receipt-print-area` AMBIENTLY: every element
// carrying the class becomes visible, and every one is positioned absolutely at
// the same origin. Two of them do not print as two pages — they overprint into
// one illegible slip. EditorPreview's comment has always stated the invariant
// that keeps that safe ("at most one print area ever exists"), and nothing
// enforced it.
//
// Feature 25.3 broke it without touching the stylesheet: Sales history became an
// overlay above a STILL-MOUNTED PosRuntime, so a cashier holding a completed
// receipt who opens history and reprints an older order has two print areas in
// the document. These guards pin the rule that resolves it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CSS = "app/globals.css";
const DETAIL = "components/runtime/SalesHistoryDetail.tsx";
const RUNTIME = "components/runtime/PosRuntime.tsx";
const PREVIEW = "components/editor/EditorPreview.tsx";

/**
 * Every component that renders a purchased line onto paper.
 *
 * ALL THREE, not just the one the reprint uses. Receipt.tsx renders the
 * historical reprint and the Builder preview; AuthoritativeReceipt and
 * OfflineReceipt render the LIVE checkout receipt, which is the slip actually
 * handed over at the counter. Fixing one would leave the same sale printing
 * differently depending on which screen it was printed from.
 */
const RECEIPTS = [
  "components/editor/Receipt.tsx",
  "components/runtime/AuthoritativeReceipt.tsx",
  "components/runtime/OfflineReceipt.tsx",
];

/** Everything inside the one @media print block. */
function printBlock(): string {
  const css = code(read(CSS));
  const start = css.indexOf("@media print {");

  expect(start, "the @media print block moved or was renamed").toBeGreaterThan(-1);

  return css.slice(start);
}

describe("an overlay receipt is the only thing that prints", () => {
  it("the stylesheet suppresses every non-exclusive print area", () => {
    const print = printBlock();

    expect(print).toContain("body:has(.receipt-print-area[data-print-exclusive])");
    expect(print).toContain(".receipt-print-area:not([data-print-exclusive])");
    expect(print).toContain("visibility: hidden;");
  });

  it("the rule suppresses the DESCENDANTS too, not just the container", () => {
    // visibility is inherited, but the sibling rule above sets `.receipt-print-area *`
    // to visible explicitly — so the children need an equally specific answer or
    // the contents of the losing receipt still print inside an invisible box.
    expect(printBlock()).toContain(".receipt-print-area:not([data-print-exclusive]) *");
  });

  it("Sales history detail claims exclusivity", () => {
    // THE NEGATIVE CONTROL. Removing the marker must fail here.
    const detail = code(read(DETAIL));

    expect(detail).toContain('className="receipt-print-area" data-print-exclusive');
  });

  it("it is the print area that is marked, not the visible copy", () => {
    const detail = code(read(DETAIL));
    const marked = detail.indexOf("data-print-exclusive");
    const printArea = detail.indexOf('className="receipt-print-area"');

    // Same element: the attribute sits on the print-only div.
    expect(marked).toBeGreaterThan(-1);
    expect(marked - printArea).toBeLessThan(60);
    expect(marked).toBeGreaterThan(printArea);
  });

  it("exactly one element in the app claims exclusivity", () => {
    // Two exclusive areas would collide with each other and the rule could not
    // arbitrate. Only a full-viewport overlay may claim it.
    const sources = [DETAIL, RUNTIME, PREVIEW, "components/runtime/PosCheckoutPanel.tsx"];
    const claims = sources.flatMap((file) =>
      (code(read(file)).match(/data-print-exclusive/g) ?? []).map(() => file)
    );

    expect(claims).toEqual([DETAIL]);
  });
});

describe("the single-print-area invariant, where it still holds", () => {
  it("PosRuntime's two print areas are mutually exclusive by construction", () => {
    const runtime = code(read(RUNTIME));

    // Both are gated on receiptOpen, and each setter clears the other — 24.5E's
    // rule that a reconnected till cannot reopen the previous offline receipt.
    expect(runtime).toContain("const shownReceipt = receiptOpen ? lastCompletedReceipt : null;");
    expect(runtime).toContain(
      "const shownProvisionalReceipt = receiptOpen ? lastProvisionalReceipt : null;"
    );

    const online = runtime.indexOf("setLastCompletedReceipt(receipt);");
    const offline = runtime.indexOf("setLastProvisionalReceipt(saved.receipt);");

    expect(online).toBeGreaterThan(-1);
    expect(offline).toBeGreaterThan(-1);
    // Each success path nulls the other kind before setting its own.
    expect(runtime).toContain("setLastProvisionalReceipt(null);");
    expect(runtime).toContain("setLastCompletedReceipt(null);");
  });

  it("the editor preview still mounts at most one", () => {
    const preview = code(read(PREVIEW));

    // A ternary, not two independent && blocks.
    expect(preview).toContain("authoritativeReceipt ? (");
    expect((preview.match(/receipt-print-area/g) ?? []).length).toBe(2);
  });

  it("no print area is rendered unconditionally", () => {
    // An always-mounted print area would collide with every other one.
    for (const file of [RUNTIME, PREVIEW]) {
      const source = code(read(file));

      for (const match of source.matchAll(/<div className="receipt-print-area"/g)) {
        const before = source.slice(Math.max(0, match.index! - 120), match.index!);

        expect(`${file}: each print area is conditional`).toBe(
          `${file}: each print area is conditional`
        );
        expect(before).toMatch(/\?\s*\(\s*$|&&\s*\(\s*$|:\s*\(?\s*$/);
      }
    }
  });
});

describe("nothing claims a print succeeded", () => {
  it("no success copy exists on any print path", () => {
    for (const file of [DETAIL, "components/runtime/PosCheckoutPanel.tsx"]) {
      const source = code(read(file));

      for (const lie of ["Printed", "Print successful", "Sent to printer", "Printing complete"]) {
        expect(`${file}: ${lie}`).toBe(`${file}: ${lie}`);
        expect(source).not.toContain(lie);
      }
    }
  });

  it("printing is fire-and-forget, never awaited for a result", () => {
    const detail = code(read(DETAIL));

    // window.print() returns undefined and resolves nothing. Awaiting it, or
    // branching on it, would be inventing an outcome the browser never reports.
    expect(detail).toContain("window.print();");
    expect(detail).not.toContain("await window.print");
    expect(detail).not.toContain("window.print().then");
    expect(detail).not.toContain("if (window.print");
  });
});

describe("a purchased name is never silently shortened", () => {
  it("no receipt truncates an item or modifier name", () => {
    // THE NEGATIVE CONTROL. `truncate` is overflow:hidden + text-overflow:
    // ellipsis + white-space:nowrap — on paper that quietly changes what the
    // customer's record says they bought.
    for (const file of RECEIPTS) {
      expect(`${file} must not truncate`).toBe(`${file} must not truncate`);
      expect(code(read(file))).not.toContain("truncate");
    }
  });

  it("every name column wraps instead", () => {
    for (const file of RECEIPTS) {
      const source = code(read(file));
      const names = source.match(/className="min-w-0 flex-1 break-words[^"]*"/g) ?? [];

      // Two per receipt: the item name and the modifier name.
      expect(`${file}: ${names.length} wrapping name columns`).toBe(`${file}: 2 wrapping name columns`);
    }
  });

  it("a long unbroken token cannot force horizontal overflow", () => {
    for (const file of RECEIPTS) {
      const source = code(read(file));

      // min-w-0 is what lets a flex item shrink below its intrinsic width at
      // all — without it break-words never gets the chance to act, and the row
      // overflows sideways off the slip.
      for (const match of source.matchAll(/className="([^"]*break-words[^"]*)"/g)) {
        expect(`${file}: ${match[1]}`).toContain("min-w-0");
        expect(`${file}: ${match[1]}`).toContain("flex-1");
      }
    }
  });

  it("the price column can never shrink or wrap", () => {
    for (const file of RECEIPTS) {
      const source = code(read(file));
      const prices = source.match(/className="flex-none[^"]*tabular-nums[^"]*"/g) ?? [];

      // flex-none keeps the money column at its intrinsic width whatever the
      // name does; tabular-nums keeps the digits aligned down the column.
      expect(`${file}: ${prices.length} protected price columns`).toBe(
        `${file}: 2 protected price columns`
      );
    }
  });

  it("the price sits on the FIRST line of a wrapped name", () => {
    // items-center would float it into the middle of a three-line name.
    const receipt = code(read("components/editor/Receipt.tsx"));

    expect(receipt).toContain("flex items-baseline justify-between gap-2");
    expect(receipt).not.toContain("flex items-center justify-between gap-2");
  });

  it("the modifier indent survives wrapping", () => {
    // pl-4 is on the ROW, so every wrapped line of the option name inherits it
    // and the hierarchy still reads on paper.
    for (const file of RECEIPTS) {
      const source = code(read(file));
      const modifierRow = source.slice(source.indexOf("pl-4"));

      expect(`${file} indents modifiers`).toBe(`${file} indents modifiers`);
      expect(source).toContain("pl-4");
      expect(modifierRow).toContain("break-words");
    }
  });

  it("the quantity stays with the item name", () => {
    // One text node, so a wrap can separate the lines but never lose the count.
    expect(code(read("components/editor/Receipt.tsx"))).toContain("{item.quantity} × {item.name}");
    expect(code(read("components/runtime/AuthoritativeReceipt.tsx"))).toContain(
      "{item.quantity} × {item.itemName}"
    );
  });
});
