// v1.3 Cash Drawer Checkpoint 1A — the automatic drawer-event rules.
//
// PURE. No React, no IndexedDB, no window, no Electron. The durable claim is
// INJECTED (lib/cashDrawerSession.ts supplies the real one), so every decision
// below is tested under plain Node without a storage engine.
//
// WHAT THIS CHECKPOINT IS. A completed cash sale on a Windows till produces at
// most ONE automatic drawer event, identified by the sale's own
// saleRequestId and recorded durably BEFORE anything is asked of a drawer.
// There is no drawer yet: the only capability that exists is
// UNAVAILABLE_CASH_DRAWER, which does nothing. Physical hardware is a later
// checkpoint and enters only through the CashDrawerCapability boundary below.
//
// SALE TRUTH AND DRAWER TRUTH ARE SEPARATE. Nothing here can fail, delay or
// alter a sale. The coordinator runs only after the sale has already succeeded
// (online: the server's receipt is in hand; offline: the sale is durably
// queued), it never throws, and its answer is reported to nobody who could act
// on it by changing the sale.
//
// WHAT NEVER TRIGGERS THIS: sync and replay, receipt printing and reprinting,
// Sales History, the owner runtime, the Builder preview and templates. Only
// DeviceApp wires the coordinator, and only from PosRuntime's completion hook.
// lib/cashDrawer.guards.test.ts holds each of those as a file-level property.
import type { PaymentMethod } from "@/lib/cart";
import type { DevicePlatform } from "@/lib/deviceSession";

/**
 * The only facts a drawer event is built from.
 *
 * `saleRequestId` IS the identity — the same idempotency key complete_sale_v3
 * and complete_sale_v4 resolve, and the same key the offline queue's unique
 * index holds. It is stable across a lost response, an offline continuation of
 * an online attempt, a restart and a sync, which is exactly why it, and not an
 * order number or a queue record id, is what the ledger is keyed on.
 */
export type CashDrawerSaleEvent = {
  saleRequestId: string;
  paymentMethod: PaymentMethod;
};

/**
 * Automatic eligibility. Cash opens the drawer; card never does.
 *
 * Written as an equality against "cash" rather than an inequality against
 * "card", so a payment method added later is ineligible until someone decides
 * otherwise.
 */
export function isAutomaticDrawerEligible(paymentMethod: PaymentMethod): boolean {
  return paymentMethod === "cash";
}

/**
 * Which shells may run the automatic drawer path at all.
 *
 * WINDOWS ONLY. Android has no automatic drawer behaviour in v1.3, and an
 * ordinary browser till has no shell to reach a drawer through. Both are
 * refused BEFORE the ledger is touched, so neither ever records a claim.
 */
export function isAutomaticDrawerPlatform(platform: DevicePlatform): boolean {
  return platform === "windows";
}

// ---------------------------------------------------------------------------
// The durable ledger record
// ---------------------------------------------------------------------------

/**
 * The one record shape the drawer-events store holds.
 *
 * THE RECORD'S EXISTENCE IS THE WHOLE RULE: once a saleRequestId has a record,
 * that sale never produces another automatic drawer event — whatever state the
 * record is in and whatever happened to the drawer afterwards. A claim whose
 * outcome was never learned (the process died, the capability threw, the
 * answer was "unknown") is NOT retried automatically, because re-kicking a
 * drawer that may already be open is the failure this ledger exists to rule
 * out. Recording what the hardware actually did belongs to a later checkpoint.
 */
export const DRAWER_EVENT_RECORD_VERSION = 1;

export type DrawerEventRecord = {
  version: typeof DRAWER_EVENT_RECORD_VERSION;
  saleRequestId: string;
  /** "claimed" — the one state 1A writes. Any record at all blocks a retry. */
  state: "claimed";
  claimedAt: string;
};

export function createDrawerEventRecord(input: {
  saleRequestId: string;
  now: number;
}): DrawerEventRecord {
  return {
    version: DRAWER_EVENT_RECORD_VERSION,
    saleRequestId: input.saleRequestId,
    state: "claimed",
    claimedAt: new Date(input.now).toISOString(),
  };
}

