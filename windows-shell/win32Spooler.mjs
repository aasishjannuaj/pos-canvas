// v1.3 Cash Drawer Checkpoint 1C — the Win32 print spooler, through koffi.
//
// THE ONLY FILE THAT IMPORTS koffi, and it does so LAZILY: nothing here runs
// until a trusted, profile-matched drawer request needs it, so the shell boots
// (and its smoke test runs) without ever loading native code. Windows x64 only.
//
// EXACTLY THE WINSPOOL CALLS ONE RAW JOB NEEDS, and nothing that enumerates,
// configures or queries printers -- enumeration is Electron's own
// webContents.getPrintersAsync(), in main.mjs:
//
//   OpenPrinterW, StartDocPrinterW, StartPagePrinter, WritePrinter,
//   EndPagePrinter, EndDocPrinter, AbortPrinter, ClosePrinter
//
// EVERY CALL IS ASYNCHRONOUS. koffi's `.async` runs the native call on a worker
// thread, so a spooler that stalls (a printer switched off, a busy queue) never
// freezes the Electron main thread and with it the till's window. Verified
// against koffi 3.3.2: `_Out_` parameters and `str16` struct members are
// marshalled for async calls exactly as for synchronous ones.
//
// TYPES, as Win32 defines them on x64:
//   BOOL     -> int (4 bytes; NOT koffi's 1-byte `bool`)
//   DWORD    -> uint32_t
//   HANDLE   -> opaque pointer
//   LPWSTR   -> str16 (UTF-16, which is what the W entry points take)
//   DOC_INFO_1W { LPWSTR pDocName; LPWSTR pOutputFile; LPWSTR pDatatype; }
// The calling-convention marker is __stdcall, which koffi applies on 32-bit
// x86 and ignores on x64, where there is only one convention.

/**
 * Declares the spooler functions on an already-loaded library and wraps them
 * in the promise-returning interface cashDrawerRaw.mjs expects.
 *
 * Separate from loadWin32Spooler so the exact declarations can be exercised
 * against a stand-in library in tests; production only ever passes
 * winspool.drv. Types are anonymous, so binding more than once never collides
 * in koffi's type registry.
 *
 * @param {any} koffi  the koffi module
 * @param {any} lib    a loaded library exporting the eight Win32 symbols
 */
export function bindWin32Spooler(koffi, lib) {
  const HANDLE = koffi.pointer(koffi.opaque());
  const DOC_INFO_1W = koffi.struct({
    pDocName: "str16",
    pOutputFile: "str16",
    pDatatype: "str16",
  });

  const OpenPrinterW = lib.func("__stdcall", "OpenPrinterW", "int", [
    "str16",
    koffi.out(koffi.pointer(HANDLE)),
    "void *",
  ]);
  const StartDocPrinterW = lib.func("__stdcall", "StartDocPrinterW", "uint32_t", [
    HANDLE,
    "uint32_t",
    koffi.pointer(DOC_INFO_1W),
  ]);
  const StartPagePrinter = lib.func("__stdcall", "StartPagePrinter", "int", [HANDLE]);
  const WritePrinter = lib.func("__stdcall", "WritePrinter", "int", [
    HANDLE,
    "void *",
    "uint32_t",
    koffi.out(koffi.pointer("uint32_t")),
  ]);
  const EndPagePrinter = lib.func("__stdcall", "EndPagePrinter", "int", [HANDLE]);
  const EndDocPrinter = lib.func("__stdcall", "EndDocPrinter", "int", [HANDLE]);
  const AbortPrinter = lib.func("__stdcall", "AbortPrinter", "int", [HANDLE]);
  const ClosePrinter = lib.func("__stdcall", "ClosePrinter", "int", [HANDLE]);

  /** Runs one native call on a koffi worker thread. */
  const call = (fn, ...args) =>
    new Promise((resolve, reject) => {
      fn.async(...args, (error, result) => (error ? reject(error) : resolve(result)));
    });

  const succeeded = (result) => typeof result === "number" && result !== 0;

  return Object.freeze({
    async open(queueName) {
      const handle = [null];
      // pDefault NULL: the queue's own defaults. No access rights are requested
      // beyond what a print job needs.
      const ok = await call(OpenPrinterW, queueName, handle, null);

      return succeeded(ok) && handle[0] ? handle[0] : null;
    },
    async startDoc(handle, { docName, datatype }) {
      const job = await call(StartDocPrinterW, handle, 1, {
        pDocName: docName,
        pOutputFile: null,
        pDatatype: datatype,
      });

      return typeof job === "number" ? job : 0;
    },
    async startPage(handle) {
      return succeeded(await call(StartPagePrinter, handle));
    },
    async write(handle, bytes) {
      const written = [null];
      const ok = await call(WritePrinter, handle, bytes, bytes.length, written);

      return {
        ok: succeeded(ok),
        written: typeof written[0] === "number" ? written[0] : -1,
      };
    },
    async endPage(handle) {
      return succeeded(await call(EndPagePrinter, handle));
    },
    async endDoc(handle) {
      return succeeded(await call(EndDocPrinter, handle));
    },
    async abort(handle) {
      return succeeded(await call(AbortPrinter, handle));
    },
    async close(handle) {
      return succeeded(await call(ClosePrinter, handle));
    },
  });
}

let loaded = null;

/**
 * The real spooler: Windows x64 only, loaded once on first use.
 *
 * Throws on any other platform or architecture, and if koffi or winspool.drv
 * cannot be loaded; the caller turns that into `failed`, before any job exists.
 */
export async function loadWin32Spooler() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The cash drawer spooler is available on Windows x64 only");
  }

  if (loaded === null) {
    const { default: koffi } = await import("koffi");

    loaded = bindWin32Spooler(koffi, koffi.load("winspool.drv"));
  }

  return loaded;
}
