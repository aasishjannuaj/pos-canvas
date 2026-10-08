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
const GATES = "components/device/PosGates.tsx";

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

  it("exactly two elements claim exclusivity, and they are RANKED", () => {
    // RC-polish widened this from one claimant to two, and the ranking is why
    // that is safe. Only a full-viewport overlay may claim exclusivity at all;
    // Sales history detail and the Cash Movement panel are both one. They can
    // be mounted together — the Cash Movement panel sits above a PosRuntime
    // that may already be showing a history detail — so a flat "exclusive"
    // marker could not arbitrate between them and both would print.
    //
    // The drop therefore carries a VALUED marker and outranks the valueless
    // one. Anything else claiming exclusivity, or a third claimant appearing,
    // must fail here.
    const sources = [DETAIL, RUNTIME, PREVIEW, GATES, "components/runtime/PosCheckoutPanel.tsx"];
    const claims = sources.flatMap((file) =>
      (code(read(file)).match(/data-print-exclusive/g) ?? []).map(() => file)
    );

    expect(claims).toEqual([DETAIL, GATES]);

    // The ranking itself: history is valueless, the drop names itself.
    expect(code(read(DETAIL))).toContain('className="receipt-print-area" data-print-exclusive');
    expect(code(read(GATES))).toContain('data-print-exclusive="cash-movement"');
  });

  it("the Cash Drop slips suppress every other print area, including an exclusive one", () => {
    const print = printBlock();

    // THE COLLISION THIS PREVENTS: a cashier with a receipt or a history
    // detail still open would otherwise be handed that slip and the cash drop
    // superimposed at the same origin.
    expect(print).toContain(
      'body:has(.receipt-print-area[data-print-exclusive="cash-movement"])'
    );
    expect(print).toContain('.receipt-print-area:not([data-print-exclusive="cash-movement"])');
    // Descendants too, for the same reason the rule above needs them.
    expect(print).toContain('.receipt-print-area:not([data-print-exclusive="cash-movement"]) *');
  });

  it("the Cash Drop print area leaves absolute positioning so two pages can exist", () => {
    const print = printBlock();
    const area = print.slice(print.indexOf(".cash-drop-print-area {"));

    // A page break inside an absolutely positioned box is not reliably
    // honoured; the second slip would land on top of the first.
    expect(area.slice(0, area.indexOf("}"))).toContain("position: static;");

    // Declared AFTER .receipt-print-area, or it would lose the cascade at
    // equal specificity.
    expect(print.indexOf(".receipt-print-area {")).toBeLessThan(
      print.indexOf(".cash-drop-print-area {")
    );
  });

  it("each Cash Drop slip starts its own page, and a lone slip adds no blank one", () => {
    const print = printBlock();

    expect(print).toContain(".cash-drop-slip + .cash-drop-slip {");
    expect(print).toContain("break-before: page;");
    // break-BEFORE on subsequent slips, never break-after on every slip, which
    // would emit a trailing blank page.
    expect(print).not.toContain("break-after: page;");
  });

  it("the panel renders exactly two slips, from one array, in one print area", () => {
    const gates = code(read(GATES));

    expect([...gates.matchAll(/className="cash-drop-print-area"|cash-drop-print-area/g)].length)
      .toBeGreaterThan(0);
    expect([...gates.matchAll(/receipt-print-area cash-drop-print-area/g)]).toHaveLength(1);
    // Two copies, one array, one slip element — so the count cannot drift from
    // the markup. Each entry now carries its own footer wording, which is why
    // the array holds objects rather than bare labels.
    expect(gates).toContain('{ label: "Copy 1 — with the cash"');
    expect(gates).toContain('{ label: "Copy 2 — store record"');
    expect([...gates.matchAll(/className="cash-drop-slip"/g)]).toHaveLength(1);
    expect([...gates.matchAll(/\.map\(\(copy\) =>/g)]).toHaveLength(1);
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

    // Feature 28A — this used to require a TERNARY, because there were two
    // receipt models the preview could print and exactly one of them had to
    // win. The number-typed fallback is gone, so there is now a single print
    // area behind a single condition, which is a stronger form of the same
    // invariant: one occurrence in the source, and it cannot be unconditional.
    expect((preview.match(/receipt-print-area/g) ?? []).length).toBe(1);
    expect(preview).toContain("{authoritativeReceipt && (");
    expect(preview).not.toContain("<Receipt ");
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

// ---------------------------------------------------------------------------
// v1.3 Cash Drop slip — the real 80 mm thermal width
// ---------------------------------------------------------------------------

describe("the Cash Drop slip is sized for the paper that exists", () => {
  const area = () => {
    const print = printBlock();
    const start = print.indexOf(".cash-drop-print-area {");

    expect(start).toBeGreaterThan(-1);

    return print.slice(start, print.indexOf("}", start));
  };

  it("targets the PRINTABLE width, not the nominal roll width", () => {
    // An "80 mm" Epson roll prints about 72 mm. Declared in mm so the constraint
    // reads as the physical one it is.
    expect(area()).toContain("width: 72mm;");
    expect(area()).toContain("max-width: 72mm;");
  });

  it("NEGATIVE CONTROL — the oversized 320px width cannot come back", () => {
    // 320px is roughly 84.7 mm: wider than the paper, which is what clipped and
    // downscaled every slip. The sale receipt's own 320px rule is untouched, so
    // this is scoped to the cash-drop block.
    expect(area()).not.toContain("320px");
    expect(area()).not.toContain("width: 100%");
  });

  it("keeps the page separation and claims no control over the cutter", () => {
    const print = printBlock();

    expect(print).toContain(".cash-drop-slip + .cash-drop-slip {");
    expect(print).toContain("break-before: page;");
    expect(print).not.toContain("break-after: page;");
    // CSS may paginate. It may not pretend to cut.
    for (const banned of ["GS V", "ESC/POS", "cut:", "-webkit-print-cut"]) {
      expect(`${banned} is absent`).toBe(`${banned} is absent`);
      expect(print).not.toContain(banned);
    }
  });

  it("gives the signature a rule rather than overflowable underscores", () => {
    const print = printBlock();

    expect(print).toContain(".cash-drop-slip-signature-rule {");
    expect(print).toContain("border-bottom: 1px solid #000;");
    expect(print).not.toContain("__________");
  });

  it("lets a UUID break instead of running off the roll", () => {
    const print = printBlock();
    const reference = print.slice(print.indexOf(".cash-drop-slip-reference {"));

    expect(reference.slice(0, reference.indexOf("}"))).toContain("overflow-wrap: anywhere;");
    expect(reference.slice(0, reference.indexOf("}"))).toContain("word-break: break-all;");
  });

  it("leaves the ordinary sale receipt's own width alone", () => {
    // Out of scope for this checkpoint: the sale receipt keeps its 320px.
    const print = printBlock();
    const receipt = print.slice(print.indexOf(".receipt-print-area {"));

    expect(receipt.slice(0, receipt.indexOf("}"))).toContain("max-width: 320px;");
  });
});
