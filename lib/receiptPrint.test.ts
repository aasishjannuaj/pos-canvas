// v1.3.4 Direct receipt printing — both halves, as plain modules.
//
//   windows-shell/receiptPrintIpc.mjs — who may ask, which printer, one job
//   lib/receiptPrint.ts               — the renderer: silent first, the print
//                                       window only when nothing was printed
//
// Physical printing is the owner's Windows test, and nothing here claims it.
import { describe, expect, it, vi } from "vitest";
import {
  RECEIPT_PRINT_CHANNEL,
  RECEIPT_PRINT_OUTCOMES,
  chooseReceiptPrinter,
  createPrintReceiptHandler,
} from "../windows-shell/receiptPrintIpc.mjs";
import { detectReceiptPrintBridge, printPage, shouldFallBackToPrintWindow } from "@/lib/receiptPrint";

const QUEUE = "EPSON TM-T20 ReceiptE4";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function shell(over: { trusted?: boolean; queues?: unknown; print?: (e: unknown, o: unknown) => Promise<boolean> } = {}) {
  const calls: unknown[] = [];
  const handler = createPrintReceiptHandler({
    isTrusted: () => over.trusted ?? true,
    listQueueNames: async () => {
      if (over.queues instanceof Error) throw over.queues;
      return (over.queues as unknown[]) ?? ["Microsoft Print to PDF", QUEUE];
    },
    print: async (event, options) => {
      calls.push(options);
      return over.print ? over.print(event, options) : true;
    },
  });
  return { handler, calls };
}

describe("main process: receiptPrintIpc.mjs", () => {
  it("uses its own channel and answers only known outcomes", () => {
    expect(RECEIPT_PRINT_CHANNEL).toBe("pos-canvas-shell:print-receipt");
    expect([...RECEIPT_PRINT_OUTCOMES].sort()).toEqual(["failed", "printed", "unavailable"]);
  });

  it("prints silently to the validated receipt printer when exactly one is installed", async () => {
    const { handler, calls } = shell();
    expect(await handler({})).toBe("printed");
    expect(calls).toEqual([{ silent: true, printBackground: true, usePrinterDefaultPageSize: true, margins: { marginType: "printableArea" }, deviceName: QUEUE }]);
  });

  it("otherwise prints silently to the Windows default printer (no deviceName)", async () => {
    for (const queues of [["Some Other Printer"], [QUEUE, `${QUEUE} `.toLowerCase()], [], new Error("enum failed")]) {
      const { handler, calls } = shell({ queues });
      expect(await handler({})).toBe("printed");
      expect(calls).toEqual([{ silent: true, printBackground: true, usePrinterDefaultPageSize: true, margins: { marginType: "printableArea" } }]);
    }
  });

  it("chooseReceiptPrinter never matches a near-miss name", () => {
    expect(chooseReceiptPrinter(["EPSON TM-T20 Receipt"])).toBeUndefined();
    expect(chooseReceiptPrinter([`${QUEUE} (Copy 1)`])).toBeUndefined();
    expect(chooseReceiptPrinter([` ${QUEUE} `])).toBe(` ${QUEUE} `);
  });

  it("an untrusted sender gets 'unavailable' and no printer work at all", async () => {
    const { handler, calls } = shell({ trusted: false });
    expect(await handler({})).toBe("unavailable");
    expect(calls).toEqual([]);
  });

  it("a trust check that throws is untrusted", async () => {
    const handler = createPrintReceiptHandler({
      isTrusted: () => { throw new Error("x"); },
      listQueueNames: async () => [],
      print: async () => true,
    });
    expect(await handler({})).toBe("unavailable");
  });

  it("a print that reports failure, or throws, is 'failed' and is not retried", async () => {
    const a = shell({ print: async () => false });
    expect(await a.handler({})).toBe("failed");
    expect(a.calls).toHaveLength(1);
    const b = shell({ print: async () => { throw new Error("spool"); } });
    expect(await b.handler({})).toBe("failed");
    expect(b.calls).toHaveLength(1);
  });

  it("a double tap queues: two requests are two jobs, one after the other, never overlapping", async () => {
    let active = 0;
    let maxActive = 0;
    const { handler, calls } = shell({
      print: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await flush();
        active -= 1;
        return true;
      },
    });
    expect(await Promise.all([handler({}), handler({})])).toEqual(["printed", "printed"]);
    expect(calls).toHaveLength(2);
    expect(maxActive).toBe(1);
  });

  it("always asks for the printer's OWN paper size, never the A4 default (owner's Windows test)", async () => {
    const { handler, calls } = shell();
    await handler({});
    expect(calls[0]).toMatchObject({ usePrinterDefaultPageSize: true, margins: { marginType: "printableArea" } });
    expect(calls[0]).not.toHaveProperty("pageSize");
  });

  it("logs each print with its printer, outcome and Electron's failure reason", async () => {
    const lines: unknown[] = [];
    const handler = createPrintReceiptHandler({
      isTrusted: () => true,
      listQueueNames: async () => [QUEUE],
      print: async () => ({ success: false, failureReason: "Print job failed" }),
      log: (step, fields) => lines.push({ step, ...fields }),
      now: () => 0,
    });
    expect(await handler({})).toBe("failed");
    expect(lines).toEqual([{ step: "receipt_print", printer: QUEUE, success: false, failureReason: "Print job failed", ms: 0 }]);
  });

  it("a failed job does not block the next one", async () => {
    let n = 0;
    const { handler } = shell({ print: async () => (n += 1) > 1 });
    expect(await handler({})).toBe("failed");
    expect(await handler({})).toBe("printed");
  });
});

