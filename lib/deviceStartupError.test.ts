// Feature 25.4 — the fresh-install failure mapping, executed rather than read.

import { describe, expect, it } from "vitest";

import { classifyDeviceFailure } from "@/lib/deviceConnectivity";
import { classifyStartupFailure, startupFailureOffersRetry } from "@/lib/deviceStartupError";
import { createDeviceError, DEVICE_ERROR_MESSAGES, DEVICE_ERROR_TITLES } from "@/lib/deviceSession";

describe("a fresh install is told which thing is wrong", () => {
  it("a real transport failure is No connection", () => {
    expect(classifyStartupFailure("transport")).toBe("offline");
    expect(DEVICE_ERROR_TITLES.offline).toBe("No connection");
    expect(DEVICE_ERROR_MESSAGES.offline).toContain("internet connection");
  });

  it("a refused sign-in is NOT No connection", () => {
    const kind = classifyStartupFailure("server_rejected");

    expect(kind).toBe("startup_failed");
    expect(DEVICE_ERROR_TITLES[kind]).not.toBe("No connection");
    expect(DEVICE_ERROR_MESSAGES[kind]).not.toContain("internet connection");
    expect(DEVICE_ERROR_MESSAGES[kind]).not.toContain("offline");
  });

  it("an unprovable failure does not claim the network is down either", () => {
    // The old branch answered "offline" for everything. Anything that cannot
    // demonstrate a transport failure must not send an operator to the router.
    expect(classifyStartupFailure("unknown")).toBe("startup_failed");
    expect(classifyStartupFailure(undefined)).toBe("startup_failed");
  });

  it("only positive transport evidence earns No connection", () => {
    const transportOnly = (["transport", "server_rejected", "unknown", undefined] as const).filter(
      (failure) => classifyStartupFailure(failure) === "offline"
    );

    expect(transportOnly).toEqual(["transport"]);
  });
});

describe("the real classifier feeds the real mapping", () => {
  // End to end from the error shape supabase-js actually hands back, so the two
  // halves cannot drift apart while each stays green on its own.
  const startupKindFor = (error: unknown) => classifyStartupFailure(classifyDeviceFailure(error));

  it("a provider-disabled style rejection becomes a startup failure", () => {
    // 422 + a stable auth error code: an ANSWER, whatever it says.
    expect(
      startupKindFor({ status: 422, code: "anonymous_provider_disabled", message: "Anonymous sign-ins are disabled" })
    ).toBe("startup_failed");
  });

  it("any other definite server answer becomes a startup failure", () => {
    expect(startupKindFor({ status: 401, message: "Invalid API key" })).toBe("startup_failed");
    expect(startupKindFor({ status: 500, message: "Internal Server Error" })).toBe("startup_failed");
    expect(startupKindFor({ status: 403, code: "42501", message: "permission denied" })).toBe(
      "startup_failed"
    );
  });

  it("a browser fetch failure becomes No connection", () => {
    expect(startupKindFor({ message: "Failed to fetch", name: "TypeError" })).toBe("offline");
    expect(startupKindFor({ message: "NetworkError when attempting to fetch resource" })).toBe(
      "offline"
    );
    expect(startupKindFor({ message: "Load failed" })).toBe("offline");
  });

  it("an OS socket failure becomes No connection", () => {
    expect(startupKindFor({ message: "fetch failed", cause: { code: "ENOTFOUND" } })).toBe("offline");
    expect(startupKindFor({ code: "ECONNREFUSED" })).toBe("offline");
  });

  it("a status of 0 is not an answer, so it stays No connection", () => {
    // auth-js wraps a fetch failure as an AuthError with status 0.
    expect(startupKindFor({ status: 0, message: "Failed to fetch" })).toBe("offline");
  });
});

describe("no server text ever reaches the operator", () => {
  it("every message is fixed copy, not a server message", () => {
    const raw = [
      "Anonymous sign-ins are disabled",
      "anonymous_provider_disabled",
      "Invalid API key",
      "permission denied for table",
      "JWT expired",
      "PGRST301",
      "422",
      "supabase",
      "postgrest",
      "provider",
      "auth",
    ];

    for (const kind of ["offline", "startup_failed", "unavailable"] as const) {
      const shown = `${DEVICE_ERROR_TITLES[kind]} ${DEVICE_ERROR_MESSAGES[kind]}`.toLowerCase();

      for (const leak of raw) {
        expect(`${kind}: ${leak}`, `${kind} leaks "${leak}"`).toBe(`${kind}: ${leak}`);
        expect(shown).not.toContain(leak.toLowerCase());
      }
    }
  });

  it("createDeviceError carries only the fixed copy", () => {
    const error = createDeviceError("startup_failed");

    expect(error).toEqual({
      status: "error",
      kind: "startup_failed",
      message: DEVICE_ERROR_MESSAGES.startup_failed,
    });
  });

  it("every kind has a title and a message", () => {
    for (const kind of ["offline", "startup_failed", "unavailable"] as const) {
      expect(DEVICE_ERROR_TITLES[kind].length).toBeGreaterThan(0);
      expect(DEVICE_ERROR_MESSAGES[kind].length).toBeGreaterThan(0);
    }
  });
});

describe("retry", () => {
  it("is offered for a transport failure", () => {
    expect(startupFailureOffersRetry("offline")).toBe(true);
  });

  it("is offered for a startup failure too", () => {
    // An administrator can fix a refused sign-in in seconds; the operator then
    // needs a way forward that is not reinstalling the app.
    expect(startupFailureOffersRetry("startup_failed")).toBe(true);
  });

  it("is offered for an unreadable reply", () => {
    expect(startupFailureOffersRetry("unavailable")).toBe(true);
  });
});
