// Feature 23.3 — detecting the POS Canvas Windows desktop shell.
//
// The exact parallel of lib/nativeShell.ts, which answers the same question for
// the Capacitor Android shell. Two modules rather than one because the two
// runtimes share nothing: Capacitor injects `window.Capacitor` from its native
// bridge, Electron exposes `window.posCanvasDesktop` from a preload this
// repository writes. Merging them would mean one file explaining two unrelated
// mechanisms, and a change to either would have to be reasoned about against
// both.
//
// NOT USER-AGENT SNIFFING, deliberately and for two reasons. The obvious one is
// that UA strings are unreliable and Electron's contains "Chrome" and the host
// OS in ways that change between versions. The one that actually matters: a UA
// is supplied by the page's own environment and can be set by anything, whereas
// this global is placed by a preload script that only the POS Canvas shell
// loads. The question being asked is "am I running inside our shell", and only
// our shell can answer it.
//
// FAILS CLOSED. On the server, in an ordinary browser, inside the Android shell,
// or if the global is ever missing, malformed, or a decoy of the wrong shape,
// every caller gets `false` and the device identifies itself as `web` — the
// value it has always used. A wrong `false` costs a mislabelled row in the
// owner's device list; a wrong `true` would permanently label a browser till as
// Windows, because paired_devices.platform is frozen at insert and has no
// writer afterwards.

/** The narrow slice of the bridge this module relies on. */
export type WindowsShellGlobalLike = {
  isWindowsShell?: unknown;
};

/**
 * The pure, testable core: given whatever `window.posCanvasDesktop` happens to
 * be, decide whether this is the POS Canvas desktop shell.
 *
 * Requires the exact shape — an object carrying `isWindowsShell === true`.
 * Anything else is refused, including a truthy-but-not-true value such as 1 or
 * "yes", so a partially-shaped decoy cannot pass.
 */
export function detectWindowsShell(bridge: unknown): boolean {
  if (!bridge || typeof bridge !== "object") {
    return false;
  }

  return (bridge as WindowsShellGlobalLike).isWindowsShell === true;
}

/**
 * Browser-facing wrapper. Safe to call during render or in an event handler;
 * returns false during server rendering, so the server-rendered markup always
 * matches the ordinary web case and there is no hydration mismatch.
 */
export function isWindowsShell(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return detectWindowsShell(
    (window as unknown as { posCanvasDesktop?: unknown }).posCanvasDesktop
  );
}
