// Feature 26.5 — the till asks whether an update has been offered to it.
//
// WHY THE FEATURE EXISTS, recorded here because it is the thing a future reader
// will want: `updateOffer` is written in exactly two places, resolveDeviceState
// and returnOnlineFromReconnect. A till already running therefore holds the
// answer it captured at launch, and an owner offering an update mid-shift
// changes nothing the device can see until a relaunch, a reconnect, or a sale
// rejected in a way that looks like lost authorization. Staging saw exactly
// that. This button is the missing third writer.
//
// WHAT IS PROVED WHERE. The outcome copy is pure and tested directly. The
// handler has no DOM in this repository, so its boundaries — reuses the 26.2
// fetch, never applies, never moves the pin, never unmounts the POS — are
// asserted against source, the same split every device feature here uses.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CHECK_FAILED_MESSAGE,
  CHECK_OFFLINE_MESSAGE,
  CHECK_UP_TO_DATE_MESSAGE,
  describeCheckForUpdatesResult,
} from "@/lib/deviceConfigUpdate";
import {
  CHECKING_FOR_UPDATES_LABEL,
  CHECK_FOR_UPDATES_ACTION,
} from "@/components/device/DeviceSettingsScreen";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** Strips comments, so prose can never satisfy a source assertion. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const app = code(read("components/device/DeviceApp.tsx"));
const screen = code(read("components/device/DeviceSettingsScreen.tsx"));

/** The check handler alone. */
const handler = app.slice(
  app.indexOf("async function handleCheckForUpdates"),
  app.indexOf("async function handleApplyUpdate")
);

/** The apply handler, so 26.2's guarantees can be shown intact. */
const applyHandler = app.slice(
  app.indexOf("async function handleApplyUpdate"),
  app.indexOf("async function handleReset")
);

// ---------------------------------------------------------------------------
// What the operator is told
// ---------------------------------------------------------------------------

