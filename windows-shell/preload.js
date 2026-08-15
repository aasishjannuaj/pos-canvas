// Feature 23.1 — the smallest preload that lets the local fallback page ask for
// another attempt.
//
// WHY A PRELOAD EXISTS AT ALL IN THIS PHASE: a sandboxed, context-isolated
// renderer has no way to reach the main process without one, and the fallback
// page's Retry button is in scope for 23.1. This is the mechanism Electron
// provides for exactly that, used at its minimum size.
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

contextBridge.exposeInMainWorld("posCanvasShell", {
  /** Ask the shell to try the runtime URL again. Carries no destination. */
  retry: () => {
    ipcRenderer.send("pos-canvas-shell:retry");
  },
});
