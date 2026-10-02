// v1.3 Cash Drawer Checkpoint 1C — the REAL Win32 binding
// (windows-shell/win32Spooler.mjs bindWin32Spooler), driven through koffi
// 3.3.2 against a stand-in library that exports the eight winspool symbols.
//
// WHAT THIS PROVES THAT THE PURE TESTS CANNOT: that the declarations as
// written -- BOOL as int, DWORD as uint32_t, an opaque HANDLE, DOC_INFO_1W of
// three UTF-16 pointers, the two `_Out_` parameters -- marshal correctly
// through koffi's ASYNC calls: the queue name arrives as UTF-16, the handle
// comes back and round-trips, the datatype is "RAW" with a NULL output file,
// exactly the five validated bytes reach WritePrinter, and its written count
// comes back. And that one job through the real binding makes exactly the
// documented calls, once each.
//
// WHAT IT DOES NOT PROVE: anything about Windows' spooler, a printer or a
// drawer. The stand-in is compiled here, on this machine; winspool.drv is only
// ever loaded on Windows (loadWin32Spooler), and physical behaviour is
// Checkpoint 1E's.
//
// Needs a C compiler. Without one the suite SKIPS LOUDLY rather than failing.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindWin32Spooler, loadWin32Spooler } from "../windows-shell/win32Spooler.mjs";
import { sendRawCashDrawerCommand } from "../windows-shell/cashDrawerRaw.mjs";
import { VALIDATED_CASH_DRAWER_PROFILES } from "../windows-shell/cashDrawerProfiles.mjs";

const shellDir = join(dirname(fileURLToPath(import.meta.url)), "..", "windows-shell");

function findCompiler(): string | null {
  for (const candidate of ["cc", "clang", "gcc"]) {
    try {
      execFileSync("which", [candidate], { stdio: "ignore" });
      return candidate;
    } catch {
      // keep looking
    }
  }

  return null;
}

function loadKoffi(): unknown {
  try {
    return createRequire(join(shellDir, "package.json"))("koffi");
  } catch {
    return null;
  }
}

const COMPILER = process.platform === "win32" ? null : findCompiler();
const koffi = loadKoffi() as {
  load(path: string): { func(signature: string): (...args: unknown[]) => unknown };
} | null;
const canRun = COMPILER !== null && koffi !== null;

if (!canRun) {
  console.warn(
    "\n[win32Spooler binding] SKIPPED: needs a C compiler and windows-shell's koffi installed." +
      "\n  These are the only tests that drive the real koffi declarations.\n"
  );
}

// The eight winspool entry points, recording every call into a log the test
// reads back. WritePrinter's reported count is settable, to simulate a partial
// write.
const STAND_IN = `
#include <stdint.h>
#include <stdio.h>
#include <string.h>
typedef struct { uint16_t *pDocName; uint16_t *pOutputFile; uint16_t *pDatatype; } DOC_INFO_1W;
static int token = 42; static char log_[1024]; static int64_t report = -1;
static void u16(const uint16_t *s, char *o) {
  int i = 0, j = 0; if (!s) { strcpy(o, "NULL"); return; }
  for (; s[i]; i++) j += sprintf(o + j, s[i] < 128 ? "%c" : "U+%04X", s[i]);
  o[j] = 0;
}
static void L(const char *s) { strncat(log_, s, sizeof log_ - strlen(log_) - 1); }
int OpenPrinterW(uint16_t *n, void **h, void *d) { char b[256], m[300]; u16(n, b);
  snprintf(m, sizeof m, "OpenPrinterW(%s,%s);", b, d ? "defaults" : "NULL"); L(m); *h = &token; return 1; }
uint32_t StartDocPrinterW(void *h, uint32_t lv, DOC_INFO_1W *di) { char a[64], b[64], c[64], m[256];
  u16(di->pDocName, a); u16(di->pOutputFile, b); u16(di->pDatatype, c);
  snprintf(m, sizeof m, "StartDocPrinterW(%s,%u,%s,%s,%s);", h == &token ? "handle" : "BAD", lv, a, b, c); L(m); return 9; }
int StartPagePrinter(void *h) { L(h == &token ? "StartPagePrinter;" : "StartPagePrinter(BAD);"); return 1; }
int WritePrinter(void *h, const uint8_t *b, uint32_t n, uint32_t *w) { char m[128]; int j;
  j = snprintf(m, sizeof m, "WritePrinter(%u:", n); for (uint32_t i = 0; i < n && j < 120; i++) j += snprintf(m + j, sizeof m - j, "%02x", b[i]);
  snprintf(m + j, sizeof m - j, ");"); L(m); *w = report < 0 ? n : (uint32_t)report; return 1; }
int EndPagePrinter(void *h) { L("EndPagePrinter;"); return 1; }
int EndDocPrinter(void *h) { L("EndDocPrinter;"); return 1; }
int AbortPrinter(void *h) { L("AbortPrinter;"); return 1; }
int ClosePrinter(void *h) { L(h == &token ? "ClosePrinter;" : "ClosePrinter(BAD);"); return 1; }
const char *StandInLog(void) { return log_; }
void StandInReset(int64_t reportWritten) { log_[0] = 0; report = reportWritten; }
`;

