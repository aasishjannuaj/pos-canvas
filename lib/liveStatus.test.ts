// IND-1 — the indicator's pure decisions: policy constants, the classifier,
// connection precedence and freshness, and the saved-sale label.
import { describe, expect, it } from "vitest";
import {
  LIVE_CHECK_FAILURE_BACKOFF_MS,
  LIVE_CHECK_INTERVAL_MS,
  LIVE_CHECK_MIN_SPACING_MS,
  LIVE_CHECK_TIMEOUT_MS,
  LIVE_SUCCESS_FRESH_MS,
  classifyReachability,
  deriveConnectionView,
  deriveSalesView,
  nextConnectionExpiryAt,
  nextFailureDelayMs,
} from "@/lib/liveStatus";
import type { LiveEvidence, ReachabilityProbeResult } from "@/lib/liveStatus";
import type { OfflineSaleStatus } from "@/lib/offlineSaleStatus";

const DEVICE = "d0000000-0000-4000-8000-0000000000d1";
const OTHER = "d0000000-0000-4000-8000-0000000000d2";

function pairedBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paired: true,
    device_id: DEVICE,
    project_id: "b0000000-0000-4000-8000-0000000000b1",
    build_job_id: "c0000000-0000-4000-8000-0000000000c1",
    device_name: "Till",
    platform: "windows",
    created_at: "2026-10-17T00:00:00Z",
    revoked_at: null,
    active: true,
    update_available: false,
    offered_build_job_id: null,
    offered_at: null,
    cash_drawer_enabled: false,
    ...patch,
  };
}

const ok = (data: unknown, status = 200): ReachabilityProbeResult => ({
  type: "response",
  status,
  data,
  errorCode: null,
});

const err = (status: number, errorCode: string): ReachabilityProbeResult => ({
  type: "response",
  status,
  data: null,
  errorCode,
});

const classify = (result: ReachabilityProbeResult, onlineHint: boolean | null = true) =>
  classifyReachability(result, { onlineHint, expectedDeviceId: DEVICE });

describe("policy constants (Control Room IND-1)", () => {
  it("checks at most once per 5s, times out at 4s, backs off 5/10/20/30s, stays fresh 15s", () => {
    expect(LIVE_CHECK_INTERVAL_MS).toBe(5_000);
    expect(LIVE_CHECK_MIN_SPACING_MS).toBe(5_000);
    expect(LIVE_CHECK_TIMEOUT_MS).toBe(4_000);
    expect(LIVE_CHECK_TIMEOUT_MS).toBeLessThan(LIVE_CHECK_INTERVAL_MS);
    expect([...LIVE_CHECK_FAILURE_BACKOFF_MS]).toEqual([5_000, 10_000, 20_000, 30_000]);
    expect(LIVE_SUCCESS_FRESH_MS).toBe(15_000);
  });

  it("the failure backoff settles at 30s and clamps nonsense input", () => {
    expect([1, 2, 3, 4, 5, 50].map(nextFailureDelayMs)).toEqual([
      5_000, 10_000, 20_000, 30_000, 30_000, 30_000,
    ]);
    expect(nextFailureDelayMs(0)).toBe(5_000);
    expect(nextFailureDelayMs(-3)).toBe(5_000);
    expect(nextFailureDelayMs(Number.NaN)).toBe(5_000);
    expect(nextFailureDelayMs(Number.POSITIVE_INFINITY)).toBe(5_000);
  });
});

