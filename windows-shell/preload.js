// Feature 23.1 — the smallest preload that lets the local fallback page ask for
// another attempt.
// Feature 23.2 — that bridge is now invisible to the hosted page.
//
// WHY A PRELOAD EXISTS AT ALL: a sandboxed, context-isolated renderer has no way
// to reach the main process without one, and the fallback page's Retry button
// needs exactly that. This is the mechanism Electron provides, used at its
// minimum size.
//
// WHY THE PROTOCOL GATE: webPreferences are per-WINDOW, not per-page, so this
// script runs for every document the window loads — including
// https://pos-canvas.vercel.app. In 23.1 that meant the hosted page could see
// `posCanvasShell`. It could do nothing harmful with it (the main process
// already ignored retries from non-local frames, and a page can reload itself
// anyway), but a bridge visible where it has no purpose is surface for no
// reason. Gating on the document's own scheme removes it: after this,
// `window.posCanvasShell` is undefined on the hosted page, and the only document
// that can see it is the local fallback loaded by the main process itself.
//
// TWO INDEPENDENT BARRIERS, deliberately. This gate decides what the page can
// SEE; the main process's sender check decides what it will ACT ON. Either alone
// would be sufficient today, which is the point — a mistake in one does not
// become an exploitable path.
//
// WHAT CROSSES THIS BRIDGE: nothing. `retry()` takes no arguments and returns
// nothing. The destination URL is never sent here and never read from here — it
// stays in the main process, which is why the fallback page works identically in
// development and in release without a URL being injected into its HTML, and why
// no page can influence where a retry goes.
//
// WHAT IS DELIBERATELY NOT HERE:
//   * Node, fs, child_process, or any Electron module beyond this one channel
//   * ipcRenderer itself (only a wrapping function is exposed, so the page
//     cannot send arbitrary channels)
//   * ipcRenderer.invoke / any request-response API
//   * the desktop identity signal used for DevicePlatform detection — that is
//     Feature 23.3 and belongs to a considered decision about what the hosted
//     page is allowed to know, not to a convenience added here
//
// CommonJS on purpose: a sandboxed preload cannot be an ES module, so `require`
// is the only module syntax available here. The rule below is disabled for this
// one line rather than for the directory, so the exception stays attached to the
// reason it exists — and so any OTHER require() added to this file would have to
// be justified on its own.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- sandboxed Electron preloads must be CommonJS
const { contextBridge, ipcRenderer } = require("electron");

// The local fallback page is the only document the main process ever loads from
// disk, so this is precisely "am I the offline page" without needing to know its
// path or compare a filename.
const isLocalFallbackPage = window.location.protocol === "file:";

if (isLocalFallbackPage) {
  // The fallback page gets the retry bridge and NOTHING else. It never pairs, so
  // it has no use for the identity signal.
  contextBridge.exposeInMainWorld("posCanvasShell", {
    /** Ask the shell to try the runtime URL again. Carries no destination. */
    retry: () => {
      ipcRenderer.send("pos-canvas-shell:retry");
    },
  });
} else {
  // Feature 23.3 — the hosted page gets the identity signal and NOTHING else.
  //
  // TWO SEPARATE GLOBALS, NOT ONE SHARED OBJECT. `posCanvasShell` is a
  // capability (it does something); `posCanvasDesktop` is a fact (it says what
  // this is). Merging them would produce one grab-bag object that grows a method
  // at a time, and every addition would silently reach both documents. Keeping
  // them apart means the hosted page cannot reach a main-process action at all,
  // and the fallback page cannot claim an identity it has no use for.
  //
  // WHAT THIS DELIBERATELY IS NOT: it carries no app version, no userData path,
  // no OS build, no machine or hardware identifier, and no function. It is one
  // boolean, and there is structurally nowhere to put anything else.
  //
  // WHY THE VALUE IS A CONSTANT `true` RATHER THAN `process.platform === "win32"`:
  // this asserts "you are running inside the POS Canvas desktop shell", not
  // "this kernel is Windows" — exactly as lib/nativeShell.ts asserts "you are
  // inside the Capacitor shell" and the web app maps that to `android` because
  // the Capacitor project is Android-only. This shell is a Windows product;
  // macOS and Linux builds are explicit non-goals. The practical consequence,
  // stated so it is never a surprise: a development run on a Mac also reports
  // the desktop shell, and pairs as `windows`. That is what makes the Windows
  // pairing path testable before any Windows hardware exists.
  //
  // Frozen so the page cannot mutate the object it was handed. contextBridge
  // already copies values across the isolation boundary, so this is belt and
  // braces rather than the primary protection.
  contextBridge.exposeInMainWorld(
    "posCanvasDesktop",
    Object.freeze({ isWindowsShell: true })
  );
}
