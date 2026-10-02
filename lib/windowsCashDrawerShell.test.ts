// v1.3 Cash Drawer Checkpoint 1C — the Windows shell's main-process hardware
// bridge, exercised as plain modules under Node.
//
// Everything that decides WHETHER a command is sent, WHERE, WHAT and HOW OFTEN
// lives in three pure modules, tested here with a fake spooler that records
// every Win32 call:
//
//   cashDrawerProfiles.mjs — the validated profile and the exact-name match
//   cashDrawerRaw.mjs      — the RAW job lifecycle, one write, no retry
//   cashDrawerIpc.mjs      — who may ask, and the request path end to end
//
// The real Win32 binding is exercised against a stand-in library in
// lib/windowsCashDrawerSpooler.test.ts. Physical drawer behaviour is Checkpoint
// 1E's, and nothing here claims it.
import { describe, expect, it } from "vitest";
import {
  VALIDATED_CASH_DRAWER_PROFILES,
  matchCashDrawerProfile,
  normalizeQueueName,
} from "../windows-shell/cashDrawerProfiles.mjs";
import {
  CASH_DRAWER_DOCUMENT_NAME,
  CASH_DRAWER_STATUSES,
  sendRawCashDrawerCommand,
} from "../windows-shell/cashDrawerRaw.mjs";
import {
  CASH_DRAWER_CHANNEL,
  createOpenCashDrawerHandler,
  isTrustedCashDrawerSender,
} from "../windows-shell/cashDrawerIpc.mjs";
import { CASH_DRAWER_OPEN_OUTCOMES } from "@/lib/cashDrawer";

const QUEUE = "EPSON TM-T20 ReceiptE4";
const VALIDATED = [0x1b, 0x70, 0x00, 0x02, 0x14];

// ---------------------------------------------------------------------------
// A recording spooler
// ---------------------------------------------------------------------------

type Call = { name: string; args: unknown[] };

type Overrides = Partial<{
  open: unknown;
  startDoc: unknown;
  startPage: unknown;
  write: unknown;
  endPage: unknown;
  endDoc: unknown;
  abort: unknown;
  close: unknown;
}>;

const HANDLE = { handle: "h" };

/** Each override is a return value, or a function returning one, or an Error to throw. */
function fakeSpooler(overrides: Overrides = {}) {
  const calls: Call[] = [];
  const defaults: Required<Overrides> = {
    open: HANDLE,
    startDoc: 7,
    startPage: true,
    write: (_h: unknown, bytes: Uint8Array) => ({ ok: true, written: bytes.length }),
    endPage: true,
    endDoc: true,
    abort: true,
    close: true,
  };
  const make =
    (name: keyof Overrides) =>
    async (...args: unknown[]) => {
      calls.push({ name, args });

      const value = name in overrides ? overrides[name] : defaults[name];

      if (value instanceof Error) throw value;

      return typeof value === "function" ? (value as (...a: unknown[]) => unknown)(...args) : value;
    };

  return {
    calls,
    names: () => calls.map((c) => c.name),
    spooler: {
      open: make("open"),
      startDoc: make("startDoc"),
      startPage: make("startPage"),
      write: make("write"),
      endPage: make("endPage"),
      endDoc: make("endDoc"),
      abort: make("abort"),
      close: make("close"),
    },
  };
}

const send = (spooler: ReturnType<typeof fakeSpooler>["spooler"]) =>
  sendRawCashDrawerCommand({
    spooler: spooler as never,
    queueName: QUEUE,
    command: VALIDATED_CASH_DRAWER_PROFILES[0].command,
    datatype: VALIDATED_CASH_DRAWER_PROFILES[0].datatype,
  });

// ---------------------------------------------------------------------------
// The validated profile
// ---------------------------------------------------------------------------