/**
 * The atomic claim's three answers.
 *
 * `claimed` means THIS caller's insert committed and it alone may proceed.
 * `already_claimed` means the storage engine refused the key because a record
 * exists — from a duplicate callback, a concurrent caller or an earlier
 * process. `failed` means the ledger could not be written, and a drawer must
 * then not be asked: an event that cannot be recorded cannot be deduplicated.
 */
export type DrawerEventClaimResult = "claimed" | "already_claimed" | "failed";

export type ClaimDrawerEvent = (saleRequestId: string) => Promise<DrawerEventClaimResult>;

// ---------------------------------------------------------------------------
// The capability boundary
// ---------------------------------------------------------------------------

/**
 * What a drawer request reports. `unknown` covers every case where the answer
 * was not learned, including a capability that threw.
 */
export type CashDrawerOpenOutcome = "opened" | "unavailable" | "unknown";

/**
 * THE ENTIRE SURFACE A FUTURE DRAWER IMPLEMENTATION GETS.
 *
 * Deliberately carries NO hardware parameter — no printer name, no device
 * path, no bytes, no command, no channel, no pulse timing, no transport. Those
 * are the implementation's own business and are resolved behind this
 * boundary, so nothing in the shared runtime can be made to address a
 * different device or send a different command. The one argument is the
 * sale's identity, which a later checkpoint may log; it selects nothing.
 */
export type CashDrawerCapability = {
  readonly available: boolean;
  requestOpen(event: { readonly saleRequestId: string }): Promise<CashDrawerOpenOutcome>;
};

/**
 * Checkpoint 1A's only capability: there is no drawer, and it says so.
 *
 * Contacts nothing — no IPC, no printer, no drawer.
 */
export const UNAVAILABLE_CASH_DRAWER: CashDrawerCapability = Object.freeze({
  available: false,
  requestOpen: async () => "unavailable" as const,
});

// ---------------------------------------------------------------------------
// The coordinator
// ---------------------------------------------------------------------------

export type AutomaticDrawerOutcome =
  | { status: "skipped"; reason: "platform" | "not_cash" | "invalid_identity" }
  | { status: "already_claimed" }
  | { status: "claim_failed" }
  | { status: "requested"; outcome: CashDrawerOpenOutcome };

/**
 * Runs ONE automatic drawer event for a sale that has ALREADY succeeded.
 *
 * The order is the safety property:
 *
 *   platform     -> Android and web stop here, before the ledger.
 *   eligibility  -> card stops here, before the ledger.
 *   claim        -> one atomic, durable insert keyed by saleRequestId. Only
 *                   the caller whose insert committed continues; a duplicate,
 *                   a concurrent loser, a replay after restart and a failed
 *                   write all stop here, and none of them asks the drawer.
 *   capability   -> asked exactly once. A throw is reported as "unknown" and
 *                   is never retried.
 *
 * NEVER THROWS and never touches the sale: the caller fires it and forgets it.
 */
export async function runAutomaticDrawerEvent(input: {
  event: CashDrawerSaleEvent;
  platform: DevicePlatform;
  claim: ClaimDrawerEvent;
  capability: CashDrawerCapability;
}): Promise<AutomaticDrawerOutcome> {
  const { event, platform, claim, capability } = input;

  if (!isAutomaticDrawerPlatform(platform)) {
    return { status: "skipped", reason: "platform" };
  }

  if (!isAutomaticDrawerEligible(event.paymentMethod)) {
    return { status: "skipped", reason: "not_cash" };
  }

  if (typeof event.saleRequestId !== "string" || event.saleRequestId.trim() === "") {
    return { status: "skipped", reason: "invalid_identity" };
  }

  let claimed: DrawerEventClaimResult;

  try {
    claimed = await claim(event.saleRequestId);
  } catch {
    claimed = "failed";
  }

  if (claimed === "already_claimed") {
    return { status: "already_claimed" };
  }

  if (claimed !== "claimed") {
    return { status: "claim_failed" };
  }

  try {
    const outcome = await capability.requestOpen({ saleRequestId: event.saleRequestId });

    return {
      status: "requested",
      outcome: outcome === "opened" || outcome === "unavailable" ? outcome : "unknown",
    };
  } catch {
    // The claim stands. Whatever the drawer did is unknown, and an unknown is
    // never re-kicked automatically.
    return { status: "requested", outcome: "unknown" };
  }
}
