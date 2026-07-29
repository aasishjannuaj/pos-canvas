// Feature 16.2 — detecting whether the app is running inside the Capacitor
// Android shell rather than an ordinary browser.
//
// Uses Capacitor's own supported runtime check, `Capacitor.isNativePlatform()`
// (documented in @capacitor/core's CapacitorGlobal as: "Boolean if the
// platform is native or not. `android` and `ios` would return `true`,
// otherwise `false`"), deliberately NOT user-agent sniffing.
//
// It reads the injected `window.Capacitor` global rather than importing
// `@capacitor/core`, for two reasons:
//   1. Capacitor injects this global into the WebView itself (its
//      native-bridge script), so the global is the real source of truth in
//      the only environment where the answer is "yes".
//   2. Importing @capacitor/core into application code would make it a
//      production dependency and ship Capacitor's runtime to every ordinary
//      web visitor, purely to answer a question that is always "no" there.
//      It is currently a devDependency used only for building the shell.
//
// Fails closed to "not native": on the server, in a browser, or if the
// global is ever missing or malformed, callers get the normal web behavior.

// The narrow slice of Capacitor's global that this module relies on.
export type CapacitorGlobalLike = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
};

// The pure, testable core: given whatever `window.Capacitor` happens to be,
// decide whether this is the native shell. Kept separate from any window
// access so it can be unit-tested without a DOM (this repository's test
// suite runs under plain Node with no jsdom).
export function detectNativeShell(capacitor: unknown): boolean {
  if (!capacitor || typeof capacitor !== "object") {
    return false;
  }

  const candidate = capacitor as CapacitorGlobalLike;

  if (typeof candidate.isNativePlatform !== "function") {
    return false;
  }

  try {
    return candidate.isNativePlatform() === true;
  } catch {
    // A throwing bridge must never break the POS UI.
    return false;
  }
}

// Browser-facing wrapper. Safe to call during render or in an event handler;
// returns false during server rendering, so the server-rendered markup always
// matches the web (non-native) case and there is no hydration mismatch.
export function isCapacitorNativeShell(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return detectNativeShell(
    (window as unknown as { Capacitor?: unknown }).Capacitor
  );
}

// Feature 16.2 — the truthful message shown instead of silently invoking a
// print path that does nothing inside the Android shell. This does NOT claim
// Android printing support; native printing is deliberately out of scope for
// this feature (no print plugin, no Android print framework, no thermal
// printer integration). On-screen receipt viewing remains fully available.
export const NATIVE_PRINT_UNAVAILABLE_MESSAGE =
  "Receipt printing is not available in the Android preview yet.";
