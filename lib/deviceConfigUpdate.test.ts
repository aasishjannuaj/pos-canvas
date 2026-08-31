// Feature 26.2 — the till-side half of the configuration update.
//
// WHAT IS PROVED HERE. The safety decision and the RPC parser are pure, so they
// are tested directly and exhaustively. The wiring in DeviceApp — that a
// successful apply clears the cache before refreshing, that a second press
// while one is in flight does nothing — has no DOM harness in this repo and is
// asserted structurally against the source, the same way every other device
// component in this codebase is.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  APPLY_BLOCKED_CART_MESSAGE,
  APPLY_BLOCKED_CART_UNREADABLE_MESSAGE,
  APPLY_BLOCKED_OFFLINE_MESSAGE,
  decideApplyUpdateSafety,
} from "@/lib/deviceConfigUpdate";
import { parseApplyConfigUpdate } from "@/lib/device.rpc";
import {
  APPLYING_UPDATE_LABEL,
  APPLY_UPDATE_ACTION,
  UPDATE_AVAILABLE_EXPLANATION,
  UPDATE_AVAILABLE_HEADING,
} from "@/components/device/DeviceSettingsScreen";
import {
  NO_UPDATE_OFFER,
  parsePairingState,
  parseUpdateOffer,
} from "@/lib/deviceSession";
import type { OfflineSaleStatus } from "@/lib/offlineSaleStatus";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** Strips comments, so prose can never satisfy a source assertion. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/**
 * A queue with nothing outstanding.
 *
 * Built from the SAME shape the production reader returns, field for field. A
 * partial literal here would let a test pass against a status object the real
 * store never produces.
 */
const SAFE_STATUS: OfflineSaleStatus = {
  waiting: 0,
  needsAttention: 0,
  synced: 3,
  unsynced: 0,
  total: 3,
  nextRetryAt: null,
  uncertainOnlineSale: false,
};

