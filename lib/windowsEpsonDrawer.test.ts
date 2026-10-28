// v1.3.4 — the Epson Status API drawer path: the opener (with a fake utility
// process) and how the drawer handler acts on each of its answers. The real
// DLL is exercised only on the owner's till; nothing here claims it.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createEpsonDrawerOpener } from "../windows-shell/epsonDrawer.mjs";
import { createOpenCashDrawerHandler } from "../windows-shell/cashDrawerIpc.mjs";

const QUEUE = "EPSON TM-T20 ReceiptE4";

function fakeChild(onPost: (child: EventEmitter & { kill: () => void }, msg: unknown) => void) {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(), postMessage: (m: unknown) => queueMicrotask(() => onPost(child, m)) });
  return child;
}

describe("createEpsonDrawerOpener", () => {
  it("passes the printer name and returns the helper's answer, then kills the helper", async () => {
    let seen: unknown = null;
    const child = fakeChild((c, m) => { seen = m; c.emit("message", { status: "opened" }); });
    const open = createEpsonDrawerOpener({ fork: () => child as never });
    expect(await open(QUEUE)).toEqual({ status: "opened" });
    expect(seen).toEqual({ printer: QUEUE });
    expect(child.kill).toHaveBeenCalled();
  });

  it("keeps 'unavailable' and 'failed' with their detail; anything else is 'failed'", async () => {
    for (const [answer, expected] of [
      [{ status: "unavailable", detail: "no dll" }, { status: "unavailable", detail: "no dll" }],
      [{ status: "failed", detail: "BiOpenDrawer=-10" }, { status: "failed", detail: "BiOpenDrawer=-10" }],
      [{ status: "weird" }, { status: "failed", detail: "malformed answer" }],
    ] as const) {
      const open = createEpsonDrawerOpener({ fork: () => fakeChild((c) => c.emit("message", answer)) as never });
      expect(await open(QUEUE)).toEqual(expected);
    }
  });

  it("no answer by the deadline is 'unknown' and the helper is killed", async () => {
    let fire: () => void = () => {};
    const child = fakeChild(() => {});
    const open = createEpsonDrawerOpener({ fork: () => child as never, setTimer: (run) => { fire = run; return 1; }, clearTimer: () => {} });
    const result = open(QUEUE);
    fire();
    expect(await result).toMatchObject({ status: "unknown" });
    expect(child.kill).toHaveBeenCalled();
  });

  it("a helper that exits without answering is 'failed'; one that cannot start is 'unavailable'", async () => {
    const open = createEpsonDrawerOpener({ fork: () => fakeChild((c) => c.emit("exit", 1)) as never });
    expect(await open(QUEUE)).toMatchObject({ status: "failed" });
    const cannot = createEpsonDrawerOpener({ fork: () => { throw new Error("no utility process"); } });
    expect(await cannot(QUEUE)).toMatchObject({ status: "unavailable" });
  });
});

describe("the drawer handler: Status API first, print job only when the API is absent", () => {
  function handler(direct: { status: string } | Error) {
    const spoolerCalls: string[] = [];
    const lines: Record<string, unknown>[] = [];
    const spooler = {
      async open() { spoolerCalls.push("open"); return 1; },
      async startDoc() { return 5; }, async startPage() { return true; },
      async write(_h: unknown, b: Uint8Array) { return { ok: true, written: b.length }; },
      async endPage() { return true; }, async endDoc() { return true; }, async abort() { return true; }, async close() { return true; },
    };
    const h = createOpenCashDrawerHandler({
      isTrusted: () => true,
      listQueueNames: async () => [QUEUE],
      loadSpooler: async () => spooler,
      openDirect: async () => { if (direct instanceof Error) throw direct; return direct; },
      log: (step: string, fields?: Record<string, unknown>) => { lines.push({ step, ...fields }); },
      now: () => 0,
    });
    return { h, spoolerCalls, lines };
  }

  it("opened → 'sent', and no print job is created", async () => {
    const t = handler({ status: "opened" });
    expect(await t.h({})).toBe("sent");
    expect(t.spoolerCalls).toEqual([]);
    expect(t.lines.find((l) => l.step === "drawer_status_api")).toMatchObject({ status: "opened" });
  });

  it("unavailable (no Epson Status API) → falls back to the print job once", async () => {
    const t = handler({ status: "unavailable" });
    expect(await t.h({})).toBe("sent");
    expect(t.spoolerCalls).toEqual(["open"]);
  });

  it("failed, unknown or a throw → NO print job (it could open the drawer later, unasked)", async () => {
    for (const [direct, expected] of [[{ status: "failed" }, "failed"], [{ status: "unknown" }, "unknown"], [new Error("x"), "failed"]] as const) {
      const t = handler(direct as never);
      expect(await t.h({})).toBe(expected);
      expect(t.spoolerCalls).toEqual([]);
    }
  });

  it("an unmatched printer still never reaches the Status API or the spooler", async () => {
    const openDirect = vi.fn();
    const h = createOpenCashDrawerHandler({
      isTrusted: () => true, listQueueNames: async () => ["Adobe PDF"], loadSpooler: async () => { throw new Error("no"); }, openDirect,
    });
    expect(await h({})).toBe("not_configured");
    expect(openDirect).not.toHaveBeenCalled();
  });
});