describe("renderer: lib/receiptPrint.ts", () => {
  it("detects only the preload's exact shape", () => {
    const fn = () => Promise.resolve("printed");
    expect(detectReceiptPrintBridge({ printReceipt: fn })).toBe(fn);
    for (const bad of [null, undefined, 1, "x", {}, { printReceipt: 1 }]) expect(detectReceiptPrintBridge(bad)).toBeNull();
  });

  it("falls back only on the answers that mean nothing was printed", () => {
    expect(shouldFallBackToPrintWindow("unavailable")).toBe(true);
    expect(shouldFallBackToPrintWindow("failed")).toBe(true);
    for (const other of ["printed", "unknown", undefined, null, 0, {}]) expect(shouldFallBackToPrintWindow(other)).toBe(false);
  });

  it("no bridge (browser, Builder, owner app): the print window, exactly once", () => {
    const openPrintWindow = vi.fn();
    printPage({ bridge: null, openPrintWindow });
    expect(openPrintWindow).toHaveBeenCalledTimes(1);
  });

  it("printed silently: the print window never opens", async () => {
    const openPrintWindow = vi.fn();
    const bridge = vi.fn(async () => "printed");
    printPage({ bridge, openPrintWindow });
    await flush();
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(openPrintWindow).not.toHaveBeenCalled();
  });

  it("'failed' or 'unavailable': the print window opens once, and the shell is not asked again", async () => {
    for (const outcome of ["failed", "unavailable"]) {
      const openPrintWindow = vi.fn();
      const bridge = vi.fn(async () => outcome);
      printPage({ bridge, openPrintWindow });
      await flush();
      expect(bridge).toHaveBeenCalledTimes(1);
      expect(openPrintWindow).toHaveBeenCalledTimes(1);
    }
  });

  it("an answer it cannot trust (rejection, malformed) is final: no window, no resend — never two receipts", async () => {
    for (const bridge of [vi.fn(async () => { throw new Error("ipc"); }), vi.fn(async () => "weird"), vi.fn(async () => undefined)]) {
      const openPrintWindow = vi.fn();
      printPage({ bridge, openPrintWindow });
      await flush();
      expect(bridge).toHaveBeenCalledTimes(1);
      expect(openPrintWindow).not.toHaveBeenCalled();
    }
  });

  it("a bridge that throws synchronously sent nothing: the print window opens", () => {
    const openPrintWindow = vi.fn();
    printPage({ bridge: () => { throw new Error("x"); }, openPrintWindow });
    expect(openPrintWindow).toHaveBeenCalledTimes(1);
  });

  it("returns nothing for the caller to await", () => {
    expect(printPage({ bridge: null, openPrintWindow: () => {} })).toBeUndefined();
  });
});