describe("classifyReachability", () => {
  it("ONLY this device, paired and active, in a clean 2xx is reachable", () => {
    expect(classify(ok(pairedBody()))).toBe("reachable");
    expect(classify(ok(pairedBody(), 201))).toBe("reachable");
  });

  it("no response: no network when the browser says offline, otherwise server unreachable", () => {
    for (const result of [{ type: "transport" }, { type: "timeout" }] as const) {
      expect(classify(result, false)).toBe("no_network");
      expect(classify(result, true)).toBe("unreachable");
      expect(classify(result, null)).toBe("unreachable");
    }

    expect(classify(err(0, ""), false)).toBe("no_network");
    expect(classify(err(0, ""), true)).toBe("unreachable");
  });

  it("a cancelled check is not evidence", () => {
    expect(classify({ type: "aborted" })).toBeNull();
  });

  it("server errors: 5xx, any error body, unexpected statuses", () => {
    for (const status of [500, 502, 503, 504, 520]) {
      expect(classify(err(status, "unknown"))).toBe("server_error");
      expect(classify(ok(pairedBody(), status))).toBe("server_error");
    }

    expect(classify(err(404, "PGRST202"))).toBe("server_error");
    expect(classify(err(400, "P0001"))).toBe("server_error");
    expect(classify(ok(pairedBody(), 204 + 100))).toBe("server_error");
    expect(classify(ok(pairedBody(), 199))).toBe("server_error");
  });

  it("sign-in problems: 401, 403, refused JWT codes, or not_authenticated", () => {
    expect(classify(err(401, "PGRST301"))).toBe("sign_in_problem");
    expect(classify(err(403, "42501"))).toBe("sign_in_problem");
    expect(classify(err(400, "PGRST302"))).toBe("sign_in_problem");
    expect(classify(ok({ paired: false, reason: "not_authenticated" }))).toBe("sign_in_problem");
  });

  it("device problems: not paired, unpaired, revoked, or a different device", () => {
    expect(classify(ok({ paired: false, reason: "not_paired" }))).toBe("device_problem");
    expect(classify(ok({ paired: false, reason: "unpaired" }))).toBe("device_problem");
    expect(classify(ok(pairedBody({ revoked_at: "2026-10-17T01:00:00Z", active: false })))).toBe(
      "device_problem"
    );
    expect(classify(ok(pairedBody({ device_id: OTHER })))).toBe("device_problem");
  });

  it("malformed or unexpected bodies are NEVER reachable", () => {
    const bodies: unknown[] = [
      null,
      undefined,
      "ok",
      42,
      [],
      [pairedBody()],
      {},
      { paired: "true" },
      { paired: true },
      pairedBody({ device_id: 7 }),
      pairedBody({ project_id: null }),
    ];

    for (const body of bodies) {
      expect(classify(ok(body))).not.toBe("reachable");
    }

    expect(classify(ok({}))).toBe("server_error");
    expect(classify({ type: "response", status: Number.NaN, data: pairedBody(), errorCode: null })).not.toBe(
      "reachable"
    );
  });
});

describe("deriveConnectionView", () => {
  const at = 1_000_000;
  const ev = (outcome: LiveEvidence["outcome"], when = at): LiveEvidence => ({ outcome, at: when });

  it("no current evidence (start-up, resume, new pairing) is Checking, whatever the runtime mode says", () => {
    for (const runtimeMode of ["online", "offline"] as const) {
      expect(deriveConnectionView({ now: at, evidence: null, runtimeMode }).label).toBe("Checking");
    }
  });

  it("a fresh success while the device is online is Online", () => {
    const view = deriveConnectionView({ now: at + 1_000, evidence: ev("reachable"), runtimeMode: "online" });

    expect(view).toEqual({ label: "Online", detail: "Connected", tone: "ok" });
  });

  it("a fresh success while the device is still in offline mode is Checking (reconnecting), never Online", () => {
    const view = deriveConnectionView({ now: at, evidence: ev("reachable"), runtimeMode: "offline" });

    expect(view.label).toBe("Checking");
    expect(view.detail).toBe("Server reachable — reconnecting");
  });

  it("freshness expires: Online at 15s, Checking just after", () => {
    expect(
      deriveConnectionView({ now: at + LIVE_SUCCESS_FRESH_MS, evidence: ev("reachable"), runtimeMode: "online" })
        .label
    ).toBe("Online");
    expect(
      deriveConnectionView({ now: at + LIVE_SUCCESS_FRESH_MS + 1, evidence: ev("reachable"), runtimeMode: "online" })
        .label
    ).toBe("Checking");
  });

  it("a known failure is shown however old it is (it beats a stale-success Checking)", () => {
    const old = at - 10 * 60_000;
    const cases = [
      ["no_network", "Offline", "No network"],
      ["unreachable", "Offline", "Server unreachable"],
      ["server_error", "Server error", "POS Canvas is not responding normally"],
      ["sign_in_problem", "Sign-in problem", "This till's sign-in was refused"],
      ["device_problem", "Device problem", "This till is not recognised as active"],
    ] as const;

    for (const [outcome, label, detail] of cases) {
      for (const runtimeMode of ["online", "offline"] as const) {
        const view = deriveConnectionView({ now: at, evidence: ev(outcome, old), runtimeMode });

        expect(view.label).toBe(label);
        expect(view.detail).toBe(detail);
        expect(view.tone).not.toBe("ok");
      }
    }
  });

  it("the expiry instant is exactly when Online would turn to Checking; failures never expire", () => {
    const expiry = nextConnectionExpiryAt(ev("reachable"));

    expect(expiry).toBe(at + LIVE_SUCCESS_FRESH_MS + 1);
    expect(deriveConnectionView({ now: expiry!, evidence: ev("reachable"), runtimeMode: "online" }).label).toBe(
      "Checking"
    );
    expect(deriveConnectionView({ now: expiry! - 1, evidence: ev("reachable"), runtimeMode: "online" }).label).toBe(
      "Online"
    );
    expect(nextConnectionExpiryAt(null)).toBeNull();
    expect(nextConnectionExpiryAt(ev("unreachable"))).toBeNull();
  });
});