let dir = "";
let lib: ReturnType<NonNullable<typeof koffi>["load"]> | null = null;
let readLog: () => string = () => "";
let reset: (report: number) => void = () => undefined;

beforeAll(() => {
  if (!canRun) return;

  dir = mkdtempSync(join(tmpdir(), "pos-canvas-1c-winspool-"));
  writeFileSync(join(dir, "winspool.c"), STAND_IN);

  const output = join(dir, process.platform === "darwin" ? "winspool.dylib" : "winspool.so");

  execFileSync(COMPILER as string, ["-shared", "-fPIC", "-o", output, join(dir, "winspool.c")]);
  lib = koffi!.load(output);

  const log = lib.func("const char *StandInLog(void)");
  const resetFn = lib.func("void StandInReset(int64_t reportWritten)");

  readLog = () => log() as string;
  reset = (report: number) => {
    resetFn(report);
  };
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const maybe = canRun ? describe : describe.skip;
const [PROFILE] = VALIDATED_CASH_DRAWER_PROFILES;

const job = (queueName: string) =>
  sendRawCashDrawerCommand({
    spooler: bindWin32Spooler(koffi, lib) as never,
    queueName,
    command: PROFILE.command,
    datatype: PROFILE.datatype,
  });

maybe("the real koffi declarations, through async calls", () => {
  it("one job is exactly the documented sequence, once each, with the five validated bytes", async () => {
    reset(-1);

    expect(await job(PROFILE.queueName)).toBe("sent");
    expect(readLog()).toBe(
      "OpenPrinterW(EPSON TM-T20 ReceiptE4,NULL);" +
        "StartDocPrinterW(handle,1,POS Canvas,NULL,RAW);" +
        "StartPagePrinter;" +
        "WritePrinter(5:1b70000214);" +
        "EndPagePrinter;" +
        "EndDocPrinter;" +
        "ClosePrinter;"
    );
  });

  it("the queue name crosses as UTF-16, not narrowed to ASCII", async () => {
    reset(-1);

    await job("Caisse Épson €");

    expect(readLog()).toContain("OpenPrinterW(Caisse U+00C9pson U+20AC,NULL);");
  });

  it("a partial write count comes back through the _Out_ DWORD, and the job aborts with one write", async () => {
    reset(2);

    expect(await job(PROFILE.queueName)).toBe("unknown");

    const log = readLog();

    expect(log).toBe(
      "OpenPrinterW(EPSON TM-T20 ReceiptE4,NULL);" +
        "StartDocPrinterW(handle,1,POS Canvas,NULL,RAW);" +
        "StartPagePrinter;" +
        "WritePrinter(5:1b70000214);" +
        "AbortPrinter;" +
        "ClosePrinter;"
    );
    expect(log.split("WritePrinter(").length - 1).toBe(1);
  });

  it("binding twice does not collide in koffi's type registry", () => {
    expect(() => {
      bindWin32Spooler(koffi, lib);
      bindWin32Spooler(koffi, lib);
    }).not.toThrow();
  });
});

describe("the real spooler is Windows x64 only", () => {
  it("refuses to load anywhere else, before touching koffi or winspool.drv", async () => {
    if (process.platform === "win32" && process.arch === "x64") return;

    await expect(loadWin32Spooler()).rejects.toThrow("Windows x64 only");
  });
});