describe("the one validated profile", () => {
  it("is exactly the physically validated Epson queue, RAW, and the five validated bytes", () => {
    expect(VALIDATED_CASH_DRAWER_PROFILES).toHaveLength(1);

    const [profile] = VALIDATED_CASH_DRAWER_PROFILES;

    expect(profile.id).toBe("epson-tm-t20-receipte4");
    expect(profile.queueName).toBe(QUEUE);
    expect(profile.datatype).toBe("RAW");
    expect([...profile.command]).toEqual(VALIDATED);
    expect(Buffer.from(profile.command).toString("hex")).toBe("1b70000214");
  });

  it("is frozen all the way down", () => {
    const [profile] = VALIDATED_CASH_DRAWER_PROFILES;

    expect(Object.isFrozen(VALIDATED_CASH_DRAWER_PROFILES)).toBe(true);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.command)).toBe(true);
  });
});

describe("exact queue-name matching", () => {
  it("exactly one ReceiptE4 queue matches, and the OS spelling is what is returned", () => {
    expect(matchCashDrawerProfile(["Microsoft Print to PDF", QUEUE, "Fax"])).toEqual({
      status: "matched",
      queueName: QUEUE,
      profile: VALIDATED_CASH_DRAWER_PROFILES[0],
    });
  });

  it("surrounding whitespace and case are ignored, and the untrimmed OS name is kept for OpenPrinterW", () => {
    for (const name of ["  EPSON TM-T20 ReceiptE4  ", "epson tm-t20 receipte4", "EPSON TM-T20 RECEIPTE4"]) {
      const match = matchCashDrawerProfile([name]);

      expect(match.status).toBe("matched");
      expect(match.status === "matched" && match.queueName).toBe(name);
    }

    expect(normalizeQueueName("  A b ")).toBe("a b");
  });

  it("the validated machine's two queues together still give exactly one match — ReceiptE4", () => {
    const match = matchCashDrawerProfile(["EPSON TM-T20 Receipt", QUEUE]);

    expect(match.status === "matched" && match.queueName).toBe(QUEUE);
  });

  it("no near-miss matches: sibling queue, copies, other models, prefixes, substrings, network paths", () => {
    for (const name of [
      "EPSON TM-T20 Receipt",
      "EPSON TM-T20 ReceiptE4 (Copy 1)",
      "EPSON TM-T20II Receipt5",
      "EPSON TM-T20III Receipt",
      "EPSON TM-T20II ReceiptE4",
      "EPSON TM-T20 ReceiptE",
      "EPSON TM-T20 ReceiptE45",
      "My EPSON TM-T20 ReceiptE4",
      "EPSON  TM-T20 ReceiptE4",
      "\\\\shop-server\\EPSON TM-T20 ReceiptE4",
      "EPSON TM-T20 ReceiptE4 on USB-001",
    ]) {
      expect(`${name}: ${matchCashDrawerProfile([name]).status}`).toBe(`${name}: not_configured`);
    }
  });

  it("zero matches is not_configured", () => {
    expect(matchCashDrawerProfile([])).toEqual({ status: "not_configured", reason: "no_match" });
    expect(matchCashDrawerProfile(["Microsoft Print to PDF"])).toEqual({ status: "not_configured", reason: "no_match" });
  });

  it("more than one match is not_configured — including the same queue listed twice", () => {
    expect(matchCashDrawerProfile([QUEUE, "epson tm-t20 receipte4"])).toEqual({
      status: "not_configured",
      reason: "ambiguous",
    });
    expect(matchCashDrawerProfile([QUEUE, QUEUE])).toEqual({ status: "not_configured", reason: "ambiguous" });
  });

  it("malformed enumerations are no match, never a throw", () => {
    for (const input of [null, undefined, "EPSON TM-T20 ReceiptE4", [null, 7, {}, "", "   "]]) {
      expect(matchCashDrawerProfile(input as never)).toEqual({ status: "not_configured", reason: "no_match" });
    }
  });
});

// ---------------------------------------------------------------------------
// The RAW job
// ---------------------------------------------------------------------------