describe("deriveSalesView", () => {
  function status(patch: Partial<OfflineSaleStatus> = {}): OfflineSaleStatus {
    return {
      waiting: 0,
      needsAttention: 0,
      synced: 0,
      unsynced: 0,
      total: 0,
      nextRetryAt: null,
      uncertainOnlineSale: false,
      evidenceReadable: true,
      ...patch,
    };
  }

  const label = (s: OfflineSaleStatus, loaded = true, syncing = false) =>
    deriveSalesView({ status: s, loaded, syncing }).label;

  it("every label, in precedence order", () => {
    expect(label(status(), false)).toBe("Checking sales");
    expect(label(status({ evidenceReadable: false }))).toBe("Can't check sales");
    expect(label(status({ uncertainOnlineSale: true }))).toBe("Sale unconfirmed");
    expect(label(status({ needsAttention: 1, unsynced: 1 }))).toBe("Needs attention");
    expect(label(status(), true, true)).toBe("Syncing");
    expect(label(status({ waiting: 1, unsynced: 1 }))).toBe("1 sale waiting");
    expect(label(status({ waiting: 3, unsynced: 3 }))).toBe("3 sales waiting");
    expect(label(status())).toBe("No pending sales");
  });

  it("higher-priority facts win over lower ones", () => {
    expect(label(status({ evidenceReadable: false, uncertainOnlineSale: true }), false)).toBe("Checking sales");
    expect(label(status({ evidenceReadable: false, uncertainOnlineSale: true, needsAttention: 2 }))).toBe(
      "Can't check sales"
    );
    expect(label(status({ uncertainOnlineSale: true, needsAttention: 2, waiting: 4 }), true, true)).toBe(
      "Sale unconfirmed"
    );
    expect(label(status({ needsAttention: 1, waiting: 4, unsynced: 5 }), true, true)).toBe("Needs attention");
    expect(label(status({ waiting: 4, unsynced: 4 }), true, true)).toBe("Syncing");
  });

  it("'Sale unconfirmed' never claims recovery is running", () => {
    const view = deriveSalesView({ status: status({ uncertainOnlineSale: true }), loaded: true, syncing: false });

    expect(view.label).toBe("Sale unconfirmed");
    expect(view.label.toLowerCase()).not.toContain("confirming");
  });

  it("NEVER 'No pending sales' while anything unsynced or uncertain remains, or before a read", () => {
    const risky: OfflineSaleStatus[] = [
      status({ unsynced: 1 }),
      status({ waiting: 1 }),
      status({ needsAttention: 1 }),
      status({ uncertainOnlineSale: true }),
      status({ evidenceReadable: false }),
      status({ unsynced: 2, waiting: 0, needsAttention: 0 }),
    ];

    for (const s of risky) {
      for (const syncing of [false, true]) {
        expect(label(s, true, syncing)).not.toBe("No pending sales");
      }
    }

    expect(label(status(), false)).not.toBe("No pending sales");
    // A record that is unsynced but neither waiting nor needing attention still counts.
    expect(label(status({ unsynced: 2 }))).toBe("2 sales waiting");
  });
});