const PAIRED_PAYLOAD = {
  paired: true,
  device_id: "11111111-1111-4111-8111-111111111111",
  project_id: "22222222-2222-4222-8222-222222222222",
  build_job_id: "33333333-3333-4333-8333-333333333333",
  device_name: "Till 1",
  platform: "android",
  created_at: "2026-08-01T10:00:00Z",
  revoked_at: null,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

describe("reading the offer off the pairing response", () => {
  it("parses update_available true with its build and timestamp", () => {
    const result = parsePairingState({
      ...PAIRED_PAYLOAD,
      update_available: true,
      offered_build_job_id: "44444444-4444-4444-8444-444444444444",
      offered_at: "2026-09-04T09:12:00Z",
    });

    expect(result.paired).toBe(true);

    if (!result.paired) {
      return;
    }

    expect(result.offer).toEqual({
      updateAvailable: true,
      offeredBuildJobId: "44444444-4444-4444-8444-444444444444",
      offeredAt: "2026-09-04T09:12:00Z",
    });

    // THE PROPERTY THAT MATTERS: the pin did not move.
    expect(result.pairing.buildJobId).toBe(PAIRED_PAYLOAD.build_job_id);
  });

  it("defaults to no update when the server never sends the keys", () => {
    const result = parsePairingState(PAIRED_PAYLOAD);

    expect(result.paired).toBe(true);
    expect(result.paired && result.offer).toEqual(NO_UPDATE_OFFER);
  });

  it("refuses an update_available with no offered build", () => {
    // The server never sends this pair. Believing it would render an Apply
    // button that cannot possibly work.
    expect(parseUpdateOffer({ update_available: true })).toEqual(NO_UPDATE_OFFER);
    expect(
      parseUpdateOffer({ update_available: true, offered_build_job_id: "" })
    ).toEqual(NO_UPDATE_OFFER);
  });

  it("ignores a non-boolean update_available", () => {
    expect(
      parseUpdateOffer({
        update_available: "true",
        offered_build_job_id: "44444444-4444-4444-8444-444444444444",
      })
    ).toEqual(NO_UPDATE_OFFER);
  });

  it("offers nothing to a revoked device, whatever the payload claims", () => {
    const result = parsePairingState({
      ...PAIRED_PAYLOAD,
      revoked_at: "2026-09-01T00:00:00Z",
      update_available: true,
      offered_build_job_id: "44444444-4444-4444-8444-444444444444",
    });

    expect(result.paired && result.active).toBe(false);
    expect(result.paired && result.offer).toEqual(NO_UPDATE_OFFER);
  });

  it("never lets an offer become the active config", () => {
    // decidePairingState routes on `active` alone. An offer cannot reach it,
    // and get_device_config is what supplies the config regardless.
    const source = code(read("lib/deviceSession.ts"));
    const decide = source.slice(source.indexOf("export function decidePairingState"));

    expect(decide.slice(0, decide.indexOf("\n}"))).not.toContain("offer");
  });
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

describe("the local safety decision", () => {
  it("blocks on a non-empty cart, before anything else", () => {
    const decision = decideApplyUpdateSafety({
      cartLineCount: 1,
      saleStatus: SAFE_STATUS,
      onlineHint: true,
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "cart",
      message: APPLY_BLOCKED_CART_MESSAGE,
    });
  });

  it("blocks an empty cart holding unsynced sales", () => {
    const decision = decideApplyUpdateSafety({
      cartLineCount: 0,
      saleStatus: { ...SAFE_STATUS, waiting: 2, unsynced: 2, total: 5 },
      onlineHint: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe("unresolved_sales");
    // The count comes from decideDeviceResetSafety's own message, not a copy.
    expect(decision.allowed === false && decision.message).toContain("2 sales");
  });

  it("blocks on an unresolved online sale even with an empty queue", () => {
    const decision = decideApplyUpdateSafety({
      cartLineCount: 0,
      saleStatus: { ...SAFE_STATUS, uncertainOnlineSale: true },
      onlineHint: true,
    });

    expect(decision.allowed === false && decision.reason).toBe("unresolved_sales");
  });

  it("blocks on sales that need attention", () => {
    const decision = decideApplyUpdateSafety({
      cartLineCount: 0,
      saleStatus: { ...SAFE_STATUS, needsAttention: 1, unsynced: 1, total: 4 },
      onlineHint: true,
    });

    expect(decision.allowed === false && decision.reason).toBe("unresolved_sales");
  });

  it("blocks a device the browser is sure is offline", () => {
    expect(
      decideApplyUpdateSafety({
        cartLineCount: 0,
        saleStatus: SAFE_STATUS,
        onlineHint: false,
      })
    ).toEqual({
      allowed: false,
      reason: "offline",
      message: APPLY_BLOCKED_OFFLINE_MESSAGE,
    });
  });

  it("allows an empty cart, a clean queue and a connection", () => {
    expect(
      decideApplyUpdateSafety({
        cartLineCount: 0,
        saleStatus: SAFE_STATUS,
        onlineHint: true,
      })
    ).toEqual({ allowed: true });
  });

  it("proceeds when the host cannot say whether it is online", () => {
    // null is not a refusal: navigator.onLine is worth nothing as permission,
    // and the transport is the real authority.
    expect(
      decideApplyUpdateSafety({
        cartLineCount: 0,
        saleStatus: SAFE_STATUS,
        onlineHint: null,
      })
    ).toEqual({ allowed: true });
  });

  it("REFUSES when the live cart cannot be read at all", () => {
    // The single most important coercion this module does not do: unknown is
    // not empty. A `?? 0` here would authorize a repin over an open cart.
    expect(
      decideApplyUpdateSafety({
        cartLineCount: null,
        saleStatus: SAFE_STATUS,
        onlineHint: true,
      })
    ).toEqual({
      allowed: false,
      reason: "cart_unreadable",
      message: APPLY_BLOCKED_CART_UNREADABLE_MESSAGE,
    });
  });

  it("reports the cart first when a till is unsafe in several ways at once", () => {
    const decision = decideApplyUpdateSafety({
      cartLineCount: 3,
      saleStatus: { ...SAFE_STATUS, unsynced: 1, waiting: 1 },
      onlineHint: false,
    });

    expect(decision.allowed === false && decision.reason).toBe("cart");
  });

  it("words the money refusal for Apply, not for Reset", () => {
    // The shared rule is right; the shared SENTENCE is not. decideDeviceResetSafety
    // ends "...before resetting this device", which would tell an operator who
    // pressed Apply update to reset their till instead.
    const decision = decideApplyUpdateSafety({
      cartLineCount: 0,
      saleStatus: { ...SAFE_STATUS, waiting: 1, unsynced: 1, total: 4 },
      onlineHint: true,
    });

    const message = decision.allowed === false ? decision.message : "";

    expect(message).toContain("1 sale");
    expect(message).toContain("applying this update");
    expect(message.toLowerCase()).not.toContain("reset");
    expect(message.toLowerCase()).not.toContain("unpair");
  });

  it("words the uncertain-sale refusal for Apply too", () => {
    const decision = decideApplyUpdateSafety({
      cartLineCount: 0,
      saleStatus: { ...SAFE_STATUS, uncertainOnlineSale: true },
      onlineHint: true,
    });

    const message = decision.allowed === false ? decision.message : "";

    expect(message).toContain("applying this update");
    expect(message.toLowerCase()).not.toContain("reset");
  });

  it("takes the DECISION from decideDeviceResetSafety even so", () => {
    const source = code(read("lib/deviceConfigUpdate.ts"));

    // The rule is called and its `allowed` is what gates. Only the wording is
    // local, and describeApplyBlockedBySales must not re-decide anything.
    expect(source).toContain("decideDeviceResetSafety(input.saleStatus)");
    expect(source).toContain("if (!financial.allowed)");

    const wording = source.slice(
      source.indexOf("export function describeApplyBlockedBySales"),
      source.indexOf("export function decideApplyUpdateSafety")
    );

    expect(wording).not.toContain("allowed");
  });

  it("reuses decideDeviceResetSafety rather than restating its rule", () => {
    const source = code(read("lib/deviceConfigUpdate.ts"));

    expect(source).toContain("decideDeviceResetSafety(input.saleStatus)");
    // No second opinion about what counts as financially unsafe.
    expect(source).not.toContain("unsynced >");
  });
});

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

describe("the apply wrapper", () => {
  it("calls the RPC with ZERO arguments", () => {
    const source = code(read("lib/device.rpc.ts"));

    expect(source).toContain('rpc("apply_device_config_update")');
    // A second argument would be a caller-supplied id, which the whole design
    // exists to make impossible.
    expect(source).not.toMatch(/rpc\("apply_device_config_update",/);
  });

  it("reads a success and reports both builds", () => {
    expect(
      parseApplyConfigUpdate({
        ok: true,
        device_id: "d",
        project_id: "p",
        build_job_id: "new-build",
        previous_build_job_id: "old-build",
      })
    ).toEqual({ ok: true, buildJobId: "new-build", previousBuildJobId: "old-build" });
  });

  it("treats a success with no build id as unreadable, never as success", () => {
    expect(parseApplyConfigUpdate({ ok: true })).toEqual({
      ok: false,
      retryable: false,
      error: "unreadable",
    });
  });

  for (const error of [
    "not_authenticated",
    "not_paired",
    "no_update_offered",
    "offer_unusable",
  ] as const) {
    it(`carries the server's ${error} through unchanged`, () => {
      expect(parseApplyConfigUpdate({ ok: false, error })).toEqual({
        ok: false,
        retryable: false,
        error,
      });
    });
  }

  it("does not retry a refusal", () => {
    const parsed = parseApplyConfigUpdate({ ok: false, error: "no_update_offered" });

    expect(parsed.ok === false && parsed.retryable).toBe(false);
  });

  it("maps an unknown error code to unreadable", () => {
    expect(parseApplyConfigUpdate({ ok: false, error: "something_new" })).toEqual({
      ok: false,
      retryable: false,
      error: "unreadable",
    });
  });

  for (const payload of [null, undefined, "ok", 42, []]) {
    it(`refuses the non-object payload ${JSON.stringify(payload)}`, () => {
      expect(parseApplyConfigUpdate(payload)).toEqual({
        ok: false,
        retryable: false,
        error: "unreadable",
      });
    });
  }

  it("separates transport failure from server rejection", () => {
    const source = code(read("lib/device.rpc.ts"));
    const wrapper = source.slice(
      source.indexOf("export async function applyDeviceConfigUpdate"),
      source.indexOf("export function parseApplyConfigUpdate")
    );

    expect(wrapper).toContain("classifyDeviceFailure");
    expect(wrapper).toContain('retryable: true, error: "transport"');
  });

  it("changes nothing locally — it only returns", () => {
    const source = code(read("lib/device.rpc.ts"));
    const wrapper = source.slice(
      source.indexOf("export async function applyDeviceConfigUpdate"),
      source.indexOf("export function parseApplyConfigUpdate")
    );

    expect(wrapper).not.toContain("clearOfflineCache");
    expect(wrapper).not.toContain("persistDeviceCache");
    expect(wrapper).not.toContain("setState");
  });
});

// ---------------------------------------------------------------------------
// The apply flow, asserted against DeviceApp's source
// ---------------------------------------------------------------------------

describe("the apply flow in DeviceApp", () => {
  const app = code(read("components/device/DeviceApp.tsx"));
  const handler = app.slice(
    app.indexOf("async function handleApplyUpdate"),
    app.indexOf("async function handleReset")
  );

  it("exists, and is reached from the settings screen", () => {
    expect(handler.length).toBeGreaterThan(0);
    expect(app).toContain("onApplyUpdate={() => void handleApplyUpdate()}");
  });

  it("latches concurrent applies on a REF, not on React state", () => {
    // THIS TEST USED TO ASSERT `if (applyingUpdate)` AND PASSED while five taps
    // in one tick fired five requests on staging. React state is not written
    // synchronously, so every tap in the same tick read the same stale `false`.
    // The guard has to be something that updates the instant it is set.
    expect(handler).toContain("if (applyingUpdateRef.current)");
    expect(handler).toContain("applyingUpdateRef.current = true;");
    expect(handler).not.toContain("if (applyingUpdate)");

    // Claimed before the safety read, so every early exit has to release it.
    const claimAt = handler.indexOf("applyingUpdateRef.current = true;");
    const refusalRelease = handler.indexOf(
      "applyingUpdateRef.current = false;",
      claimAt
    );

    expect(refusalRelease).toBeGreaterThan(claimAt);
    expect(handler.match(/applyingUpdateRef\.current = false;/g)).toHaveLength(2);
    expect(handler).toContain("} finally {");

    // The state remains, but only to drive the button.
    expect(app).toContain("applying={applyingUpdate}");
  });

  it("re-reads durable storage rather than trusting React state", () => {
    expect(handler).toContain("await readOfflineSaleStatus()");
    expect(handler).toContain("decideApplyUpdateSafety");
  });

  it("authorizes on the LIVE cart ref, and no mirror exists to reach for", () => {
    expect(handler).toContain("liveCartLineCountRef.current");
    expect(handler).toContain("cartLineCount: liveCartLineCount,");

    // There is no mirrored cart count in this component at all. A passive-effect
    // copy sitting beside the ref is what a later edit would reach for by
    // mistake, so it was removed rather than kept "for rendering".
    expect(app).not.toContain("setCartLineCount");
    expect(app).not.toContain("onCartLineCountChange");
  });

  it("reads the live cart BEFORE it awaits anything", () => {
    const cartAt = handler.indexOf("liveCartLineCountRef.current");
    const firstAwait = handler.indexOf("await ");

    expect(cartAt).toBeGreaterThan(-1);
    expect(cartAt).toBeLessThan(firstAwait);
  });

  it("reads the queue fresh at Apply time, not the rendered status", () => {
    const readAt = handler.indexOf("await readOfflineSaleStatus()");
    const decisionAt = handler.indexOf("decideApplyUpdateSafety");

    // The durable read happens in THIS handler and feeds THIS decision, so a
    // queue that changed since Device settings opened is seen.
    expect(readAt).toBeGreaterThan(-1);
    expect(decisionAt).toBeGreaterThan(readAt);
    expect(handler).toContain("saleStatus: status,");
    // Never the rendered copy.
    expect(handler).not.toContain("saleStatus: saleStatus");
    expect(handler).not.toContain("saleStatus,");
  });

  it("decides BEFORE the RPC, and returns without calling it when refused", () => {
    const decisionAt = handler.indexOf("decideApplyUpdateSafety");
    const refusalAt = handler.indexOf("if (!safety.allowed)");
    const rpcAt = handler.indexOf("applyDeviceConfigUpdate()");

    expect(decisionAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeGreaterThan(decisionAt);
    expect(rpcAt).toBeGreaterThan(refusalAt);

    // THE ASSERTION THAT MATTERS. Ordering alone proves nothing: a refusal
    // branch that sets a message and falls through would still be "before" the
    // RPC and would still call it. The branch has to LEAVE.
    const refusalBranch = handler.slice(refusalAt, rpcAt);

    expect(refusalBranch).toContain("return;");
  });

  it("clears the stale cache BEFORE refreshing, and only after success", () => {
    const successAt = handler.indexOf("if (!applied.ok)");
    const clearAt = handler.indexOf("await clearOfflineCache()");
    const refreshAt = handler.lastIndexOf("await resolveDeviceState()");

    expect(successAt).toBeGreaterThan(-1);
    // The clear is inside the success path, not before the RPC.
    expect(clearAt).toBeGreaterThan(successAt);
    expect(refreshAt).toBeGreaterThan(clearAt);
  });

  it("reloads through the authoritative path, not a locally built config", () => {
    expect(handler).toContain("await resolveDeviceState()");
    // Nothing here fabricates a config or writes a pin.
    expect(handler).not.toContain("setState({ status: \"ready\"");
    expect(handler).not.toContain("buildJobId:");
    expect(handler).not.toContain("persistDeviceCache");
  });

  it("sends an unrecognized device into the existing lifecycle path", () => {
    expect(handler).toContain('applied.error === "not_paired"');
    expect(handler).toContain('applied.error === "not_authenticated"');
  });

  it("treats a withdrawn offer truthfully and refreshes state", () => {
    expect(handler).toContain('applied.error === "no_update_offered"');
    expect(handler).toContain('applied.error === "offer_unusable"');
    expect(handler).toContain("OFFER_WITHDRAWN_MESSAGE");
  });

  it("marks the till as mid-update so a failed reload says so", () => {
    expect(handler).toContain("setUpdateReloadPending(true)");
    expect(app).toContain("APPLY_RELOAD_FAILED_MESSAGE");
    // Both blocking screens, so neither can quietly sell.
    expect(app).toContain("updateReloadPending ? \"Finish updating\"");
  });

  it("clears the mid-update flag only on an authoritative ready", () => {
    const resolve = app.slice(
      app.indexOf("const resolveDeviceState = useCallback"),
      app.indexOf("async function handleApplyUpdate")
    );

    expect(resolve).toContain("setUpdateReloadPending(false)");
    expect(resolve).toContain('if (resolved.status === "ready")');
  });

  it("records the offer from the authoritative response only", () => {
    expect(app).toContain(
      "setUpdateOffer(\n        pairingState.state.paired ? pairingState.state.offer : NO_UPDATE_OFFER\n      );"
    );
  });

  it("hides Apply on an offline runtime, which could not apply anyway", () => {
    expect(app).toContain("updateAvailable={updateOffer.updateAvailable && !offlineMode}");
  });
});

// ---------------------------------------------------------------------------
// The cart signal
// ---------------------------------------------------------------------------

describe("the cart signal", () => {
  const runtime = code(read("components/runtime/PosRuntime.tsx"));

  it("publishes the live count from a LAYOUT effect, inside the commit", () => {
    // A passive effect runs after paint, which leaves a window where the host
    // sees an empty cart that is no longer empty. A layout effect is flushed
    // synchronously in the commit, before the next click can be dispatched.
    expect(runtime).toContain("useLayoutEffect(() => {");
    expect(runtime).toContain("cartLineCountRef.current = cart.length;");

    const layoutAt = runtime.indexOf("useLayoutEffect(() => {");
    const body = runtime.slice(layoutAt, runtime.indexOf("});", layoutAt) + 3);

    // No dependency array: correct after EVERY commit, with no claim about
    // which renders can change it.
    expect(body).not.toMatch(/\}\s*,\s*\[/);
  });

  it("nulls the live count when the runtime unmounts", () => {
    expect(runtime).toContain("cartLineCountRef.current = null;");
  });

  it("publishes exactly one cart signal, not two", () => {
    // One writer, one reader, one meaning. The earlier passive mirror was
    // removed once the layout-effect ref made it redundant.
    expect(runtime).not.toContain("onCartLineCountChange");
    expect(runtime.match(/cartLineCountRef\.current = /g)).toHaveLength(2);
  });

  it("hands DeviceApp the ref, not just the mirror", () => {
    expect(code(read("components/device/DeviceApp.tsx"))).toContain(
      "cartLineCountRef={liveCartLineCountRef}"
    );
  });

  it("is optional, so the owner runtime and preview are unaffected", () => {
    expect(runtime).toContain("cartLineCountRef?: MutableRefObject<number | null>;");
    expect(code(read("components/runtime/OwnerPosRuntime.tsx"))).not.toContain(
      "cartLineCountRef"
    );
  });
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

describe("the settings UI", () => {
  const screen = code(read("components/device/DeviceSettingsScreen.tsx"));

  it("renders nothing when there is no update", () => {
    expect(screen).toContain("{updateAvailable && (");
  });

  it("shows no internal identifiers to the operator", () => {
    expect(screen).not.toContain("offeredBuildJobId");
    expect(screen).not.toContain("buildJobId");
  });

  it("talks about the menu, not about software", () => {
    // Asserted against the strings an operator actually reads. Checking the
    // whole file would fail on the comment above them explaining why this is
    // NOT a software update — prose is not copy.
    const operatorCopy = [
      UPDATE_AVAILABLE_HEADING,
      UPDATE_AVAILABLE_EXPLANATION,
      APPLY_UPDATE_ACTION,
      APPLYING_UPDATE_LABEL,
    ]
      .join(" ")
      .toLowerCase();

    expect(UPDATE_AVAILABLE_HEADING).toBe("Menu update");

    for (const word of ["download", "install", "version", "firmware", "restart"]) {
      expect(operatorCopy).not.toContain(word);
    }

    expect(operatorCopy).toContain("menu");
    expect(operatorCopy).toContain("prices");
  });

  it("disables the button while a request is in flight", () => {
    expect(screen).toContain("disabled={applying}");
    expect(screen).toContain("aria-busy={applying}");
  });
});