describe("the RAW spooler lifecycle", () => {
  it("runs exactly Open, StartDoc(RAW), StartPage, ONE Write of the five bytes, EndPage, EndDoc, Close — and is sent", async () => {
    const fake = fakeSpooler();

    expect(await send(fake.spooler)).toBe("sent");
    expect(fake.names()).toEqual(["open", "startDoc", "startPage", "write", "endPage", "endDoc", "close"]);

    expect(fake.calls[0].args).toEqual([QUEUE]);
    expect(fake.calls[1].args).toEqual([HANDLE, { docName: CASH_DRAWER_DOCUMENT_NAME, datatype: "RAW" }]);

    const bytes = fake.calls[3].args[1] as Uint8Array;

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes]).toEqual(VALIDATED);
  });

  it("hands the spooler a COPY, so the profile's data can never be altered through it", async () => {
    const fake = fakeSpooler({
      write: (_h: unknown, bytes: Uint8Array) => {
        bytes.fill(0);
        return { ok: true, written: 5 };
      },
    });

    await send(fake.spooler);

    expect([...VALIDATED_CASH_DRAWER_PROFILES[0].command]).toEqual(VALIDATED);
  });

  it("refuses anything but the five-byte RAW command, before opening a printer", async () => {
    for (const [command, datatype] of [
      [[0x1b, 0x70, 0x00, 0x02], "RAW"],
      [[0x1b, 0x70, 0x00, 0x02, 0x14, 0x00], "RAW"],
      [VALIDATED, "XPS_PASS"],
    ] as const) {
      const fake = fakeSpooler();

      expect(
        await sendRawCashDrawerCommand({ spooler: fake.spooler as never, queueName: QUEUE, command, datatype })
      ).toBe("failed");
      expect(fake.calls).toHaveLength(0);
    }
  });

  it("OpenPrinter failing or throwing is failed, with nothing else called", async () => {
    for (const open of [null, 0, new Error("access denied")]) {
      const fake = fakeSpooler({ open });

      expect(await send(fake.spooler)).toBe("failed");
      expect(fake.names()).toEqual(["open"]);
    }
  });

  it("StartDocPrinter failing is failed, with the handle closed and no write", async () => {
    for (const startDoc of [0, new Error("no")]) {
      const fake = fakeSpooler({ startDoc });

      expect(await send(fake.spooler)).toBe("failed");
      expect(fake.names()).toEqual(["open", "startDoc", "close"]);
    }
  });

  it("StartPagePrinter failing is failed: the empty job is aborted, the handle closed, nothing written", async () => {
    const fake = fakeSpooler({ startPage: false });

    expect(await send(fake.spooler)).toBe("failed");
    expect(fake.names()).toEqual(["open", "startDoc", "startPage", "abort", "close"]);
  });

  it("a PARTIAL write is unknown: aborted, closed, and NEVER written again", async () => {
    for (const written of [0, 1, 2, 3, 4, 6, -1]) {
      const fake = fakeSpooler({ write: { ok: true, written } });

      expect(await send(fake.spooler)).toBe("unknown");
      expect(fake.names()).toEqual(["open", "startDoc", "startPage", "write", "abort", "close"]);
      expect(fake.names().filter((n) => n === "write")).toHaveLength(1);
    }
  });

  it("WritePrinter failing, throwing or answering nonsense is unknown, aborted, and never retried", async () => {
    for (const write of [{ ok: false, written: 5 }, new Error("io"), null, {}, { ok: "yes", written: 5 }]) {
      const fake = fakeSpooler({ write });

      expect(await send(fake.spooler)).toBe("unknown");
      expect(fake.names()).toEqual(["open", "startDoc", "startPage", "write", "abort", "close"]);
    }
  });

  it("an abort that itself fails still leaves the answer unknown and the handle closed", async () => {
    const fake = fakeSpooler({ write: { ok: true, written: 2 }, abort: new Error("abort failed") });

    expect(await send(fake.spooler)).toBe("unknown");
    expect(fake.names()).toEqual(["open", "startDoc", "startPage", "write", "abort", "close"]);
  });

  it("EndPage or EndDoc failing after a full write is unknown — no abort, no second write", async () => {
    for (const overrides of [{ endPage: false }, { endDoc: false }, { endDoc: new Error("x") }]) {
      const fake = fakeSpooler(overrides);

      expect(await send(fake.spooler)).toBe("unknown");
      expect(fake.names()).toEqual(["open", "startDoc", "startPage", "write", "endPage", "endDoc", "close"]);
    }
  });

  it("ClosePrinter failing after a clean job turns sent into unknown", async () => {
    const fake = fakeSpooler({ close: false });

    expect(await send(fake.spooler)).toBe("unknown");
  });

  it("never throws", async () => {
    const fake = fakeSpooler({
      open: new Error("a"),
    });

    await expect(send(fake.spooler)).resolves.toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Who may ask
// ---------------------------------------------------------------------------

describe("isTrustedCashDrawerSender", () => {
  const frame = { url: "app://poscanvas/index.html" };
  const ok = {
    senderFrame: frame,
    mainFrame: frame,
    senderWindowId: 1,
    shellWindowIds: new Set([1]),
    platform: "win32",
  };

  it("trusts the main frame of this shell's window showing the packaged runtime, on Windows", () => {
    expect(isTrustedCashDrawerSender(ok)).toBe(true);
    expect(isTrustedCashDrawerSender({ ...ok, senderFrame: { url: "app://poscanvas/device?x=1" }, mainFrame: undefined })).toBe(false);
  });

  it("refuses every other platform", () => {
    for (const platform of ["darwin", "linux", "android", ""]) {
      expect(isTrustedCashDrawerSender({ ...ok, platform })).toBe(false);
    }
  });

  it("refuses a missing frame and any subframe", () => {
    expect(isTrustedCashDrawerSender({ ...ok, senderFrame: null })).toBe(false);
    expect(isTrustedCashDrawerSender({ ...ok, senderFrame: undefined })).toBe(false);
    expect(isTrustedCashDrawerSender({ ...ok, senderFrame: { url: frame.url } })).toBe(false);
  });

  it("refuses every document that is not app://poscanvas", () => {
    for (const url of [
      "file:///C:/Program%20Files/POS%20Canvas/resources/app.asar/offline.html",
      "file:///C:/Program%20Files/POS%20Canvas/resources/app.asar/splash.html",
      "https://pos-canvas.vercel.app/device",
      "http://localhost:3000/device",
      "app://evil/index.html",
      "app://user:pass@poscanvas/index.html",
      "",
      null,
    ]) {
      const sender = { url };

      expect(`${url}: ${isTrustedCashDrawerSender({ ...ok, senderFrame: sender, mainFrame: sender })}`).toBe(
        `${url}: false`
      );
    }
  });

  it("refuses a window this shell did not create", () => {
    expect(isTrustedCashDrawerSender({ ...ok, senderWindowId: 2 })).toBe(false);
    expect(isTrustedCashDrawerSender({ ...ok, senderWindowId: null })).toBe(false);
    expect(isTrustedCashDrawerSender({ ...ok, shellWindowIds: new Set() })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The request path, end to end
// ---------------------------------------------------------------------------

describe("createOpenCashDrawerHandler", () => {
  function setup(options: {
    trusted?: boolean | (() => boolean);
    queues?: unknown[] | Error;
    spooler?: ReturnType<typeof fakeSpooler> | Error;
  } = {}) {
    const fake = options.spooler instanceof Error ? null : options.spooler ?? fakeSpooler();
    const counts = { isTrusted: 0, listQueueNames: 0, loadSpooler: 0 };
    const handler = createOpenCashDrawerHandler({
      isTrusted: () => {
        counts.isTrusted += 1;
        const trusted = options.trusted ?? true;
        return typeof trusted === "function" ? trusted() : trusted;
      },
      listQueueNames: async () => {
        counts.listQueueNames += 1;
        if (options.queues instanceof Error) throw options.queues;
        return options.queues ?? [QUEUE];
      },
      loadSpooler: async () => {
        counts.loadSpooler += 1;
        if (options.spooler instanceof Error) throw options.spooler;
        return fake!.spooler as never;
      },
    });

    return { handler, fake, counts };
  }

  it("uses one channel name", () => {
    expect(CASH_DRAWER_CHANNEL).toBe("pos-canvas-shell:open-cash-drawer");
  });

  it("every status it can answer is one the renderer accepts", () => {
    expect([...CASH_DRAWER_STATUSES].sort()).toEqual([...CASH_DRAWER_OPEN_OUTCOMES].sort());
  });

  it("an untrusted sender is unavailable, with no enumeration, no native load and no spooler call", async () => {
    const { handler, fake, counts } = setup({ trusted: false });

    expect(await handler({})).toBe("unavailable");
    expect(counts).toEqual({ isTrusted: 1, listQueueNames: 0, loadSpooler: 0 });
    expect(fake!.calls).toHaveLength(0);
  });

  it("a trust check that throws is unavailable too", async () => {
    const { handler, counts } = setup({
      trusted: () => {
        throw new Error("frame gone");
      },
    });

    expect(await handler({})).toBe("unavailable");
    expect(counts.listQueueNames).toBe(0);
  });

  it("zero matches: not_configured, native code never loaded, no command", async () => {
    const { handler, fake, counts } = setup({ queues: ["Microsoft Print to PDF"] });

    expect(await handler({})).toBe("not_configured");
    expect(counts.loadSpooler).toBe(0);
    expect(fake!.calls).toHaveLength(0);
  });

  it("multiple matches: not_configured, native code never loaded, no command", async () => {
    const { handler, fake, counts } = setup({ queues: [QUEUE, ` ${QUEUE} `] });

    expect(await handler({})).toBe("not_configured");
    expect(counts.loadSpooler).toBe(0);
    expect(fake!.calls).toHaveLength(0);
  });

  it("a near-match printer is never eligible", async () => {
    const { handler, fake } = setup({ queues: ["EPSON TM-T20 Receipt", "EPSON TM-T20 ReceiptE4 (Copy 1)"] });

    expect(await handler({})).toBe("not_configured");
    expect(fake!.calls).toHaveLength(0);
  });

  it("exactly one match: one job to that queue, sent", async () => {
    const { handler, fake } = setup({ queues: ["Fax", QUEUE] });

    expect(await handler({})).toBe("sent");
    expect(fake!.calls[0]).toEqual({ name: "open", args: [QUEUE] });
    expect(fake!.names().filter((n) => n === "write")).toHaveLength(1);
  });

  it("enumeration failing is failed; a native module that will not load is failed", async () => {
    expect(await setup({ queues: new Error("no printers") }).handler({})).toBe("failed");
    expect(await setup({ spooler: new Error("koffi missing") }).handler({})).toBe("failed");
  });

  it("ignores anything passed after the event", async () => {
    const { handler, fake } = setup();

    await (handler as (...args: unknown[]) => Promise<string>)(
      {},
      { printer: "\\\\evil\\queue", bytes: [0x1b, 0x40], datatype: "TEXT" }
    );

    expect(fake!.calls[0].args).toEqual([QUEUE]);
    expect([...(fake!.calls[3].args[1] as Uint8Array)]).toEqual(VALIDATED);
  });

  it("an unknown result is final: one request, one write — nothing re-sends", async () => {
    const fake = fakeSpooler({ write: { ok: true, written: 3 } });
    const { handler } = setup({ spooler: fake });

    expect(await handler({})).toBe("unknown");
    expect(fake.names().filter((n) => n === "write")).toHaveLength(1);
    expect(fake.names().filter((n) => n === "open")).toHaveLength(1);
  });

  it("concurrent requests are serialized, each attempted exactly once, never interleaved", async () => {
    const fake = fakeSpooler();
    const { handler } = setup({ spooler: fake });

    const results = await Promise.all([handler({}), handler({}), handler({})]);

    expect(results).toEqual(["sent", "sent", "sent"]);
    expect(fake.names()).toEqual(
      Array.from({ length: 3 }, () => ["open", "startDoc", "startPage", "write", "endPage", "endDoc", "close"]).flat()
    );
  });

  it("a failed attempt does not poison the next one", async () => {
    let first = true;
    const fake = fakeSpooler({
      open: () => {
        if (first) {
          first = false;
          throw new Error("busy");
        }
        return HANDLE;
      },
    });
    const { handler } = setup({ spooler: fake });

    expect(await handler({})).toBe("failed");
    expect(await handler({})).toBe("sent");
  });
});
