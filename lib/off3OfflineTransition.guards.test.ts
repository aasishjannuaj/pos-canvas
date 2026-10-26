// OFF-3 — static guards on the offline-transition correction.
//
// What these pin: the browser `offline` event only starts a BOUNDED server check
// (DEF-01: the cache never opens on the browser's word); the background re-read
// is bounded and ignores results after an authority change; the asynchronous
// offline entry is coalesced, re-checked after its await and never writes the
// employee gate; the online dispatch refuses once the till is offline, while the
// authority token and the exact-recovery path are untouched.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BACKGROUND_SESSION_READ_TIMEOUT_MS } from "@/components/device/DeviceApp";
import { SALE_SUBMISSION_TIMEOUT_MS } from "@/lib/offlineSaleRpc";
import { SALE_LOOKUP_TIMEOUT_MS, SALE_RECOVERY_TIMEOUT_MS } from "@/lib/saleRecoveryRpc";
import { RECONNECT_PROBE_BACKOFF_MS } from "@/lib/deviceReconnectProbe";
import { AUTO_LOCK_TIMEOUT_MS } from "@/lib/autoLock";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** Source with comments stripped, so prose cannot satisfy an assertion. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const APP = code(read("components/device/DeviceApp.tsx"));
const RPC = code(read("lib/employee.rpc.ts"));

/** The text of one `const name = useCallback(` declaration, up to the next top-level hook/const. */
function block(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);

  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);

  const end = source.indexOf(endMarker, start + startMarker.length);

  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);

  return source.slice(start, end);
}

const DERIVE = block(APP, "const deriveGateState = useCallback(", "const gateDerivationAllowed");
const ENTRY = block(APP, "const enterOfflineFromTransportFailure = useCallback(", "useEffect(() => {\n    offlineModeRef.current");
const HINT = block(APP, "const confirmOfflineFromHint = useCallback(", "const liveOnlineForOfflineHint");
const HINT_EFFECT = block(APP, "const liveOnlineForOfflineHint", "}, [liveOnlineForOfflineHint, confirmOfflineFromHint]);");
const RECONNECT = block(APP, "const returnOnlineFromReconnect = useCallback(", "}, []);");
const COMPLETE = block(APP, "const completeSale: PosRuntimeCompleteSale = useCallback(", "[deriveGateState, verifySubmittedSale]");
const RECOVER = block(APP, "const recoverOutstandingSale: PosRuntimeRecoverOutstandingSale = useCallback(", "getDeviceRuntimeMode(state) !== \"offline\";");
const AUTHORITY = block(APP, "const readHostAuthority = useCallback(", "const prepareCheckoutAuthorization");

describe("policy values", () => {
  it("the background re-read deadline is 10s; sale, recovery, probe and auto-lock timings are unchanged", () => {
    expect(BACKGROUND_SESSION_READ_TIMEOUT_MS).toBe(10_000);
    expect([SALE_SUBMISSION_TIMEOUT_MS, SALE_LOOKUP_TIMEOUT_MS, SALE_RECOVERY_TIMEOUT_MS]).toEqual([30_000, 15_000, 30_000]);
    expect([...RECONNECT_PROBE_BACKOFF_MS]).toEqual([5_000, 10_000, 20_000, 30_000, 60_000]);
    expect(AUTO_LOCK_TIMEOUT_MS).toBe(600_000);
  });
});

