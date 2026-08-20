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

  it("PostgREST details/hint alone are NOT a reply", () => {
    // SUPERSEDED BY 24.5G, and this test is why the bug survived: it asserted
    // that details/hint prove a server answered. postgrest-js FABRICATES both
    // when fetch itself rejects, so that rule classified every offline call as
    // server_rejected and made cached offline startup impossible on hardware.
    //
    // Without a status or a real error code there is no proof of anything, so
    // these now fall through to the message table — and, finding nothing
    // network-shaped either, land on `unknown`, which still refuses the cache.
    expect(classifyDeviceFailure({ message: "x", details: "row not found" }))
      .toBe("unknown");
    expect(classifyDeviceFailure({ message: "x", hint: "check the id" }))
      .toBe("unknown");

    // With a real code or status beside them, they are an answer as before.
    expect(
      classifyDeviceFailure({ message: "x", details: "row not found", code: "P0001" })
    ).toBe("server_rejected");
    expect(classifyDeviceFailure({ message: "x", hint: "check the id", status: 400 }))
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

// ---------------------------------------------------------------------------
// Feature 24.5G — REAL library shapes, not synthetic ones
//
// This bug survived from 24.5A because every test here constructed its own
// error object — `{ message: "Failed to fetch" }` — while the real library
// produced something quite different. The tests and the library disagreed and
// the tests won, so offline startup was broken on every real device and green
// in CI. These fixtures are transcribed from executing the actual calls.
// ---------------------------------------------------------------------------

/**
 * EXACT object @supabase/postgrest-js 2.110.5 hands us when fetch rejects.
 * Captured by running a real rpc() against an unresolvable host.
 *
 * Note `hint: ""` and `code: ""` — both empty, both strings. The old evidence
 * test accepted a string of ANY content, so this classified as a server reply.
 */
const POSTGREST_OFFLINE = {
  message: "TypeError: fetch failed",
  details:
    "TypeError: fetch failed\n\nCaused by: Error: getaddrinfo ENOTFOUND pkwl.supabase.co (ENOTFOUND)",
  hint: "",
  code: "",
  // supabase-js reports 0 for a synthesized fetch failure; device.rpc.ts now
  // passes it through rather than discarding it.
  status: 0,
};

/** The same, as an Android WebView words it. */
const WEBVIEW_OFFLINE = {
  message: "TypeError: Failed to fetch",
  details: "TypeError: Failed to fetch\n    at https://localhost/assets/index.js:1:2",
  hint: "",
  code: "",
  status: 0,
};

/** A genuine PostgREST rejection: JSON body, real SQLSTATE, real status. */
const POSTGREST_RAISE = {
  message: "Project not found or access denied",
  details: null,
  hint: null,
  code: "P0001",
  status: 400,
};

describe("real offline shapes classify as transport", () => {
  it("the postgrest synthesized fetch failure", () => {
    expect(classifyDeviceFailure(POSTGREST_OFFLINE)).toBe("transport");
    expect(permitsOfflineFallback(classifyDeviceFailure(POSTGREST_OFFLINE))).toBe(true);
  });

  it("the Android WebView wording", () => {
    expect(classifyDeviceFailure(WEBVIEW_OFFLINE)).toBe("transport");
  });

  it("even with an empty details string", () => {
    // The emptiness was never the point — presence was. Both must be transport.
    expect(
      classifyDeviceFailure({ ...POSTGREST_OFFLINE, details: "", hint: "" })
    ).toBe("transport");
  });

  it("with the status field absent entirely", () => {
    // The PostgrestError object itself carries no status; device.rpc.ts adds it.
    // Older code paths and stale tabs may still classify without one.
    const noStatus = { ...POSTGREST_OFFLINE, status: undefined };

    delete (noStatus as { status?: number }).status;

    expect(classifyDeviceFailure(noStatus)).toBe("transport");
  });

  it("details carrying a stack trace is not evidence of a reply", () => {
    expect(
      classifyDeviceFailure({
        message: "TypeError: Failed to fetch",
        details: "at fetch (native)\n at rpc (index.js:1:1)",
        hint: "",
        code: "",
      })
    ).toBe("transport");
  });
});

describe("an answered server rejection is still never offline authorization", () => {
  it("a raised P0001 stays server_rejected", () => {
    expect(classifyDeviceFailure(POSTGREST_RAISE)).toBe("server_rejected");
    expect(permitsOfflineFallback(classifyDeviceFailure(POSTGREST_RAISE))).toBe(false);
  });

  it("every real SQLSTATE stays server_rejected", () => {
    for (const code of ["P0001", "42501", "23505", "PGRST301", "PGRST116"]) {
      expect(`code ${code}`).toBe(`code ${code}`);
      expect(classifyDeviceFailure({ message: "denied", details: "", hint: "", code })).toBe(
        "server_rejected"
      );
    }
  });

  it("a real HTTP status stays server_rejected, retryable or not", () => {
    // 503 especially: an answered outage is still an ANSWER, and must not
    // unlock the cache merely because retrying might help.
    for (const status of [401, 403, 409, 500, 503]) {
      expect(`status ${status}`).toBe(`status ${status}`);

      const kind = classifyDeviceFailure({ message: "Service Unavailable", status });

      expect(kind).toBe("server_rejected");
      expect(permitsOfflineFallback(kind)).toBe(false);
    }
  });

  it("a status wins even when the message looks like a network error", () => {
    expect(classifyDeviceFailure({ status: 401, message: "network error" })).toBe(
      "server_rejected"
    );
  });

  it("an unrecognisable answer falls to unknown, which also refuses the cache", () => {
    // A non-JSON gateway page arrives as { message } alone when no status is
    // plumbed. Not transport, not proven server — and unknown is fail-safe.
    const kind = classifyDeviceFailure({ message: "<html>502 Bad Gateway</html>" });

    expect(kind).toBe("unknown");
    expect(permitsOfflineFallback(kind)).toBe(false);
  });

  it("an OS socket code in the code field is transport, not a database answer", () => {
    // undici and Electron's net stack put these in the same `code` field
    // PostgREST uses for SQLSTATEs. They mean the opposite, and they are now
    // positive evidence of a transport failure rather than merely "not a
    // database answer" — which is what makes an Electron/Node host classify
    // correctly even when its message wording is unfamiliar.
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]) {
      expect(`socket code ${code}`).toBe(`socket code ${code}`);
      expect(classifyDeviceFailure({ message: "unfamiliar wording", code })).toBe(
        "transport"
      );
    }
  });
});
