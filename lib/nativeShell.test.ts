import { describe, expect, it } from "vitest";
import {
  NATIVE_PRINT_UNAVAILABLE_MESSAGE,
  detectNativeShell,
  isCapacitorNativeShell,
} from "@/lib/nativeShell";

describe("detectNativeShell", () => {
  it("is true when Capacitor reports a native platform", () => {
    expect(detectNativeShell({ isNativePlatform: () => true })).toBe(true);
  });

  it("is false when Capacitor reports a web platform", () => {
    expect(detectNativeShell({ isNativePlatform: () => false })).toBe(false);
  });

  it("is false when the Capacitor global is absent", () => {
    expect(detectNativeShell(undefined)).toBe(false);
    expect(detectNativeShell(null)).toBe(false);
  });

  it("is false when the global exists but has no isNativePlatform", () => {
    expect(detectNativeShell({})).toBe(false);
    expect(detectNativeShell({ getPlatform: () => "web" })).toBe(false);
  });

  it("is false when isNativePlatform is not callable", () => {
    expect(detectNativeShell({ isNativePlatform: true as unknown as () => boolean })).toBe(
      false
    );
  });

  it("fails closed to false when isNativePlatform throws", () => {
    expect(
      detectNativeShell({
        isNativePlatform: () => {
          throw new Error("bridge unavailable");
        },
      })
    ).toBe(false);
  });

  it("requires exactly true, not merely a truthy value", () => {
    expect(
      detectNativeShell({
        isNativePlatform: () => "android" as unknown as boolean,
      })
    ).toBe(false);
    expect(
      detectNativeShell({ isNativePlatform: () => 1 as unknown as boolean })
    ).toBe(false);
  });

  it("does not rely on the user agent", () => {
    // A Capacitor-less environment claiming an Android UA is still web.
    expect(detectNativeShell({ getPlatform: () => "android" })).toBe(false);
  });
});

describe("isCapacitorNativeShell", () => {
  it("returns false under server rendering (no window)", () => {
    // The suite runs under plain Node with no DOM, so `window` is undefined
    // here — the same condition as server rendering. Returning false keeps
    // server markup identical to the web case, avoiding hydration mismatch.
    expect(typeof globalThis.window).toBe("undefined");
    expect(isCapacitorNativeShell()).toBe(false);
  });
});

describe("NATIVE_PRINT_UNAVAILABLE_MESSAGE", () => {
  it("is the approved, truthful copy", () => {
    expect(NATIVE_PRINT_UNAVAILABLE_MESSAGE).toBe(
      "Receipt printing is not available in the Android preview yet."
    );
  });

  it("does not claim Android printing works", () => {
    expect(NATIVE_PRINT_UNAVAILABLE_MESSAGE).not.toMatch(
      /printing (is )?(now )?(supported|available|enabled)\b/i
    );
    expect(NATIVE_PRINT_UNAVAILABLE_MESSAGE).toMatch(/not available/i);
  });
});
