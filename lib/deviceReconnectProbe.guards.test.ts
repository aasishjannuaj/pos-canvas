// v1.3 CP2e follow-up — the lines the reconnect probe must never cross.
//
// The probe answers exactly one question: WHEN to ask the backend again. Every
// consequence of the answer — whether the device is still paired, whether the
// exact employee POS-session survived, which business day it is, whether the
// queue may drain — belongs to the reconnect path that already existed and was
// already proven. The guards below exist because the cheap way to "fix"
// reconnect is to let the probe start deciding those things itself, and that
// would silently convert a reachability signal into an authorization one.
//
// A probe that reaches the server means the SERVER IS REACHABLE. It does not
// mean anybody is signed in.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/**
 * Source with comments removed.
 *
 * The forbidden-token guards below are about what the CODE does. The comments
 * in these files deliberately name the very things the code must not do —
 * navigator.onLine, health checks, session adoption — because explaining why
 * they are absent is the point of the comment. Matching prose would make the
 * guards fail for documenting themselves, so they read stripped source.
 */
const readCode = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const DEVICE_APP = "components/device/DeviceApp.tsx";
const PROBE = "lib/deviceReconnectProbe.ts";
const SYNC_ENGINE = "lib/saleSyncEngine.ts";

// The probe effect, isolated so a guard cannot accidentally pass by matching
// some other part of a 3000-line component.
function probeEffect(): string {
  const source = read(DEVICE_APP);
  const start = source.indexOf("startReconnectProbe(");
  expect(start).toBeGreaterThan(-1);

  const end = source.indexOf("Feature 24.5F (DEF-02)", start);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

/** The probe effect with its comments removed. */
function probeEffectCode(): string {
  return probeEffect()
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the probe supplements the online event, it does not replace it", () => {
  // The `online` event is still the fastest recovery for a real link drop.
  // Removing it in favour of polling would make every such reconnect wait up
  // to five seconds for no reason.
  it("keeps the browser online-event subscription", () => {
    expect(read(SYNC_ENGINE)).toContain('target.addEventListener("online", handler)');
    expect(read(DEVICE_APP)).toContain("subscribeToReconnect(");
  });

  it("routes both triggers through the same reconnect path", () => {
    const source = read(DEVICE_APP);

    // Two call sites, one function: the online event's and the probe's.
    const calls = source.match(/await returnOnlineFromReconnect\(\)/g) ?? [];
    expect(calls.length).toBe(2);

    // And both follow it with the same drain, in the same order.
    const drains = source.match(/await runSync\("reconnect"\)/g) ?? [];
    expect(drains.length).toBe(2);
  });
});

describe("the probe decides nothing about authority", () => {
  it("reuses the existing authoritative paired-device operation", () => {
    // returnOnlineFromReconnect's first act is the canonical pairing-state
    // call. The probe inherits it rather than introducing a second notion of
    // "reachable".
    expect(read(DEVICE_APP)).toContain("const pairingState = await fetchDevicePairingState()");
  });

  it("introduces no health check, ping or reachability endpoint of its own", () => {
    const effect = probeEffectCode();
    const probeSource = readCode(PROBE);

    for (const forbidden of ["/health", "ping", "fetch(", "supabase", "rpc("]) {
      expect(effect.toLowerCase()).not.toContain(forbidden.toLowerCase());
      expect(probeSource.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("never consults navigator.onLine", () => {
    expect(probeEffectCode()).not.toContain("navigator.onLine");
    expect(readCode(PROBE)).not.toContain("navigator.onLine");
  });

  // NEGATIVE CONTROL. These are the names a well-meaning shortcut would reach
  // for to "restore the session" on a successful probe. None may appear: the
  // gate derivation that runs when the latch releases is what re-establishes
  // the employee, and it asks the server rather than promoting what the till
  // was holding.
  it("performs no authentication and adopts no session", () => {
    const effect = probeEffectCode();
    const probeSource = readCode(PROBE);

    for (const forbidden of [
      "applyEmployeeAuthenticated",
      "employee_login_by_code",
      "handleEmployeeCodeLogin",
      "setGateState",
      "gateRef.current",
      "ensure_daily_register_context",
      "adoptSaleRegisterId",
    ]) {
      expect(effect).not.toContain(forbidden);
      expect(probeSource).not.toContain(forbidden);
    }
  });

  it("does not remount PosRuntime by re-resolving device state", () => {
    // resolveDeviceState begins by setting `checking`, which unmounts
    // PosRuntime and destroys the cashier's cart and any open checkout.
    // returnOnlineFromReconnect exists precisely to avoid that, and the probe
    // must not reach around it.
    expect(probeEffectCode()).not.toContain("resolveDeviceState");
  });
});

describe("the probe only runs where it is allowed to", () => {
  it("runs only in offline runtime mode", () => {
    const effect = probeEffect();

    // Guarded on the same latch the rest of the component reads, so leaving
    // offline mode tears the loop down.
    const source = read(DEVICE_APP);
    const guardStart = source.lastIndexOf("useEffect(() => {", source.indexOf("startReconnectProbe("));
    const guard = source.slice(guardStart, source.indexOf("startReconnectProbe("));

    expect(guard).toContain('getDeviceRuntimeMode(state) !== "offline"');
    expect(guard).toContain('state.status !== "ready"');
    expect(effect.length).toBeGreaterThan(0);
  });

  it("collapses visibilitychange and focus into a single subscription hook", () => {
    const effect = probeEffect();

    expect(effect).toContain('document.addEventListener("visibilitychange", handler)');
    expect(effect).toContain('window.addEventListener("focus", handler)');
    expect(effect).toContain('document.removeEventListener("visibilitychange", handler)');
    expect(effect).toContain('window.removeEventListener("focus", handler)');
  });
});

describe("nothing about money or the queue moved", () => {
  it("adds no sale-retry path of its own", () => {
    const effect = probeEffect();
    const probeSource = read(PROBE);

    // The drain is runSync, the engine's existing single-flight. A second
    // retry path would be a second schedule racing the persisted backoff.
    for (const forbidden of [
      "enqueueSale",
      "submitSale",
      "complete_sale",
      "saleRequestId",
      "occurredAt",
      "occurred_at",
      "recoverStrandedSales",
    ]) {
      expect(effect).not.toContain(forbidden);
      expect(probeSource).not.toContain(forbidden);
    }
  });

  it("leaves the queue and IndexedDB schemas untouched", () => {
    const probeSource = readCode(PROBE);

    for (const forbidden of ["indexedDB", "queueSchemaVersion", "requestPayloadVersion"]) {
      expect(probeSource).not.toContain(forbidden);
    }
  });

  it("keeps Sync now on the same reconnect implementation", () => {
    // Manual sync remains a runSync call; the probe did not fork it.
    expect(read(DEVICE_APP)).toContain('runSync("manual")');
  });
});

describe("cold-start security is unchanged", () => {
  it("still gates gate-derivation on being ready AND online", () => {
    // This is the line that keeps a cold-started offline till from promoting
    // whatever it was holding. CP2e proved the behaviour on staging; the probe
    // must not have relaxed it.
    expect(read(DEVICE_APP)).toContain(
      'state.status === "ready" && getDeviceRuntimeMode(state) !== "offline"'
    );
  });

  it("leaves the offline latch derivation itself alone", () => {
    expect(read("lib/deviceSession.ts")).toContain(
      'return state.status === "ready" && state.offline ? "offline" : "online";'
    );
  });
});
