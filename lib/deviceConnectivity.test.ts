// Feature 24.5A — the classification that decides whether a cached POS may open.
//
// These are the highest-stakes assertions in the feature: every case that is
// NOT a proven transport failure must refuse offline access. A false "offline"
// lets a revoked till trade.
import { describe, expect, it } from "vitest";
import {
  classifyDeviceFailure,
  permitsOfflineFallback,
  readOnlineHint,
} from "@/lib/deviceConnectivity";

describe("a server that answered is never treated as offline", () => {
  it("a Postgres error code proves SQL ran", () => {
    // What complete_sale_v3's `raise exception` produces through PostgREST.
    for (const code of ["P0001", "42501", "23505", "PGRST301"]) {
      expect(`code ${code}`).toBe(`code ${code}`);
      expect(classifyDeviceFailure({ code, message: "Project not found or access denied" }))
        .toBe("server_rejected");
    }
  });

  it("an HTTP status proves a reply arrived", () => {
    for (const status of [400, 401, 403, 404, 409, 500, 502, 503]) {
      expect(`status ${status}`).toBe(`status ${status}`);
      expect(classifyDeviceFailure({ status, message: "" })).toBe("server_rejected");
    }
  });

  it("PostgREST details/hint fields count as a reply", () => {
    expect(classifyDeviceFailure({ message: "x", details: "row not found" }))
      .toBe("server_rejected");
    expect(classifyDeviceFailure({ message: "x", hint: "check the id" }))
      .toBe("server_rejected");
  });

  it("evidence of a reply beats network-sounding words in the body", () => {
    // THE TRAP THIS EXISTS FOR: a 401 whose message happens to contain
    // "network" must not unlock the cache.
    expect(
      classifyDeviceFailure({
        status: 401,
        message: "Failed to fetch network credentials for this user",
      })
    ).toBe("server_rejected");

    expect(
      classifyDeviceFailure({ code: "P0001", message: "network error while checking device" })
    ).toBe("server_rejected");
  });

  it("a revocation rejection is a server answer, not an outage", () => {
    const revoked = {
      code: "P0001",
      message: "Project not found or access denied",
      details: null,
      hint: null,
    };

    expect(classifyDeviceFailure(revoked)).toBe("server_rejected");
    expect(permitsOfflineFallback(classifyDeviceFailure(revoked))).toBe(false);
  });
});

describe("a genuine transport failure is recognised on every engine", () => {
  it("recognises each browser's wording", () => {
    const messages = [
      "TypeError: Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "Network request failed",
      "fetch failed",
      "net::ERR_INTERNET_DISCONNECTED",
      "net::ERR_NAME_NOT_RESOLVED",
      "The Internet connection appears to be offline.",
    ];

    for (const message of messages) {
      expect(`message ${message}`).toBe(`message ${message}`);
      expect(classifyDeviceFailure({ message })).toBe("transport");
    }
  });

  it("reads an undici cause chain", () => {
    expect(
      classifyDeviceFailure({
        message: "fetch failed",
        cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND pos-canvas.vercel.app" },
      })
    ).toBe("transport");
  });

  it("treats socket-level codes as transport, not as a database answer", () => {
    // Node/undici put OS codes in the same `code` field PostgREST uses. Reading
    // one as "the server replied" would BLOCK a legitimate offline start.
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"]) {
      expect(`socket ${code}`).toBe(`socket ${code}`);
      expect(classifyDeviceFailure({ code, message: "fetch failed" })).toBe("transport");
    }
  });

  it("an AbortError/timeout counts as unknown-outcome transport", () => {
    expect(classifyDeviceFailure({ name: "AbortError", message: "signal timed out" }))
      .toBe("transport");
  });
});

describe("anything indeterminate refuses offline access", () => {
  it("null, undefined and primitives are unknown", () => {
    for (const value of [null, undefined, "boom", 42, true]) {
      expect(`value ${String(value)}`).toBe(`value ${String(value)}`);
      expect(classifyDeviceFailure(value)).toBe("unknown");
    }
  });

  it("an empty or unrecognised message is unknown, not offline", () => {
    expect(classifyDeviceFailure({})).toBe("unknown");
    expect(classifyDeviceFailure({ message: "" })).toBe("unknown");
    expect(classifyDeviceFailure({ message: "something went wrong" })).toBe("unknown");
  });

  it("only `transport` ever unlocks the cache", () => {
    expect(permitsOfflineFallback("transport")).toBe(true);
    expect(permitsOfflineFallback("server_rejected")).toBe(false);
    expect(permitsOfflineFallback("unknown")).toBe(false);
  });
});

describe("navigator.onLine is a hint and nothing more", () => {
  it("is read but never decides access", () => {
    expect(readOnlineHint({ onLine: true })).toBe(true);
    expect(readOnlineHint({ onLine: false })).toBe(false);
    expect(readOnlineHint(null)).toBeNull();
    expect(readOnlineHint({} as { onLine?: boolean })).toBeNull();
  });
});