describe("the browser offline event is a hint that asks the server (DEF-01 kept)", () => {
  it("never reads navigator.onLine and opens nothing directly", () => {
    expect(APP).not.toContain("navigator.onLine");
    expect(HINT_EFFECT).toContain('window.addEventListener("offline", onOffline)');
    expect(HINT_EFFECT).toContain('window.removeEventListener("offline", onOffline)');
    expect(HINT_EFFECT).toContain("void confirmOfflineFromHint();");
    expect(HINT_EFFECT).not.toContain("enterOffline");
    expect(HINT_EFFECT).not.toContain("loadOfflineFallback");
  });

  it("the hint check is one bounded employee read; only a never-reached answer leads to the existing entry", () => {
    expect(HINT).toContain("timeoutMs: BACKGROUND_SESSION_READ_TIMEOUT_MS");
    expect(HINT).toContain('!employee.ok && employee.unreached === "offline" && gateRef.current.employee !== null');
    expect(HINT).toContain("void enterOfflineRef.current?.();");
    expect(HINT).toContain("if (authorityEpochRef.current !== epochAtStart)");
    expect(HINT).toContain("hintCheckInFlightRef");
  });

  it("the hint check writes no gate, makes no daily call and grants no authority", () => {
    for (const banned of ["setGate(", "gateRef.current =", "acquireDaily", "advanceAuthorityEpoch", "setState(", "loadOfflineFallback"]) {
      expect(`${banned}: ${HINT.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("only one offline listener exists in DeviceApp", () => {
    expect((APP.match(/addEventListener\("offline"/g) ?? []).length).toBe(1);
  });
});

describe("the background re-read is bounded and late results are ignored", () => {
  it("deriveGateState passes the deadline and checks the authority epoch after BOTH awaits", () => {
    expect(DERIVE).toContain("timeoutMs: BACKGROUND_SESSION_READ_TIMEOUT_MS");
    expect(DERIVE).toContain("const epochAtStart = authorityEpochRef.current;");
    expect((DERIVE.match(/if \(authorityEpochRef\.current !== epochAtStart\) \{\s*return gateRef\.current;/g) ?? []).length).toBe(2);
    expect(DERIVE.indexOf("epochAtStart = authorityEpochRef")).toBeLessThan(DERIVE.indexOf("await readEmployeeSession"));
  });

  it("sign-in, switch and logout reads keep the unbounded call (exactly two bounded callers)", () => {
    expect((APP.match(/readEmployeeSession\(\{\s*timeoutMs: BACKGROUND_SESSION_READ_TIMEOUT_MS/g) ?? []).length).toBe(2);
    expect((APP.match(/await readEmployeeSession\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("the RPC deadline races the whole call and aborts the request; no deadline = the old call", () => {
    expect(RPC).toContain("if (timeoutMs === undefined) {");
    expect(RPC).toContain("return readCurrentEmployeeSession(null);");
    expect(RPC).toContain("Promise.race([readCurrentEmployeeSession(controller.signal), deadline])");
    expect(RPC).toContain("controller.abort();");
    expect(RPC).toContain('resolve(failure("offline"));');
    expect(RPC).toContain("signal === null\n      ? request\n      : request.abortSignal(signal)");
    // A server answer is classified exactly as before.
    expect(RPC).toContain('return failure(unreachedFailure(withStatus(error, status)));');
    expect(RPC).toContain('if (!parsed.ok && parsed.error === "offline") {\n      return failure("unavailable");');
  });
});

describe("the asynchronous offline entry is coalesced, re-checked and authority-neutral", () => {
  it("coalesces attempts only under the SAME authority epoch and generation; a newer authority starts its own", () => {
    expect(ENTRY).toContain("const authorityEpoch = authorityEpochRef.current;");
    expect(ENTRY).toContain(
      "inFlight !== null &&\n      inFlight.authorityEpoch === authorityEpoch &&\n      inFlight.generation === generation"
    );
    expect(ENTRY).toContain("return inFlight.promise;");
    expect(ENTRY).toContain("offlineEntryRef.current = { promise: attempt, authorityEpoch, generation };");
    // The slot is cleared only by the attempt that owns it.
    expect(ENTRY).toContain("if (offlineEntryRef.current?.promise === holder.promise) {");
  });

  it("re-checks the employee-authority epoch after the saved-setup load (stale across a newer login/switch)", () => {
    const awaitAt = ENTRY.indexOf("await loadOfflineFallback(");
    const epochCheckAt = ENTRY.indexOf("authorityEpochRef.current !== authorityEpoch");

    expect(epochCheckAt).toBeGreaterThan(awaitAt);
  });

  it("still validates the saved setup, then re-checks session, generation and pairing AFTER the await", () => {
    const awaitAt = ENTRY.indexOf("await loadOfflineFallback(");
    const checkAt = ENTRY.indexOf("offlineTransitionGenRef.current !== generation");

    expect(awaitAt).toBeGreaterThan(-1);
    expect(ENTRY).toContain("if (!fallback.ok) {\n        return;");
    expect(checkAt).toBeGreaterThan(awaitAt);
    for (const check of [
      "sessionUserIdRef.current !== sessionUserId",
      "livePairing.deviceId !== pairing.deviceId",
      "livePairing.buildJobId !== pairing.buildJobId",
      "fallback.pairing.deviceId !== pairing.deviceId",
      "previous.status !== \"ready\"",
      "if (previous.offline) {",
    ]) {
      expect(ENTRY).toContain(check);
    }
  });

  it("never writes the employee gate or the authority epoch", () => {
    for (const banned of ["setGate(", "gateRef.current =", "advanceAuthorityEpoch", "applyStartupLock"]) {
      expect(`${banned}: ${ENTRY.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("every state the reconnect path lands advances the transition generation first", () => {
    const setStates = (RECONNECT.match(/setState\(/g) ?? []).length;
    const bumps = (RECONNECT.match(/offlineTransitionGenRef\.current \+= 1;/g) ?? []).length;

    expect(setStates).toBe(4);
    expect(bumps).toBe(4);
    for (const at of [...RECONNECT.matchAll(/setState\(/g)].map((m) => m.index ?? 0)) {
      expect(RECONNECT.lastIndexOf("offlineTransitionGenRef.current += 1;", at)).toBeGreaterThan(
        RECONNECT.lastIndexOf("setState(", at - 1)
      );
    }
  });
});

describe("open and in-flight checkout", () => {
  it("the online dispatch refuses BEFORE sending once the till is offline, with the existing rolled-back shape", () => {
    const guardAt = COMPLETE.indexOf("if (offlineModeRef.current) {");
    const dispatchAt = COMPLETE.indexOf("await completeDeviceSaleV5(");

    expect(guardAt).toBeGreaterThan(COMPLETE.indexOf("verifySubmittedSale({"));
    expect(guardAt).toBeLessThan(dispatchAt);
    expect(COMPLETE.slice(guardAt, dispatchAt)).toContain("error: MODE_CHANGED_BEFORE_DISPATCH_MESSAGE");
    expect(COMPLETE.slice(guardAt, dispatchAt)).toContain("rolledBack: true");
    // Nothing after dispatch consults the mode: an in-flight sale keeps its identity.
    expect(COMPLETE.slice(dispatchAt)).not.toContain("offlineModeRef");
  });

  it("exact recovery and the authority token are untouched (single-Retry recovery after a lost reply still passes)", () => {
    expect(RECOVER).not.toContain("offlineModeRef");
    expect(AUTHORITY).toContain(
      "const authorityToken = [\n      currentGate.employee.employeeSessionId,\n      currentGate.daily.registerSessionId,\n      pairing.buildJobId,\n      String(authorityEpochRef.current),\n    ].join"
    );
  });

  it("the display-only live status indicator still controls nothing", () => {
    const authorityCode = [DERIVE, ENTRY, HINT, COMPLETE, RECOVER, AUTHORITY].join("\n");

    expect(authorityCode).not.toContain("LiveStatusIndicator");
    expect(authorityCode).not.toContain("serverReachability");
  });
});
