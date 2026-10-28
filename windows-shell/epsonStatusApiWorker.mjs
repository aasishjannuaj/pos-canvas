// v1.3.4 — the Epson Status API drawer kick, in its OWN process.
//
// WHY. The owner's till showed that a drawer command sent as a print job waits
// behind every stuck receipt in the Windows queue (paper out, 10 jobs). Epson's
// Status API (EpsStmApi.dll, installed with the Advanced Printer Driver) asks
// the printer to pulse the drawer directly, outside the print queue.
//
// WHY A SEPARATE PROCESS. This is a vendor DLL bound by hand. If a binding is
// wrong or the DLL misbehaves, it can only crash or hang THIS utility process:
// the main process kills it on a deadline and the till carries on selling.
//
// ONE REQUEST, ONE ANSWER, THEN EXIT. The parent sends
// { printer: <Windows queue name> }; this replies once and exits. Nothing is
// retried here. Answers:
//   { status: "opened" }                       BiOpenDrawer returned 0
//   { status: "unavailable", detail }          the DLL or its functions are not there
//   { status: "failed", detail }               the printer could not be opened, or the
//                                              API refused the request
//
// THE CONSTANTS are Epson's Status API values: TYPE_PRINTER = 2 (open by
// Windows printer name), EPS_BI_DRAWER_1 = 1, EPS_BI_PULSE_200 = 2, SUCCESS = 0.

const TYPE_PRINTER = 2;
const DRAWER_1 = 1;
const PULSE_200MS = 2;

function reply(message) {
  try {
    process.parentPort.postMessage(message);
  } finally {
    setTimeout(() => process.exit(0), 50);
  }
}

async function openDrawer(printer) {
  if (process.platform !== "win32" || process.arch !== "x64") {
    return { status: "unavailable", detail: "not Windows x64" };
  }

  let api;

  try {
    const { default: koffi } = await import("koffi");
    const root = process.env.SystemRoot || "C:\\Windows";
    const lib = koffi.load(`${root}\\System32\\EpsStmApi.dll`);

    api = {
      open: lib.func("__stdcall", "BiOpenMonPrinter", "int", ["int", "str"]),
      drawer: lib.func("__stdcall", "BiOpenDrawer", "int", ["int", "uint8", "uint8"]),
      close: lib.func("__stdcall", "BiCloseMonPrinter", "int", ["int"]),
    };
  } catch (error) {
    return { status: "unavailable", detail: String(error) };
  }

  const handle = api.open(TYPE_PRINTER, printer);

  if (typeof handle !== "number" || handle <= 0) {
    return { status: "failed", detail: `BiOpenMonPrinter=${handle}` };
  }

  try {
    const rc = api.drawer(handle, DRAWER_1, PULSE_200MS);

    return rc === 0 ? { status: "opened" } : { status: "failed", detail: `BiOpenDrawer=${rc}` };
  } finally {
    try {
      api.close(handle);
    } catch {
      // Closing the monitor handle cannot change whether the drawer opened.
    }
  }
}

process.parentPort.once("message", (event) => {
  const printer = event && event.data && typeof event.data.printer === "string" ? event.data.printer : null;

  if (printer === null) {
    reply({ status: "failed", detail: "no printer named" });
    return;
  }

  openDrawer(printer).then(reply, (error) => reply({ status: "failed", detail: String(error) }));
});
