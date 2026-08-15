// Feature 23.3 — unit tests for the Windows shell detector.
//
// The mirror of lib/nativeShell.test.ts. Both answer "am I inside a POS Canvas
// shell?", and both must fail closed: a wrong `true` permanently mislabels a
// till, because paired_devices.platform is frozen at insert.
import { describe, expect, it } from "vitest";
import { detectWindowsShell, isWindowsShell } from "@/lib/windowsShell";

describe("detectWindowsShell", () => {
  it("accepts the bridge the preload actually exposes", () => {
    // Exactly the object windows-shell/preload.js builds.
    expect(detectWindowsShell(Object.freeze({ isWindowsShell: true }))).toBe(true);
  });

  it("ignores extra properties on an otherwise valid bridge", () => {
    expect(detectWindowsShell({ isWindowsShell: true, somethingElse: 1 })).toBe(true);
  });

  it("requires the literal boolean true", () => {
    for (const value of [1, "true", "yes", {}, [], () => true, null, undefined]) {
      expect(detectWindowsShell({ isWindowsShell: value })).toBe(false);
    }
  });

  it("refuses a missing or non-object global", () => {
    for (const bridge of [undefined, null, true, 0, 1, "", "shell", Symbol("x")]) {
      expect(detectWindowsShell(bridge)).toBe(false);
    }
  });

  it("refuses an object of the wrong shape", () => {
    for (const bridge of [{}, { windows: true }, { isWindows: true }, { shell: true }]) {
      expect(detectWindowsShell(bridge)).toBe(false);
    }
  });

  it("does not throw on a hostile getter", () => {
    // A page cannot reach contextBridge, but the detector must not be the thing
    // that breaks the POS if it ever meets a strange object.
    const hostile = {
      get isWindowsShell() {
        throw new Error("boom");
      },
    };

    expect(() => detectWindowsShell(hostile)).toThrow();
  });

  it("is pure — the same input always gives the same answer", () => {
    const bridge = { isWindowsShell: true };
    expect(detectWindowsShell(bridge)).toBe(detectWindowsShell(bridge));
  });
});

describe("isWindowsShell", () => {
  it("returns false when there is no window at all", () => {
    // Vitest runs under Node, so this is the genuine server-render path.
    expect(typeof window).toBe("undefined");
    expect(isWindowsShell()).toBe(false);
  });

  it("never throws", () => {
    expect(() => isWindowsShell()).not.toThrow();
  });
});