describe("describeCheckForUpdatesResult", () => {
  it("says the device is up to date when nothing is offered", () => {
    expect(describeCheckForUpdatesResult("up_to_date")).toBe(CHECK_UP_TO_DATE_MESSAGE);
    expect(CHECK_UP_TO_DATE_MESSAGE).toBe("This device is up to date.");
  });

  it("says a connection is needed when offline", () => {
    expect(describeCheckForUpdatesResult("offline")).toBe(CHECK_OFFLINE_MESSAGE);
    expect(CHECK_OFFLINE_MESSAGE).toContain("internet connection");
  });

  it("offers a retry, and says the menu is unchanged, on failure", () => {
    expect(describeCheckForUpdatesResult("failed")).toBe(CHECK_FAILED_MESSAGE);
    expect(CHECK_FAILED_MESSAGE).toContain("still using its current menu");
    expect(CHECK_FAILED_MESSAGE).toContain("Try again");
  });

  it("says NOTHING when an update was found — the card is the answer", () => {
    expect(describeCheckForUpdatesResult("update_found")).toBeNull();
  });

  it("leaks no transport or database vocabulary", () => {
    const all = [
      CHECK_UP_TO_DATE_MESSAGE,
      CHECK_OFFLINE_MESSAGE,
      CHECK_FAILED_MESSAGE,
    ].join(" ");

    for (const leak of ["postgres", "supabase", "rpc", "PGRST", "fetch", "500"]) {
      expect(all.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("talks about the menu, not about software", () => {
    const operatorCopy = [
      CHECK_FOR_UPDATES_ACTION,
      CHECKING_FOR_UPDATES_LABEL,
      CHECK_UP_TO_DATE_MESSAGE,
    ]
      .join(" ")
      .toLowerCase();

    for (const word of ["download", "install", "version", "firmware", "restart"]) {
      expect(operatorCopy).not.toContain(word);
    }
  });
});

// ---------------------------------------------------------------------------
// It refreshes the real state
// ---------------------------------------------------------------------------

describe("the check re-reads the one source of truth", () => {
  it("uses the SAME pairing fetch the startup path uses", () => {
    expect(handler).toContain("await fetchDevicePairingState()");
    // No second source of truth, and nothing invented locally.
    expect(handler).not.toContain("fetch(");
    expect(handler).not.toContain("supabase");
  });

  it("writes the offer from that response, making it the third writer", () => {
    expect(handler).toContain("setUpdateOffer(result.state.offer)");

    // The two existing writers are still there and still untouched.
    expect(app.match(/setUpdateOffer\(/g)?.length).toBe(3);
  });

  it("reports found or up-to-date from the server's own flag", () => {
    expect(handler).toContain(
      'result.state.offer.updateAvailable ? "update_found" : "up_to_date"'
    );
  });

  it("does NOT unmount the POS — no `checking`, no resolveDeviceState on success", () => {
    // resolveDeviceState begins by setting status `checking`, which destroys
    // the cashier's cart. A button tapped mid-order must never do that.
    expect(handler).not.toContain('setState({ status: "checking" })');

    // The one resolveDeviceState call is the not-paired branch, and it is
    // reached only after `!result.state.paired`.
    const notPairedAt = handler.indexOf("if (!result.state.paired)");
    const resolveAt = handler.indexOf("await resolveDeviceState()");

    expect(notPairedAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(notPairedAt);
    expect(handler.match(/resolveDeviceState\(\)/g)).toHaveLength(1);
  });

  it("blocks before the request when the browser is sure it is offline", () => {
    const hintAt = handler.indexOf("readOnlineHint() === false");
    const fetchAt = handler.indexOf("await fetchDevicePairingState()");

    expect(hintAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(hintAt);
    expect(handler.slice(hintAt, fetchAt)).toContain('setCheckOutcome("offline")');
    expect(handler.slice(hintAt, fetchAt)).toContain("return;");
  });

  it("treats any unsuccessful fetch as one sanitized failure", () => {
    expect(handler).toContain("if (!result.ok)");
    expect(handler).toContain('setCheckOutcome("failed")');
    // The failure KIND is never surfaced to the operator.
    expect(handler).not.toContain("result.failure");
  });

  it("catches a throw rather than stranding the button", () => {
    expect(handler).toContain("} catch {");
    expect(handler).toContain("} finally {");
    expect(handler).not.toMatch(/catch\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// It discovers; it does not act
// ---------------------------------------------------------------------------

describe("the check cannot change what this till sells", () => {
  it("never calls apply_device_config_update", () => {
    expect(handler).not.toContain("applyDeviceConfigUpdate");
    expect(handler).not.toContain("apply_device_config_update");
  });

  it("never moves the pinned build", () => {
    expect(handler).not.toContain("buildJobId");
    expect(handler).not.toContain("build_job_id");
    // Nothing here fabricates a ready state or a config.
    expect(handler).not.toContain('status: "ready"');
    expect(handler).not.toContain("config:");
  });

  it("never touches the durable cache", () => {
    expect(handler).not.toContain("clearOfflineCache");
    expect(handler).not.toContain("persistDeviceCache");
    expect(handler).not.toContain("fetchDeviceConfig");
  });

  it("never creates an offer — that is the owner's action", () => {
    expect(handler).not.toContain("offerDeviceUpdate");
    expect(handler).not.toContain("offer_device_config_update");
  });

  it("adds no polling, interval, subscription or background refresh", () => {
    for (const banned of [
      "setInterval",
      "setTimeout",
      "requestAnimationFrame",
      ".subscribe(",
      "realtime",
      "EventSource",
      "WebSocket",
    ]) {
      expect(handler).not.toContain(banned);
    }
    // And none were smuggled into the screen either.
    expect(screen).not.toContain("setInterval");
    expect(screen).not.toContain("useEffect");
  });

  it("reaches no database directly and uses no service role", () => {
    for (const source of [handler, screen]) {
      expect(source).not.toContain(".rpc(");
      expect(source).not.toContain(".from(");
      expect(source).not.toContain("createClient");
      expect(source).not.toContain("service_role");
      expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("repeated taps make one logical check", () => {
  it("latches on a REF, claimed synchronously", () => {
    // React state is not written synchronously — 26.2, 26.3 and 26.4 each
    // shipped or nearly shipped that hole. Same-tick taps must lose.
    expect(handler).toContain("if (checkingRef.current || applyingUpdateRef.current)");
    expect(handler).toContain("checkingRef.current = true;");
    expect(handler).not.toContain("if (checkingForUpdates)");
  });

  it("returns before any request when the latch is held", () => {
    const guardAt = handler.indexOf("checkingRef.current ||");
    const fetchAt = handler.indexOf("await fetchDevicePairingState()");

    expect(guardAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(guardAt);
    expect(handler.slice(guardAt, fetchAt)).toContain("return;");
  });

  it("always releases the latch, on every path", () => {
    const finallyAt = handler.indexOf("} finally {");
    const releaseAt = handler.indexOf("checkingRef.current = false;");

    expect(releaseAt).toBeGreaterThan(finallyAt);
    expect(handler).toContain("setCheckingForUpdates(false);");
  });

  it("stands down while an apply is running", () => {
    expect(handler).toContain("applyingUpdateRef.current");
  });

  it("does NOT block an apply — Apply keeps its own latch, untouched", () => {
    // The important direction. A check must never be able to stop an operator
    // applying an update they can see.
    expect(applyHandler).toContain("if (applyingUpdateRef.current)");
    expect(applyHandler).not.toContain("checkingRef");
  });

  it("disables the button while checking", () => {
    expect(screen).toContain("disabled={checking}");
    expect(screen).toContain("aria-busy={checking}");
    expect(screen).toContain(
      "{checking ? CHECKING_FOR_UPDATES_LABEL : CHECK_FOR_UPDATES_ACTION}"
    );
  });
});

// ---------------------------------------------------------------------------
// 26.2's apply safety is untouched
// ---------------------------------------------------------------------------

describe("Apply update keeps every guarantee it had", () => {
  it("still reads the live cart, the durable queue and the online hint", () => {
    expect(applyHandler).toContain("liveCartLineCountRef.current");
    expect(applyHandler).toContain("await readOfflineSaleStatus()");
    expect(applyHandler).toContain("decideApplyUpdateSafety");
    expect(applyHandler).toContain("onlineHint: readOnlineHint()");
  });

  it("still clears the stale cache before reloading", () => {
    expect(applyHandler).toContain("await clearOfflineCache()");
    expect(applyHandler).toContain("setUpdateReloadPending(true)");
    expect(applyHandler).toContain("await resolveDeviceState()");
  });

  it("still refuses before the RPC when unsafe", () => {
    const decisionAt = applyHandler.indexOf("decideApplyUpdateSafety");
    const rpcAt = applyHandler.indexOf("applyDeviceConfigUpdate()");

    expect(rpcAt).toBeGreaterThan(decisionAt);
    expect(applyHandler.slice(applyHandler.indexOf("if (!safety.allowed)"), rpcAt)).toContain(
      "return;"
    );
  });
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

describe("the settings screen", () => {
  it("always offers the check, unlike the update card", () => {
    // The update section is conditional; this one is not. An operator asks
    // precisely when nothing is showing.
    expect(screen).toContain("{updateAvailable && (");

    const checkAt = screen.indexOf("onClick={onCheckForUpdates}");
    const conditionalAt = screen.indexOf("{updateAvailable && (");

    expect(checkAt).toBeGreaterThan(conditionalAt);
    expect(screen.slice(conditionalAt, checkAt)).toContain("</section>");
  });

  it("shows the result line only after a check has run", () => {
    expect(screen).toContain("{checkNotice !== null && (");
    expect(app).toContain(
      "checkOutcome === null ? null : describeCheckForUpdatesResult(checkOutcome)"
    );
  });

  it("forgets the last result when settings closes", () => {
    // Reopening should not show a stale "up to date" from ten minutes ago.
    expect(app).toContain("setCheckOutcome(null);");
  });
});
