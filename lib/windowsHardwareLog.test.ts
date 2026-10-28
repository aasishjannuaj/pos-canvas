// v1.3.4 — the on-till hardware log and the drawer's no-stuck-queue rule.
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HARDWARE_LOG_FILE, createHardwareLog } from "../windows-shell/hardwareLog.mjs";
import { createOpenCashDrawerHandler } from "../windows-shell/cashDrawerIpc.mjs";

const QUEUE = "EPSON TM-T20 ReceiptE4";

describe("hardwareLog.mjs", () => {
  it("appends one JSON line per step", () => {
    const dir = mkdtempSync(join(tmpdir(), "hwlog-"));
    const log = createHardwareLog({ directory: dir, now: () => new Date("2026-10-28T00:00:00Z") });
    log("drawer_request", { trusted: true });
    log("drawer_spooled", { status: "sent", ms: 12 });
    const lines = readFileSync(join(dir, HARDWARE_LOG_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { at: "2026-10-28T00:00:00.000Z", step: "drawer_request", trusted: true },
      { at: "2026-10-28T00:00:00.000Z", step: "drawer_spooled", status: "sent", ms: 12 },
    ]);
  });

  it("rotates once past the size cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "hwlog-"));
    writeFileSync(join(dir, HARDWARE_LOG_FILE), "x".repeat(100));
    createHardwareLog({ directory: dir, maxBytes: 50 })("next");
    expect(existsSync(join(dir, `${HARDWARE_LOG_FILE}.1`))).toBe(true);
    expect(readFileSync(join(dir, HARDWARE_LOG_FILE), "utf8")).toContain('"step":"next"');
  });

  it("never throws: no directory, or an unwritable one, just loses the line", () => {
    expect(() => createHardwareLog({ directory: null })("x")).not.toThrow();
    const dir = mkdtempSync(join(tmpdir(), "hwlog-"));
    writeFileSync(join(dir, "file"), "");
    expect(() => createHardwareLog({ directory: join(dir, "file", "sub") })("x")).not.toThrow();
  });
});

describe("the drawer queue can never be blocked by one stuck request (owner's Windows test)", () => {
  function fakeSpooler(hangOn: number) {
    let opens = 0;
    return {
      opens: () => opens,
      spooler: {
        async open() { opens += 1; if (opens === hangOn) await new Promise(() => {}); return 1; },
        async startDoc() { return 5; },
        async startPage() { return true; },
        async write(_h: unknown, bytes: Uint8Array) { return { ok: true, written: bytes.length }; },
        async endPage() { return true; },
        async endDoc() { return true; },
        async abort() { return true; },
        async close() { return true; },
      },
    };
  }

  it("a hung first attempt answers 'unknown' at the deadline and the next request still opens the drawer", async () => {
    const fake = fakeSpooler(1);
    const timers: (() => void)[] = [];
    const lines: string[] = [];
    const handler = createOpenCashDrawerHandler({
      isTrusted: () => true,
      listQueueNames: async () => [QUEUE],
      loadSpooler: async () => fake.spooler,
      log: (step: string) => { lines.push(step); },
      setTimer: (run: () => void) => { timers.push(run); return timers.length; },
      clearTimer: () => {},
    });
    const first = handler({});
    const second = handler({});
    await new Promise((r) => setTimeout(r, 0));
    timers[0](); // the first attempt's deadline
    expect(await first).toBe("unknown");
    expect(await second).toBe("sent");
    expect(fake.opens()).toBe(2); // each request attempted exactly once; nothing retried
    expect(lines).toContain("drawer_attempt_timed_out");
    expect(lines.filter((l) => l === "drawer_spooled")).toHaveLength(1);
  });

  it("logs the request, the queues Windows reported and the match", async () => {
    const lines: Record<string, unknown>[] = [];
    const handler = createOpenCashDrawerHandler({
      isTrusted: () => true,
      listQueueNames: async () => ["Microsoft Print to PDF"],
      loadSpooler: async () => fakeSpooler(0).spooler,
      log: (step: string, fields?: Record<string, unknown>) => { lines.push({ step, ...fields }); },
      now: () => 0,
    });
    expect(await handler({})).toBe("not_configured");
    expect(lines).toEqual([
      { step: "drawer_request", trusted: true },
      { step: "drawer_queues", ms: 0, queues: ["Microsoft Print to PDF"], match: "no_match" },
    ]);
  });
});
