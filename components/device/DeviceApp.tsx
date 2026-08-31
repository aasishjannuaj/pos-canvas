"use client";

// Feature 16.4A — the paired device's root component and state machine host.
//
// Every decision this component makes is delegated to the pure functions in
// lib/deviceSession.ts; every effect goes through lib/device.rpc.ts, which
// owns the dedicated device Supabase client. This file holds no parsing logic
// and no authorization logic of its own.
//
// Feature 24.5E ADDED THREE THINGS AND NO FOURTH:
//
//   1. an offline checkout handler, which validates against disk and then
//      makes the sale durable — it submits nothing, and this file still has
//      never heard of complete_sale_v4;
//   2. the sync engine's lifecycle wiring — one startup trigger per process
//      and one reconnect listener, both cleaned up;
//   3. a reset that refuses while this device is holding sales the server has
//      not accepted.
//
// IMPORT DISCIPLINE (asserted by lib/device.guards.test.ts): nothing under
// components/device/ or lib/device*.ts may import lib/supabase/client.ts,
// lib/supabase/server.ts or lib/supabase/admin.ts. The first would clobber the
// owner's cookie session; the others cannot run in a browser at all.
import { useCallback, useEffect, useRef, useState } from "react";
import PosRuntime from "@/components/runtime/PosRuntime";
import DevicePairingScreen from "@/components/device/DevicePairingScreen";
import DeviceStatusScreen from "@/components/device/DeviceStatusScreen";
import DeviceSyncStatus from "@/components/device/DeviceSyncStatus";
import {
  applyDeviceConfigUpdate,
  completeDeviceSaleV3,
  fetchDeviceConfig,
  fetchDevicePairingState,
  getDeviceSession,
  isPossibleRevocationError,
  readPersistedDeviceUserId,
  redeemDevicePairingCode,
  resetDeviceSession,
  unpairOwnDevice,
  signInDeviceAnonymously,
} from "@/lib/device.rpc";
import {
  createDeviceError,
  decideConfigState,
  NO_UPDATE_OFFER,
  DEVICE_ERROR_TITLES,
  decidePairingState,
  getDeviceDisplayName,
  getDeviceRuntimeMode,
  OFFLINE_BLOCKED_MESSAGES,
  resolveDeviceIdentity,
  toDeviceDisplayConfig,
} from "@/lib/deviceSession";
import type { DevicePairing, DeviceState, DeviceUpdateOffer } from "@/lib/deviceSession";
import { permitsOfflineFallback, readOnlineHint } from "@/lib/deviceConnectivity";
import type { DeviceFailureKind } from "@/lib/deviceConnectivity";
import {
  clearOfflineCache,
  loadOfflineFallback,
  persistDeviceCache,
} from "@/lib/deviceOfflineSession";
import {
  OFFLINE_CHECKOUT_PREPARING_MESSAGE,
  decideOfflineSaleEligibility,
  resolveOfflineSaleDraft,
} from "@/lib/offlineCheckout";
import type {
  OfflineCheckoutEligibility,
  OfflineSaleDraft,
} from "@/lib/offlineCheckout";
import {
  completeOfflineSale,
  describeOfflineCheckoutBlock,
  readOfflineSaleStatus,
  resolveOfflineCheckoutSession,
} from "@/lib/offlineCheckoutSession";
import { decideDeviceResetSafety } from "@/lib/offlineSaleStatus";
import {
  APPLY_FAILED_MESSAGE,
  APPLY_RELOAD_FAILED_MESSAGE,
  APPLY_UNREACHABLE_MESSAGE,
  OFFER_WITHDRAWN_MESSAGE,
  decideApplyUpdateSafety,
} from "@/lib/deviceConfigUpdate";
import RejectedSaleReview from "@/components/device/RejectedSaleReview";
import DeviceSettingsScreen from "@/components/device/DeviceSettingsScreen";
import OperatorMenu from "@/components/device/OperatorMenu";
import SalesHistoryScreen from "@/components/runtime/SalesHistoryScreen";
import SalesHistoryDetail from "@/components/runtime/SalesHistoryDetail";
import { classifyStartupFailure } from "@/lib/deviceStartupError";
import { CURRENCY_SYMBOLS } from "@/lib/projectConfig";
import type { DeviceHistoryOrder } from "@/lib/deviceOrders";
import {
  discardRejectedSale,
  listRejectedSaleReviews,
  retryRejectedSale,
} from "@/lib/rejectedSaleSession";
import type { RejectedSaleReview as RejectedSale } from "@/lib/rejectedSaleSession";
import {
  DISCARD_REJECTED_SALE_REFUSALS,
  RETRY_REJECTED_SALE_REFUSALS,
} from "@/lib/rejectedSaleResolution";
import type { OfflineSaleStatus } from "@/lib/offlineSaleStatus";
import {
  subscribeToReconnect,
  triggerSaleSync,
  triggerStartupSaleSyncOnce,
} from "@/lib/saleSyncEngine";
import DeviceOfflineBanner from "@/components/device/DeviceOfflineBanner";
import { isCapacitorNativeShell } from "@/lib/nativeShell";
import { isWindowsShell } from "@/lib/windowsShell";
import {
  armUncertainSale,
  readUncertainSale,
  reconcileUncertainSaleWithQueue,
  resolveUncertainSale,
} from "@/lib/uncertainSaleSession";
import type { UncertainSale } from "@/lib/saleSubmission";
import type {
  PosRuntimeArmOnlineSale,
  PosRuntimeCompleteSale,
  PosRuntimeResolveOnlineSale,
  PosRuntimeDiscardOfflineSaleDraft,
  PosRuntimeQueueOfflineSale,
} from "@/lib/posRuntimeHost";

const RESET_NOTE =
  "Resetting only signs this device out. It does not remove the device from " +
  "the owner's account — an owner revokes a device from the POS Canvas builder.";

const EMPTY_SALE_STATUS: OfflineSaleStatus = {
  waiting: 0,
  needsAttention: 0,
  synced: 0,
  unsynced: 0,
  total: 0,
  nextRetryAt: null,
  uncertainOnlineSale: false,
};

export default function DeviceApp() {
  const [state, setState] = useState<DeviceState>({ status: "checking" });
  const [pairingError, setPairingError] = useState<string | null>(null);

  /**
   * Feature 24.5E — the anonymous auth user this app is currently signed in as,
   * once it exists.
   *
   * Two jobs. It gates the sync engine: a drain before sign-in would submit
   * queued sales with no session and file every one of them as needing
   * attention over an authentication error that was never the sale's fault.
   * And it IDENTIFIES the device session, so a re-pair without a reload starts
   * a genuinely new one — see triggerStartupSaleSyncOnce.
   */
  const [syncSessionKey, setSyncSessionKey] = useState<string | null>(null);

  /**
   * Feature 24.5E — whether this till may currently sell offline.
   *
   * null means "not decided yet". It is deliberately NOT treated as eligible:
   * an undecided device shows the preparing message and cannot complete a sale.
   */
  const [offlineCheckout, setOfflineCheckout] =
    useState<OfflineCheckoutEligibility | null>(null);

  const [saleStatus, setSaleStatus] = useState<OfflineSaleStatus>(EMPTY_SALE_STATUS);
  const [syncing, setSyncing] = useState(false);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  /**
   * Feature 24.5F — the unresolved-sale review, open or closed.
   *
   * Held here rather than routed because a revoked device has no router and no
   * POS: this screen replaces the status screen for as long as it is open, and
   * closing it returns to exactly the state that was there before.
   */
  /**
   * Feature 25.1 — device settings, open or closed.
   *
   * Held here rather than routed for the same reason the review screen is: a
   * till has no router, and this replaces the POS for as long as it is open.
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * Feature 26.2 — the offer the last authoritative pairing check reported.
   *
   * INFORMATIONAL. It decides whether an Apply button is rendered and nothing
   * else: the pin this till prices from is state.pairing.buildJobId, and it
   * moves only after the server says it moved.
   */
  const [updateOffer, setUpdateOffer] = useState<DeviceUpdateOffer>(NO_UPDATE_OFFER);
  /**
   * Feature 26.2 — the live cart size, and the ONLY cart value an Apply is
   * authorized on.
   *
   * A ref and not React state, deliberately. PosRuntime writes it from a layout
   * effect, so it is current as of the last commit rather than the last paint:
   * a handler reading `.current` sees the cart as it is, not as it was when
   * this component last rendered. There is deliberately no second, mirrored
   * copy in state — an unused parallel signal beside this one would be exactly
   * what a later edit reaches for by mistake.
   *
   * `null` means no runtime is mounted and the question cannot be answered,
   * which decideApplyUpdateSafety treats as a refusal, never as an empty cart.
   */
  const liveCartLineCountRef = useRef<number | null>(null);
  /**
   * Feature 26.2 — one in-flight apply at a time, and the latch that enforces it.
   *
   * THE STATE IS FOR THE BUTTON. THE REF IS THE GUARD. React state does not
   * update synchronously: five taps dispatched in a single tick all read the
   * same `false` from their own closure and all proceed, and the button's
   * `disabled` has not re-rendered yet either. Staging QA fired five
   * apply_device_config_update requests through exactly that hole.
   *
   * A ref is written synchronously, so the second tap in the same tick sees the
   * first one's mark. Same pattern as `resolving` above, for the same reason.
   */
  const applyingUpdateRef = useRef(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  /**
   * Feature 26.2 — the server repinned this device and it has not yet loaded
   * what it repinned to.
   *
   * Set the moment an apply succeeds and cleared only by reaching `ready`. Its
   * whole job is to make the blocking screen SAY THE RIGHT THING: without it a
   * till that repinned and then lost the network would explain itself with
   * "this till has not been set up for offline use yet", which is true of the
   * cache and completely wrong about what just happened.
   */
  const [updateReloadPending, setUpdateReloadPending] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  /**
   * Feature 25.3 — Sales history, and the one sale being looked at.
   *
   * Two pieces of state rather than a screen enum: the detail is reached FROM
   * the list and returns to it, so closing the detail must not close history.
   */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyOrder, setHistoryOrder] = useState<DeviceHistoryOrder | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviews, setReviews] = useState<RejectedSale[]>([]);

  // Guards against a second resolve running while the first is in flight (e.g.
  // a retry tapped twice, or a rejected sale firing while a check is running).
  const resolving = useRef(false);

  const sessionUserIdRef = useRef<string | null>(null);

  /**
   * The pairing the app is CURRENTLY running under.
   *
   * Held in a ref rather than read from `state` inside the sale handler so the
   * handler keeps a stable identity: it is the value the cached assertion is
   * checked against at the moment of sale, and re-reading it from disk would
   * defeat the point of the comparison.
   */
  const readyPairingRef = useRef<DevicePairing | null>(null);

  /**
   * The identity of the sale currently being attempted.
   *
   * Survives a failed enqueue so a retry of the SAME cart reuses one
   * saleRequestId and one occurredAt — which is what stops a storage blip from
   * becoming two sales, and what stops a retry from recording a sale time
   * minutes after the customer actually paid.
   *
   * SCOPED TO ONE ATTEMPT, in both directions. It is cleared on a durable
   * success, and cleared again when the runtime reports the checkout closed.
   * Without the second half, a cashier who failed to save a sale, cancelled,
   * and later rang up a cart that happened to hash identically would inherit
   * the abandoned sale's identity — recording a new customer's money at an old
   * customer's time. The cart fingerprint identifies a RETRY CANDIDATE; it is
   * never a permanent identity for every future identical sale.
   */
  const offlineDraftRef = useRef<OfflineSaleDraft | null>(null);

  /**
   * Feature 24.5F — the outstanding online request read back from disk.
   *
   * The copy that survives a process kill. Loaded once the session and pairing
   * are known, refreshed whenever it is armed or resolved, and handed to
   * PosRuntime, which prefers it over anything it remembers itself.
   *
   * `unusable` means something IS stored that this session cannot act on — a
   * record left by a different pairing, or one that no longer reads back. It is
   * never applied to this session's checkout and never deleted; it still blocks
   * a reset through the status read.
   */
  const [uncertainSale, setUncertainSale] = useState<UncertainSale | null>(null);

  /**
   * Feature 24.5G — did the durable offline cache actually land on this start?
   *
   * `true` after a confirmed write, `false` when the write failed, and null
   * before any authoritative start has completed. Only an explicit `false`
   * warns: an undecided device says nothing, because "we have not written it
   * yet" is not the same claim as "this till cannot go offline".
   */
  const [offlinePrepared, setOfflinePrepared] = useState<boolean | null>(null);

  const refreshSaleStatus = useCallback(async () => {
    const status = await readOfflineSaleStatus();

    setSaleStatus(status);
  }, []);

  /**
   * Feature 24.5E — runs the sync engine for a trigger the operator can see.
   *
   * DELIBERATELY DOES NOT HANDLE "startup". That trigger is latched and has
   * exactly one call site, in the effect below; routing it through here as well
   * would give it two, which is precisely the thing the latch exists to make
   * impossible to get wrong. The two it does handle are safe to repeat: the
   * engine's own single-flight absorbs a hammered button and a flapping
   * connection alike.
   */
  const runSync = useCallback(
    async (trigger: "reconnect" | "manual" | "retry" | "revoked") => {
      setSyncing(true);

      try {
        await triggerSaleSync(trigger);
      } finally {
        setSyncing(false);
        await refreshSaleStatus();
      }
    },
    [refreshSaleStatus]
  );

  /**
   * Feature 24.5A — attempt a cached, read-only start, or say why not.
   *
   * Refuses outright unless the failure was classified as transport. Every
   * other outcome — including "unknown" — keeps the till on the network, per
   * docs/OFFLINE_ARCHITECTURE.md §G: if uncertain, do not grant offline access.
   *
   * Feature 25.4 — THE GATE IS UNCHANGED; ONLY WHAT IT SAYS ON THE WAY OUT IS.
   * A paired till whose start the server REFUSED was told "No connection" here,
   * the same untruth the fresh-install branch told, one path over. The refusal
   * decides that this device may not open from cache; it never decided that the
   * network was at fault. permitsOfflineFallback still rules on access, and
   * classifyStartupFailure — the one authority, shared with fresh install —
   * rules on wording.
   */
  const openOfflineOrFail = useCallback(
    async (sessionUserId: string, failure: DeviceFailureKind | undefined) => {

      if (failure === undefined || !permitsOfflineFallback(failure)) {
        setState(createDeviceError(classifyStartupFailure(failure)));
        return;
      }

      const fallback = await loadOfflineFallback({
        now: Date.now(),
        sessionUserId,
      });

      if (!fallback.ok) {
        setState({ status: "reconnect_required", reason: fallback.reason });
        return;
      }

      readyPairingRef.current = fallback.pairing;

      setState({
        status: "ready",
        pairing: fallback.pairing,
        config: fallback.config,
        offline: fallback.offline,
      });
    },
    []
  );

  /**
   * The cold-start / re-resolve path, in the approved order:
   *   session? -> anonymous sign-in -> pairing state -> config -> POS
   *
   * Always re-reads authoritative server state. Nothing is inferred from the
   * previous React state, so a device revoked between two calls is caught on
   * the next one.
   */
  const resolveDeviceState = useCallback(async () => {
    if (resolving.current) {
      return;
    }
    resolving.current = true;

    try {
      setState({ status: "checking" });

      const existing = await getDeviceSession();
      let session = existing;

      if (!session.ok) {
        setState({ status: "signing_in" });
        session = await signInDeviceAnonymously();
      }

      if (!session.ok) {
        // Feature 24.5G — THE COLD-START FIX.
        //
        // 24.5A stopped here with a terminal "this device is offline", on the
        // reasoning that a failed session means nothing can be cached either.
        // That is true of a device which has never paired and false of every
        // device which has: supabase-js refuses to hand back a session once the
        // access token has expired and it cannot reach the server to refresh
        // it, so a paired till with a perfect cache landed on an error screen
        // every morning. Real hardware QA found exactly that.
        //
        // The identity needed to open the cache does not require a valid token
        // — it is an ownership selector for evidence this device already holds,
        // and every other gate still applies underneath it.
        // `existing` is the pre-sign-in read; narrowing keeps TypeScript aware
        // that a successful result carries no failure kind.
        const failure =
          session.failure ?? (existing.ok ? undefined : existing.failure);
        const persistedUserId = readPersistedDeviceUserId();

        if (persistedUserId === null) {
          // Genuinely nothing to fall back to: this device has never held a
          // session, so it has never been paired and has nothing cached.
          //
          // Feature 25.4 — WHAT is wrong still has to be told truthfully.
          // Having no cache to open decides that this start cannot continue; it
          // does not decide why the start failed. This branch used to answer
          // "offline" for every failure, so a fresh install whose sign-in the
          // server REFUSED reported "No connection" on a working network. The
          // classification was already computed directly above and simply went
          // unread.
          setState(createDeviceError(classifyStartupFailure(failure)));
          return;
        }

        // The sync engine and the uncertain-sale reader key on this, so they
        // must see the same identity the cache was opened with.
        sessionUserIdRef.current = persistedUserId;
        setSyncSessionKey(persistedUserId);

        // DELIBERATELY THE SAME FUNCTION the pairing-state path uses. It admits
        // only a transport failure, so a server that ANSWERED — an invalid or
        // revoked session — still cannot become offline authorization; and it
        // runs the whole cached-start validator, so the assertion, the digest,
        // the identity match and the 7-day lease all still have to pass.
        await openOfflineOrFail(persistedUserId, failure);
        return;
      }

      const sessionUserId = session.userId;

      sessionUserIdRef.current = sessionUserId;
      setSyncSessionKey(sessionUserId);

      const pairingState = await fetchDevicePairingState();

      if (!pairingState.ok) {
        // Feature 24.5A — the ONE place a cached start becomes possible.
        //
        // `failure` is what makes this safe. A server that ANSWERED — revoked,
        // unpaired, unauthorized — never reaches the fallback, because that
        // answer is the authoritative one and ignoring it is exactly the bug
        // this feature must not have. Only an unreachable server qualifies.
        await openOfflineOrFail(sessionUserId, pairingState.failure);
        return;
      }

      const next = decidePairingState(pairingState.state);

      // Feature 26.2 — recorded from the SAME authoritative response the pin
      // comes from, so the offer and the build it would replace can never be
      // read from two different moments. A non-paired answer carries no offer.
      setUpdateOffer(
        pairingState.state.paired ? pairingState.state.offer : NO_UPDATE_OFFER
      );

      // Anything other than "load the config now" is terminal for this pass.
      if (next.status !== "loading_config") {
        // A confirmed revocation is a server answer, and the cache must not
        // outlive it: clearing here is what stops the next launch from opening
        // offline on a device the owner has withdrawn.
        //
        // Feature 24.5E: clearOfflineCache clears the CONFIG cache only. The
        // sale queue is a separate object store and is deliberately untouched —
        // sales taken before the revocation are still real money, and §13 of
        // the design records them rather than destroying them.
        if (next.status === "revoked") {
          void clearOfflineCache();
        }

        // Feature 25.1 — CRASH RECOVERY. unpair_own_device committed and the
        // app died before the local session was cleared. Without this the
        // stale anonymous user survives, and re-pairing under it would find
        // the old row and be told `already_paired` — a till that could never
        // pair again. Clearing here makes the next pairing a fresh identity.
        //
        // Keyed on the server's own `unpaired` reason, never on the screen:
        // `not_paired` reaches the same screen and must NOT clear a session
        // that was never associated with a pairing at all.
        if (
          pairingState.state.paired === false &&
          pairingState.state.reason === "unpaired"
        ) {
          void clearOfflineCache();
          await resetDeviceSession();
        }


        readyPairingRef.current = null;
        setState(next);
        return;
      }

      setState(next);

      const configResult = await fetchDeviceConfig();

      // A transport failure here means the pairing check succeeded and the
      // network dropped mid-start. The cache is still the right answer.
      if (!configResult.ok && configResult.failure !== undefined) {
        await openOfflineOrFail(sessionUserId, configResult.failure);
        return;
      }

      const resolved = decideConfigState(configResult, next.pairing);

      readyPairingRef.current = resolved.status === "ready" ? resolved.pairing : null;

      setState(resolved);

      // Feature 24.5A — refresh the durable cache on EVERY authoritative start,
      // so `lastVerifiedAt` tracks the last time the server actually vouched for
      // this device and the snapshot follows an authoritative build change.
      //
      // Feature 24.5G — AWAITED, where it used to be fire-and-forget.
      //
      // `void persistDeviceCache(...)` let the POS render while the write was
      // still in flight: open the database, hash the config, write two records.
      // A till closed promptly after pairing — which is exactly what a tester
      // does — could be killed mid-write and come back with no cache at all.
      // Awaiting costs a few milliseconds once per authoritative start and
      // removes the race entirely.
      if (resolved.status === "ready") {
        // Feature 26.2 — the till loaded a configuration from the server. Any
        // half-finished update is finished.
        setUpdateReloadPending(false);

        const persisted = await persistDeviceCache({
          deviceAuthUserId: sessionUserId,
          pairing: resolved.pairing,
          config: resolved.config,
          verifiedAt: new Date().toISOString(),
        });

        // A FAILED WRITE DOES NOT BLOCK THE TILL, and does not pretend either.
        //
        // The device is online and authoritative: it can take payments right
        // now, and refusing to open would turn a storage problem into an outage.
        // What it cannot do is survive a restart without a network, so that is
        // stated plainly instead of being discovered at 6am. There is no spinner
        // and no retry loop — the next authoritative start tries again, which is
        // the same cadence the cache has always refreshed on.
        setOfflinePrepared(persisted.stored);
      }

      if (resolved.status === "revoked") {
        void clearOfflineCache();
      }
    } finally {
      resolving.current = false;
    }
  }, [openOfflineOrFail]);

  useEffect(() => {
    void resolveDeviceState();
  }, [resolveDeviceState]);

  /**
   * Feature 24.5F — loads the unresolved sales when the review is opened.
   *
   * Read on OPEN rather than kept continuously in sync: this is a resolution
   * screen someone visits deliberately, and re-reading IndexedDB behind a
   * confirmation dialog would let the list shift under the person using it.
   */
  useEffect(() => {
    if (!reviewing) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const loaded = await listRejectedSaleReviews();

      if (!cancelled) {
        setReviews(loaded);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reviewing]);

  /**
   * Feature 24.5E — the startup sync, wired in exactly ONE place.
   *
   * Gated on the session rather than on mount: the drain submits under this
   * device's own paired session, so starting it earlier would turn a queue of
   * perfectly good sales into a queue of authentication failures.
   *
   * Fires once per device session: the effect keys on `syncSessionKey`, which
   * changes only when a genuinely different anonymous auth user signs in, and
   * triggerStartupSaleSyncOnce latches on the same key at module scope. A
   * rerender, a remount, StrictMode's double-invoke or an error boundary all
   * present the SAME key and are collapsed to one run; an unpair and re-pair
   * without a reload presents a NEW key and correctly gets its own startup
   * pass, which a process-wide boolean would have swallowed.
   */
  useEffect(() => {
    if (syncSessionKey === null) {
      return;
    }

    let cancelled = false;

    void (async () => {
      // Deliberately NOT routed through runSync: that helper flips the visible
      // "Syncing…" indicator synchronously, which is right for a press the
      // operator just made and wrong inside an effect, where React (and its
      // lint rules) would rather nothing set state before the first paint. The
      // startup drain is background work at boot; what the operator needs from
      // it is the resulting count, which is exactly what this stores.
      await triggerStartupSaleSyncOnce(syncSessionKey);

      const status = await readOfflineSaleStatus();

      if (!cancelled) {
        setSaleStatus(status);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [syncSessionKey]);

  /**
   * Feature 24.5F — a revoked device still owes the server its queued sales.
   *
   * THE DEADLOCK THIS BREAKS. A till was revoked while holding one legitimate
   * sale taken BEFORE revocation. The screen correctly said "let it sync before
   * resetting", and reset correctly refused — but nothing could sync. The
   * engine was still mounted; every route to it was shut:
   *
   *   * startup   — latched per device session and long since spent;
   *   * reconnect — fires on the `online` event, and the device was ALREADY
   *                 online; it had just talked to the server to learn it was
   *                 revoked, so no transition and no event;
   *   * retry     — schedules only for rows carrying a persisted nextAttemptAt,
   *                 and this sale had never been attempted;
   *   * Sync now  — rendered only inside the `ready` branch.
   *
   * AN EFFECT RATHER THAN A CALL AT EACH SITE, deliberately. There are three
   * ways into `revoked` — resolveDeviceState, returnOnlineFromReconnect and a
   * rejected sale re-resolving — and adding a drain to each is how one gets
   * forgotten. Keying on the status covers every path that exists and every
   * path added later.
   *
   * NO LOCAL FILTERING BY revoked_at. Every durable row is submitted and
   * complete_sale_v4 decides: a sale that occurred before revoked_at is
   * accepted and reconciled, one after it is refused with a catalogued message
   * and becomes needs_attention. The device is not the authority on which of
   * its own sales count, and guessing here would either strand real money or
   * quietly discard evidence.
   *
   * NOT GATED ON THE SALE COUNT. `saleStatus` refreshes from its own effect,
   * also keyed on status, so the count may not have caught up at the moment
   * this runs — gating on it could skip exactly the case this exists to fix.
   * The engine's own due-list is the real gate: an empty queue drains to a
   * no-op, and single-flight absorbs any overlap.
   */
  useEffect(() => {
    if (syncSessionKey === null || state.status !== "revoked") {
      return;
    }

    // Deferred out of the commit phase. runSync sets `syncing`, and setting
    // state synchronously inside an effect costs an extra render and is what
    // react-hooks/set-state-in-effect exists to catch. The zero delay also
    // buys a cleanup path: a device that leaves this screen before the timer
    // fires never starts a drain it no longer needs.
    const start = setTimeout(() => {
      void runSync("revoked");
    }, 0);

    return () => clearTimeout(start);
  }, [syncSessionKey, state.status, runSync]);

  /**
   * Feature 24.5F — a live POS returns to authoritative online mode.
   *
   * WHY runSync("reconnect") ALONE WAS NOT ENOUGH. Draining the queue is only
   * half of what regaining connectivity means. The runtime mode is set once, at
   * the moment the POS opens, and nothing cleared it — so a till whose internet
   * came back kept believing it was offline, kept routing every new sale into
   * the queue instead of complete_sale_v3, and hid its own Sync now button
   * because it "knew" it was offline. Hardware showed exactly that: the queue
   * only drained after a restart, and a sale taken after reconnection was still
   * queued.
   *
   * THIS IS THE MIRROR OF enterOfflineFromTransportFailure, and deliberately so.
   * It transitions the EXISTING `ready` state in place rather than calling
   * resolveDeviceState, which begins by setting `checking` — that would unmount
   * PosRuntime and destroy the cashier's cart and any checkout in progress. The
   * cart, the selected payment method, the open checkout overlay and any
   * uncertain-sale identity all live inside PosRuntime and are untouched here.
   *
   * IT IS STILL FULLY AUTHORITATIVE. The pairing state and the config come from
   * the server, so a revocation that landed during the outage is applied rather
   * than skipped, and a transport failure leaves the till exactly as it was.
   * Nothing here trusts navigator.onLine for anything.
   */
  const returnOnlineFromReconnect = useCallback(async (): Promise<void> => {
    const sessionUserId = sessionUserIdRef.current;

    if (sessionUserId === null || resolving.current) {
      return;
    }

    // Held for the whole episode: it excludes a concurrent cold-start resolve
    // AND a second overlapping reconnect, without a second flag to keep in sync.
    resolving.current = true;

    try {
      const pairingState = await fetchDevicePairingState();

      if (!pairingState.ok) {
        // Still unreachable. The `online` event is a hint, not proof, and a
        // captive portal produces exactly this. Stay offline, change nothing.
        return;
      }

      const next = decidePairingState(pairingState.state);

      // Feature 26.2 — the reconnect path is authoritative too: a till that
      // has just regained the network learns about a waiting offer here.
      setUpdateOffer(
        pairingState.state.paired ? pairingState.state.offer : NO_UPDATE_OFFER
      );

      if (next.status === "revoked") {
        readyPairingRef.current = null;
        void clearOfflineCache();
        setState(next);
        return;
      }

      if (next.status !== "loading_config") {
        // unpaired / signing_in / unavailable — the server's answer wins.
        setState(next);
        return;
      }

      const configResult = await fetchDeviceConfig();

      if (!configResult.ok && configResult.failure !== undefined) {
        // The connection dropped again mid-refresh. Remain offline.
        return;
      }

      const resolved = decideConfigState(configResult, next.pairing);

      if (resolved.status !== "ready") {
        if (resolved.status === "revoked") {
          readyPairingRef.current = null;
          void clearOfflineCache();
        }

        setState(resolved);
        return;
      }

      // The server has vouched for this device again, so the lease restarts
      // from now — the same rule every authoritative start follows. Awaited, so
      // the device is not called offline-ready before the write lands.
      const persisted = await persistDeviceCache({
        deviceAuthUserId: sessionUserId,
        pairing: resolved.pairing,
        config: resolved.config,
        verifiedAt: new Date().toISOString(),
      });

      setOfflinePrepared(persisted.stored);
      readyPairingRef.current = resolved.pairing;

      setState((previous) => {
        // Only a live POS may switch modes, and only one that is actually
        // offline. Anything else is a newer answer than ours.
        if (previous.status !== "ready" || !previous.offline) {
          return previous;
        }

        return {
          ...previous,
          pairing: resolved.pairing,
          config: resolved.config,
          // THE LATCH RELEASES HERE. getDeviceRuntimeMode reads this, so the
          // next sale takes the online complete_sale_v3 path.
          offline: null,
        };
      });
    } finally {
      resolving.current = false;
    }
  }, []);

  /**
   * Feature 24.5E — the reconnect trigger.
   *
   * SUBSCRIBED ONCE and unsubscribed on unmount: `runSync` is a stable callback
   * and subscribeToReconnect returns its own teardown, which this effect
   * returns directly.
   *
   * The `online` event is a HINT and is treated as one — it fires behind a
   * captive portal and on a machine with a live NIC and no route. Nothing about
   * correctness rests on it: it only nudges a drain that was already safe to
   * run, every submission still has to succeed on its own, and the engine's
   * single-flight absorbs a flapping connection firing it repeatedly. Offline
   * checkout, in particular, never consults navigator.onLine — it is gated on
   * the validated cache and the lease.
   */
  useEffect(() => {
    if (syncSessionKey === null) {
      return;
    }

    return subscribeToReconnect(() => {
      // SERIALIZED, AND THE ORDER MATTERS. The authoritative refresh runs
      // first so a revocation confirmed during the outage is applied before
      // anything else — a successful queue drain must never be able to leave a
      // withdrawn till looking healthy. The drain follows either way, because
      // sales taken before a revocation are real money and complete_sale_v4
      // decides which of them it accepts.
      void (async () => {
        await returnOnlineFromReconnect();
        await runSync("reconnect");
      })();
    });
  }, [syncSessionKey, runSync, returnOnlineFromReconnect]);

  /**
   * Feature 24.5F (DEF-02) — wake the engine when a persisted retry falls due.
   *
   * THE DEFECT THIS CLOSES: a sale that failed while the device was already
   * online got a nextAttemptAt and then nothing to fire it. No further `online`
   * event was coming — the device never went offline — so the sale waited for a
   * restart or for a cashier to notice the "Sync now" button.
   *
   * ONE TIMER, AIMED AT A REAL INSTANT, not an interval. The queue already
   * persists exactly when each record becomes eligible and already computes the
   * backoff curve; a polling interval would be a second, coarser schedule
   * running beside the real one, and would either fire uselessly for hours on
   * an idle till or arrive late. This effect keys on the earliest persisted
   * retry instant, so:
   *
   *   * nothing scheduled       -> no timer at all (the idle case is free)
   *   * only fresh pending      -> no timer; startup/reconnect/manual own those
   *   * only needs_attention,
   *     permanent_failure,
   *     syncing or synced       -> no timer; none of them is due for anything
   *   * a status refresh that
   *     does not move the
   *     instant                 -> the dep is unchanged, so NO new timer
   *
   * That last line is what makes leaks and storms structurally impossible
   * rather than merely unlikely: the number of timers is the number of distinct
   * due instants, and React clears the previous one before installing the next.
   *
   * ACROSS A RESTART the instant comes off disk, so a relaunch inside a window
   * schedules only the REMAINING delay and a relaunch after it clamps to zero
   * and fires promptly. attemptCount is never reset by any of this.
   *
   * navigator.onLine is deliberately not consulted. If the retry fires while
   * the network is still down the submission fails as a transport error and
   * backs off further, which is the correct and already-tested behaviour — and
   * a great deal safer than letting a browser hint decide when money syncs.
   */
  useEffect(() => {
    const dueAt = saleStatus.nextRetryAt;

    if (syncSessionKey === null || dueAt === null) {
      return;
    }

    const due = Date.parse(dueAt);

    if (!Number.isFinite(due)) {
      return;
    }

    const timer = setTimeout(
      () => {
        void runSync("retry");
      },
      Math.max(0, due - Date.now())
    );

    return () => clearTimeout(timer);
  }, [syncSessionKey, saleStatus.nextRetryAt, runSync]);

  /**
   * Feature 24.5E — decide whether this till may sell while running from cache.
   *
   * Re-resolved on every state change rather than computed once: the answer
   * depends on the lease, on the cached configuration's integrity and on
   * storage still working, none of which is fixed for the life of a session.
   * The sale handler re-checks all of it again at the moment of sale; this
   * decides what the operator SEES before they get there.
   */
  useEffect(() => {
    let cancelled = false;

    const resolve = async (): Promise<void> => {
      const sessionUserId = sessionUserIdRef.current;

      if (
        state.status !== "ready" ||
        getDeviceRuntimeMode(state) !== "offline" ||
        sessionUserId === null
      ) {
        if (!cancelled) {
          setOfflineCheckout(null);
        }
        return;
      }

      const eligibility = await resolveOfflineCheckoutSession({
        now: Date.now(),
        sessionUserId,
        pairing: state.pairing,
      });

      if (!cancelled) {
        setOfflineCheckout(eligibility);
      }
    };

    void resolve();

    return () => {
      cancelled = true;
    };
  }, [state]);

  /**
   * Feature 24.5F — read the outstanding online request back from disk.
   *
   * RUNS BEFORE ANY NEW FINANCIAL CHECKOUT CAN HAPPEN, which is the whole
   * requirement: a till that restarts after a request went unanswered must not
   * open for business as though nothing had happened. It keys on the resolved
   * `state`, so it settles as part of reaching `ready` rather than after it.
   *
   * A record belonging to a DIFFERENT pairing is not applied here — its key
   * belongs to another project and could not resolve anything for this one —
   * and it is not deleted either. It keeps blocking a reset through
   * readOfflineSaleStatus, which reads the raw presence of the record rather
   * than this session's view of it.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const sessionUserId = sessionUserIdRef.current;

      if (state.status !== "ready" || sessionUserId === null) {
        if (!cancelled) setUncertainSale(null);
        return;
      }

      // Feature 24.5F — release a marker the queue already owns, BEFORE reading.
      //
      // Closes the crash window between a durable offline enqueue and the
      // marker delete: the sale is safe either way, but a stale marker would
      // keep blocking changed sales and blocking reset. Matched on the exact
      // saleRequestId, never on "the queue is non-empty".
      await reconcileUncertainSaleWithQueue();

      const outstanding = await readUncertainSale({
        deviceAuthUserId: sessionUserId,
        deviceId: state.pairing.deviceId,
        projectId: state.pairing.projectId,
        buildJobId: state.pairing.buildJobId,
      });

      if (!cancelled) {
        setUncertainSale(outstanding.status === "outstanding" ? outstanding.sale : null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state]);

  /** Keeps the cashier's count current whenever the runtime settles. */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const status = await readOfflineSaleStatus();

      if (!cancelled) {
        setSaleStatus(status);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state.status]);

  async function handlePairingSubmit(code: string) {
    setPairingError(null);
    setState({ status: "redeeming" });

    const result = await redeemDevicePairingCode({
      code,
      // D4c freezes device_name and platform at insert and there is no rename
      // RPC, so redemption is the ONLY chance to record them. Both signals come
      // from the shells' own bridges — Capacitor's isNativePlatform() and the
      // Electron preload's identity object — never from user-agent sniffing,
      // and each fails closed. Android takes priority over the desktop signal;
      // neither present means "web", exactly as before.
      identity: resolveDeviceIdentity({
        isNativeShell: isCapacitorNativeShell(),
        isWindowsShell: isWindowsShell(),
      }),
    });

    if (result.ok) {
      // Covers both a fresh pairing and the idempotent retry the RPC performs
      // when the same code is submitted twice by an already-paired device.
      await resolveDeviceState();
      return;
    }

    // "This device is already paired" means the session is bound to a device
    // created by a DIFFERENT code. The truthful response is to re-resolve and
    // show that device's real state, not to argue with the operator.
    if (result.error === "already_paired") {
      await resolveDeviceState();
      return;
    }

    // Every other rejection — wrong, expired, cancelled, already consumed,
    // attempt-locked — is already collapsed to one message by the backend and
    // by getRedeemErrorMessage. Nothing here re-expands it.
    setPairingError(result.message);
    setState({ status: "unpaired", notice: null });
  }

  /**
   * Feature 24.5F — starts a fresh sync cycle for a sale that gave up.
   *
   * The policy is not re-implemented here. retryRejectedSale re-reads the record
   * and re-runs decideRejectedSaleRetrySafety against durable storage, so a
   * record that changed while the review was open is refused by the same rule
   * that offered the button.
   *
   * The DRAIN is triggered from here rather than from the session layer, so the
   * one place that knows about triggers stays the one place that fires them —
   * and it goes through runSync("manual"), which is exactly what a person
   * pressing a button means.
   */
  async function handleRetry(queueRecordId: string): Promise<string | null> {
    const result = await retryRejectedSale(queueRecordId);

    if (!result.ok) {
      setSaleStatus(await readOfflineSaleStatus());
      setReviews(await listRejectedSaleReviews());

      if (result.reason === "not_found") {
        return "This sale is no longer on this device.";
      }

      if (result.reason === "storage_unavailable") {
        return "This device could not save that change. Try again.";
      }

      return RETRY_REJECTED_SALE_REFUSALS[result.reason];
    }

    await runSync("manual");

    setSaleStatus(await readOfflineSaleStatus());
    setReviews(await listRejectedSaleReviews());

    return null;
  }

  /**
   * Feature 24.5F — resolves ONE authoritatively rejected sale, on request.
   *
   * The policy is not re-implemented here. discardRejectedSale re-reads the
   * record from IndexedDB and re-runs decideRejectedSaleDiscardSafety against
   * it, so a record that changed while the confirmation was on screen is
   * refused by the same rule that offered the button. This function only turns
   * that answer into words and refreshes what the screen is showing.
   */
  async function handleDiscard(queueRecordId: string): Promise<string | null> {
    const result = await discardRejectedSale(queueRecordId);

    // Re-read both regardless of outcome: a refusal usually means storage says
    // something different from what this screen was rendering, and the fix for
    // that is to show what storage says.
    setSaleStatus(await readOfflineSaleStatus());
    setReviews(await listRejectedSaleReviews());

    if (result.ok) {
      return null;
    }

    if (result.reason === "not_found") {
      return "This sale is no longer on this device.";
    }

    if (result.reason === "storage_unavailable") {
      return "This device could not save that change. Try again.";
    }

    return DISCARD_REJECTED_SALE_REFUSALS[result.reason];
  }

  /**
   * Feature 25.1 — the VOLUNTARY unpair, from Device settings on a working till.
   *
   * SERVER FIRST, AND NOT BEST-EFFORT. The whole point of this path is that the
   * owner's device list stops showing the tablet as Active, so a local reset
   * that ran without the server's confirmation would recreate the exact ghost
   * row this feature exists to remove. If unpair_own_device does not succeed,
   * nothing local is cleared and the operator stays on this screen with a
   * message they can act on.
   *
   * IT SHARES ONE SAFETY DECISION with handleReset and adds none of its own: the
   * same durable re-read, the same decideDeviceResetSafety, the same refusal.
   * What differs is only what happens AFTER the decision says yes.
   *
   * Deliberately separate from handleReset rather than a flag on it, because the
   * emergency screens must keep working with no server at all — see the note on
   * handleReset below.
   */
  async function handleUnpair() {
    setResetNotice(null);

    // 1. The existing durable read and the existing decision. Unchanged.
    const status = await readOfflineSaleStatus();
    const safety = decideDeviceResetSafety(status);

    setSaleStatus(status);

    if (!safety.allowed) {
      setResetNotice(safety.message);
      return;
    }

    // 2. Tell the server. Idempotent, so a retry after a lost answer is safe.
    const unpaired = await unpairOwnDevice();

    if (!unpaired.ok) {
      setResetNotice(unpaired.message);
      return;
    }

    // 3. Only now is anything local touched.
    setSettingsOpen(false);
    await clearOfflineCache();
    await resetDeviceSession();
    readyPairingRef.current = null;
    offlineDraftRef.current = null;
    setPairingError(null);
    setState({ status: "unpaired", notice: null });
    await resolveDeviceState();
  }

  /**
   * Feature 26.2 — the till adopts the configuration its owner offered it.
   *
   * THE ORDER OF THE STEPS IS THE FEATURE. Each one is only safe because the
   * one before it succeeded, and every early return leaves the device exactly
   * as it was:
   *
   *   1. refuse locally, on one decision, before any request exists
   *   2. ask the server, which re-validates everything and owns the answer
   *   3. drop the cache the moment the pin moves, because it is now stale
   *   4. re-run the ordinary authoritative start, which is what actually loads
   *      the new configuration and refreshes the offer
   *
   * WHY STEP 3 IS NOT OPTIONAL. The cached pairing assertion and the cached
   * config are written together and therefore agree with each other — both name
   * the OLD build. decideOfflineFallback checks that they agree, not that they
   * are current, so a cache left in place would pass every integrity check it
   * has. If step 4 then failed on transport, openOfflineOrFail would open this
   * till offline on the old menu while the server prices its sales from the new
   * build: the customer is shown 3.00 and the books record 9.00. Clearing first
   * turns that outcome into `reconnect_required`, which sells nothing and
   * recovers through the path that already exists for it.
   *
   * IT MOVES NO PIN LOCALLY. state.pairing.buildJobId is only ever written by
   * resolveDeviceState from an authoritative response. Nothing here constructs
   * a configuration, and the build id the RPC returns is not used to build one.
   */
  async function handleApplyUpdate() {
    // A second press while the first is in flight is a no-op, not a queue.
    // Checked and claimed on the REF, synchronously, so taps in the same tick
    // cannot all pass; the disabled button is the affordance, never the guard.
    if (applyingUpdateRef.current) {
      return;
    }

    applyingUpdateRef.current = true;

    setUpdateNotice(null);

    // 1. THE LIVE CART, READ FIRST AND SYNCHRONOUSLY.
    //
    //    Not `cartLineCount`. That mirror arrives through a passive effect and
    //    is therefore a value from the last committed render; this ref is
    //    written from a layout effect inside the commit that changed the cart,
    //    so it is what the cart IS. For the one action that moves this till's
    //    pricing authority, the difference matters.
    //
    //    Read before the awaits below rather than after, so nothing has had a
    //    chance to happen between the operator's press and the question.
    const liveCartLineCount = liveCartLineCountRef.current;

    // 2. THE DURABLE FINANCIAL READ, TAKEN NOW.
    //
    //    Not the rendered `saleStatus`, which was last refreshed whenever
    //    something happened to ask. A queue that was clean when Device settings
    //    opened can hold a pending sale by the time Apply is pressed, and the
    //    decision has to describe this instant. Same function an unpair calls.
    const status = await readOfflineSaleStatus();

    setSaleStatus(status);

    const safety = decideApplyUpdateSafety({
      cartLineCount: liveCartLineCount,
      saleStatus: status,
      onlineHint: readOnlineHint(),
    });

    if (!safety.allowed) {
      setUpdateNotice(safety.message);
      applyingUpdateRef.current = false;
      return;
    }

    setApplyingUpdate(true);

    try {
      // 2. THE SERVER'S ANSWER. It re-validates the offer at apply time, so a
      //    build that stopped being usable between the offer and this press is
      //    refused here rather than adopted.
      const applied = await applyDeviceConfigUpdate();

      if (!applied.ok) {
        if (applied.retryable) {
          setUpdateNotice(APPLY_UNREACHABLE_MESSAGE);
          return;
        }

        // A device the server no longer recognizes is not an update problem.
        // Hand it to the existing lifecycle: resolveDeviceState reads the
        // authoritative pairing state and routes to the right screen, which is
        // the same thing that happens when a revocation lands mid-session.
        if (applied.error === "not_paired" || applied.error === "not_authenticated") {
          setSettingsOpen(false);
          await resolveDeviceState();
          return;
        }

        // The offer went away, or its build did. Nothing is wrong with this
        // till; refresh so the button stops being offered.
        if (applied.error === "no_update_offered" || applied.error === "offer_unusable") {
          setUpdateNotice(OFFER_WITHDRAWN_MESSAGE);
          await resolveDeviceState();
          return;
        }

        setUpdateNotice(APPLY_FAILED_MESSAGE);
        return;
      }

      // 3. THE PIN HAS MOVED. Everything cached is now provably stale — its
      //    build is `applied.previousBuildJobId`.
      await clearOfflineCache();
      setOfflinePrepared(null);
      setUpdateReloadPending(true);

      // 4. THE ORDINARY AUTHORITATIVE START, re-used whole. It re-reads pairing
      //    (so update_available goes false), fetches get_device_config, decides
      //    `ready` or `config_unavailable`, and rewrites the cache. A failure
      //    here lands on reconnect_required or config_unavailable — both
      //    blocking, neither selling.
      setSettingsOpen(false);
      await resolveDeviceState();
    } finally {
      applyingUpdateRef.current = false;
      setApplyingUpdate(false);
    }
  }

  /**
   * Feature 25.1 — the EMERGENCY reset, deliberately unchanged.
   *
   * Reached from `revoked`, `config_unavailable` and `reconnect_required` — the
   * screens a till lands on when something is already wrong, often including the
   * network. It stays local-only on purpose: requiring a server round trip here
   * would mean a device that cannot reach POS Canvas can never be recovered,
   * which is a worse failure than a stale row an owner can revoke.
   *
   * The cost is that these three paths can still leave a row reading Active. For
   * `revoked` it cannot — the row already reads Revoked. For the other two it is
   * a rare recovery case, and the owner's Revoke action remains the answer.
   *
   * Feature 24.5E — reset, REFUSED while this device holds unsynced sales.
   *
   * APPROVED RULE (owner, 24.4 review, docs/OFFLINE_ARCHITECTURE.md §15). The
   * check runs BEFORE anything is cleared or signed out, so a refusal leaves
   * the device exactly as it was — a reset that got halfway would be the same
   * data loss it exists to prevent.
   *
   * Note what a permitted reset still does not do: clearOfflineCache clears the
   * configuration cache only. There is no code path in this repository that
   * deletes the sale queue in bulk, which is why "unpair cannot destroy
   * unsynced sales" is a property of the storage layer and not only of this
   * guard.
   */
  async function handleReset() {
    setResetNotice(null);

    const status = await readOfflineSaleStatus();
    const safety = decideDeviceResetSafety(status);

    setSaleStatus(status);

    if (!safety.allowed) {
      setResetNotice(safety.message);
      return;
    }

    // Feature 24.5A — the cached configuration belongs to the pairing being
    // reset. Clearing it here is what guarantees Business A's menu cannot
    // appear on this device after it is paired to Business B; the auth-user
    // check in decideOfflineFallback is the second, independent barrier.
    // Feature 25.1 — leave settings behind on the way out, so a device that is
    // later re-paired opens on the POS rather than on the screen it was unpaired
    // from. Placed after the safety check: a REFUSED reset must leave the screen
    // exactly where it was, with its notice on display.
    setSettingsOpen(false);

    await clearOfflineCache();
    await resetDeviceSession();
    readyPairingRef.current = null;
    offlineDraftRef.current = null;
    setPairingError(null);
    setState({ status: "unpaired", notice: null });
    await resolveDeviceState();
  }

  // Feature 16.4A — device checkout through the device client, with the pinned
  // project id from trusted server state. Feature 18.2 moved it to
  // complete_sale_v3 (see below); v2 is no longer reached from here.
  //
  // UNCHANGED BY 24.5E. An online device sale still goes to complete_sale_v3
  // and still returns the server's authoritative receipt; nothing about it
  // touches the queue.
  const completeSale: PosRuntimeCompleteSale = useCallback(
    // Feature 18.2 — the device now calls complete_sale_v3.
    async (input) => completeDeviceSaleV3({
      projectId: input.projectId,
      paymentMethod: input.paymentMethod,
      items: input.items,
      saleRequestId: input.saleRequestId,
    }),
    []
  );

  /**
   * Feature 24.5E — completes a sale with no server, by making it durable.
   *
   * THE ORDER IS THE SAFETY PROPERTY:
   *
   *   1. re-validate the offline session FROM DISK — the lease against the
   *      clock right now, the pinned configuration's integrity digest
   *      recomputed, the cached identity against the running pairing, and the
   *      queue actually listable. The eligibility the UI is showing was decided
   *      earlier and is not trusted here.
   *   2. check this particular sale — cart, payment method, lease again.
   *   3. mint the sale's identity ONCE: one saleRequestId, one occurredAt,
   *      both frozen in a draft that a retry of the same cart reuses.
   *   4. await the durable write.
   *   5. only then return ok, which is the signal PosRuntime clears the cart on.
   *
   * `now` is captured at the top and used for occurredAt, so the recorded sale
   * time is the moment the cashier confirmed — not the moment the validation
   * finished, and not the moment the transaction committed.
   *
   * NOTHING HERE SUBMITS. There is no RPC call on this path, and no branch that
   * falls back to one. The sync engine sends it later, from storage.
   */
  const queueOfflineSale: PosRuntimeQueueOfflineSale = useCallback(
    async (input) => {
      const now = Date.now();
      const sessionUserId = sessionUserIdRef.current;
      const pairing = readyPairingRef.current;

      if (sessionUserId === null || pairing === null) {
        return { ok: false, message: describeOfflineCheckoutBlock("no_cache") };
      }

      const eligibility = await resolveOfflineCheckoutSession({
        now,
        sessionUserId,
        pairing,
      });

      if (!eligibility.ok) {
        setOfflineCheckout(eligibility);
        return { ok: false, message: describeOfflineCheckoutBlock(eligibility.reason) };
      }

      const saleCheck = decideOfflineSaleEligibility({
        session: eligibility.session,
        cart: input.cart,
        paymentMethod: input.paymentMethod,
        now,
      });

      if (!saleCheck.ok) {
        return { ok: false, message: describeOfflineCheckoutBlock(saleCheck.reason) };
      }

      const drafted = resolveOfflineSaleDraft({
        current: offlineDraftRef.current,
        projectId: eligibility.session.projectId,
        paymentMethod: input.paymentMethod,
        tipAmount: input.tipAmount,
        cart: input.cart,
        now,
      });

      if (!drafted.ok) {
        return { ok: false, message: describeOfflineCheckoutBlock(drafted.reason) };
      }

      // Stored BEFORE the write is attempted, so a failed enqueue leaves the
      // identity behind for the retry rather than minting a second one.
      offlineDraftRef.current = drafted.draft;

      const outcome = await completeOfflineSale({
        session: eligibility.session,
        config: eligibility.config,
        draft: drafted.draft,
        cart: input.cart,
        paymentMethod: input.paymentMethod,
        now,
      });

      if (!outcome.ok) {
        return { ok: false, message: outcome.message };
      }

      // The sale is on disk. This draft is spent; the next sale mints its own.
      offlineDraftRef.current = null;

      void refreshSaleStatus();

      return { ok: true, receipt: outcome.receipt };
    },
    [refreshSaleStatus]
  );

  /**
   * Feature 24.5E — the checkout attempt ended without completing.
   *
   * Cancelled, or closed after a success. Either way the identity held for a
   * retry is void from here, and the next Complete Sale mints a fresh one.
   */
  const discardOfflineSaleDraft: PosRuntimeDiscardOfflineSaleDraft = useCallback(() => {
    offlineDraftRef.current = null;
  }, []);

  /**
   * Feature 24.5F (DEF-01) — a live session falls back to its cache.
   *
   * WHY THIS IS NOT resolveDeviceState(). That function starts by setting
   * `checking`, which unmounts PosRuntime and destroys the cart the cashier is
   * standing in front of — the one thing this path exists to protect. This
   * transitions the EXISTING `ready` state in place, so the runtime keeps its
   * cart, its selected payment method and its open checkout overlay while the
   * mode changes underneath it.
   *
   * WHAT MAKES IT SAFE is that it reuses loadOfflineFallback — the exact same
   * validated cached start a cold offline boot performs. Pairing assertion,
   * integrity digest, auth-user identity and the 7-day lease all have to pass
   * here for the same reasons they do at startup, and a device whose cache was
   * cleared by a confirmed revocation has nothing to load. Nothing about this
   * path is more permissive than the cold one; it is the cold one, run later.
   *
   * The remaining eligibility — queue/storage usable, pinned identity matching
   * the running app — is re-checked by decideOfflineCheckoutSession on the very
   * next Pay, so it is deliberately not duplicated here.
   *
   * If the cache does not validate, NOTHING changes: the till stays online,
   * checkout stays exactly as blocked as it was, and the cashier keeps the
   * generic "could not be confirmed" message. A failed fallback must never be
   * an escalation.
   */
  const enterOfflineFromTransportFailure = useCallback(async () => {
    const sessionUserId = sessionUserIdRef.current;

    if (sessionUserId === null) {
      return;
    }

    const fallback = await loadOfflineFallback({
      now: Date.now(),
      sessionUserId,
    });

    if (!fallback.ok) {
      return;
    }

    setState((previous) => {
      // Only a live POS may switch modes. If the app moved to revoked,
      // reconnect_required or an error while this was in flight, that answer is
      // newer than ours and must not be overwritten.
      if (previous.status !== "ready") {
        return previous;
      }

      // Already offline: nothing to do, and rebuilding the state object would
      // hand PosRuntime a new config identity for no reason.
      if (previous.offline) {
        return previous;
      }

      return {
        ...previous,
        pairing: fallback.pairing,
        config: fallback.config,
        offline: fallback.offline,
      };
    });
  }, []);

  /**
   * Feature 24.5F — make an outbound sale identity durable before it is sent.
   *
   * Returns false when the write did not land, and PosRuntime then refuses to
   * dispatch. That is the deliberate trade: a till whose storage is broken
   * cannot promise not to duplicate a sale, and the same till already refuses
   * OFFLINE checkout for the identical reason (`queue_unavailable`).
   *
   * The identity written is the RUNNING session's, so a record can always be
   * matched back to the pairing that made it.
   */
  const armOnlineSale: PosRuntimeArmOnlineSale = useCallback(
    async (sale) => {
      const sessionUserId = sessionUserIdRef.current;

      if (sessionUserId === null || state.status !== "ready") {
        return false;
      }

      const armed = await armUncertainSale({
        sale,
        identity: {
          deviceAuthUserId: sessionUserId,
          deviceId: state.pairing.deviceId,
          projectId: state.pairing.projectId,
          buildJobId: state.pairing.buildJobId,
        },
        dispatchedAt: new Date().toISOString(),
      });

      if (armed) {
        // Mirror it locally straight away, so a process death between here and
        // the response still leaves the runtime gating on the same request.
        setUncertainSale(sale);
      }

      return armed;
    },
    [state]
  );

  /** Feature 24.5F — clears the durable record after a POSITIVE resolution. */
  const resolveOnlineSale: PosRuntimeResolveOnlineSale = useCallback(async () => {
    await resolveUncertainSale();
    setUncertainSale(null);
    await refreshSaleStatus();
  }, [refreshSaleStatus]);

  const handleSaleRejected = useCallback(
    (rejection: { message: string | null; failure?: DeviceFailureKind }) => {
      // Feature 24.5F (DEF-01) — NOTHING ANSWERED, so the shop's internet is
      // down and this till may open its cache.
      //
      // Checked FIRST and by classification, never by message text and never by
      // navigator.onLine: a server that replied is an authoritative answer, and
      // ignoring it to trade from cache is the one failure this whole feature
      // is built to prevent. classifyDeviceFailure already made this decision
      // upstream in lib/device.rpc.ts; this only acts on it.
      if (rejection.failure === "transport") {
        void enterOfflineFromTransportFailure();
        return;
      }

      // A rejection that looks like lost authorization triggers a full
      // re-resolve; the authoritative answer comes from get_device_pairing_state,
      // never from the message itself.
      if (isPossibleRevocationError(rejection.message)) {
        void resolveDeviceState();
      }
    },
    [enterOfflineFromTransportFailure, resolveDeviceState]
  );

  /**
   * Feature 24.5F — whether this device is KNOWN to be holding unresolved
   * financial evidence.
   *
   * Used only to render Reset as unavailable. handleReset re-reads durable
   * storage and refuses on its own authority, and that remains the real guard:
   * this value comes from React state, which can be stale, and a stale "looks
   * safe" must never be able to erase a sale.
   */
  const resetBlocked = !decideDeviceResetSafety(saleStatus).allowed;

  switch (state.status) {
    case "checking":
    case "signing_in":
    case "loading_config":
      return (
        <DeviceStatusScreen
          title="Starting up"
          message="Checking this device's pairing with POS Canvas."
          busy
        />
      );

    case "unpaired":
      return (
        <DevicePairingScreen
          onSubmit={handlePairingSubmit}
          isSubmitting={false}
          errorMessage={pairingError}
          notice={state.notice}
        />
      );

    case "redeeming":
      return (
        <DevicePairingScreen
          onSubmit={handlePairingSubmit}
          isSubmitting
          errorMessage={null}
          notice={null}
        />
      );

    case "revoked":
      // Feature 24.5F — the review REPLACES the status screen while it is open.
      // A revoked till renders no PosRuntime and no checkout in either branch;
      // this is a read-only account of what is unresolved, plus the one action
      // that can resolve it.
      if (reviewing) {
        return (
          <RejectedSaleReview
            reviews={reviews}
            onDiscard={handleDiscard}
            onRetry={handleRetry}
            onClose={() => setReviewing(false)}
          />
        );
      }

      return (
        <DeviceStatusScreen
          title="Device revoked"
          message={`${getDeviceDisplayName(
            state.pairing
          )} can no longer take payments. Its access was removed by the account owner. Pair it again with a new code to bring it back into service.`}
          onReset={handleReset}
          resetDisabled={resetBlocked}
          resetNote={RESET_NOTE}
          actionNotice={resetNotice}
          // Feature 24.5F — what this device still owes, and the means to
          // settle it. Rendered only while unresolved evidence exists, so a
          // cleanly revoked till shows nothing extra. Sync now is offered
          // because the automatic drain above can only fire once per entry to
          // this screen: if the network is still down then, a person needs a
          // way to try again without relaunching the app.
          //
          // No checkout and no POS controls appear here — a revoked device
          // takes no payments, and this is a status readout with one button.
          statusSlot={
            saleStatus.unsynced > 0 ? (
              <DeviceSyncStatus
                status={saleStatus}
                syncing={syncing}
                // Feature 24.5F — SYNC NOW IS GATED ON `waiting`, NOT `unsynced`.
                //
                // needs_attention records are not retryable: nothing in this
                // codebase promotes one back to `pending`, and isDueForAttempt
                // refuses anything that is not pending — so a drain triggered
                // for them does nothing at all. Hardware QA hit exactly that:
                // a revoked till showed Sync now over a rejected sale, and
                // pressing it was silently inert. A control that visibly does
                // nothing teaches an operator to distrust the whole screen.
                onSyncNow={saleStatus.waiting > 0 ? () => void runSync("manual") : null}
              />
            ) : null
          }
          // Feature 24.5F — the way OUT of a needs_attention deadlock. Offered
          // only when something is actually unresolved, so a cleanly revoked
          // till still shows nothing extra.
          onReview={saleStatus.needsAttention > 0 ? () => setReviewing(true) : undefined}
          reviewLabel={saleStatus.needsAttention === 1 ? "Review sale" : "Review sales"}
        />
      );

    case "config_unavailable":
      return (
        <DeviceStatusScreen
          title={updateReloadPending ? "Finish updating" : "Device configuration unavailable"}
          // Feature 26.2 — same reasoning as reconnect_required. Either way this
          // screen sells nothing, which is the property that matters; the words
          // only decide whether the operator understands why.
          message={
            updateReloadPending
              ? APPLY_RELOAD_FAILED_MESSAGE
              : "This device is paired, but its menu could not be loaded. The build it is pinned to may no longer be available."
          }
          onRetry={() => void resolveDeviceState()}
          onReset={handleReset}
          resetDisabled={resetBlocked}
          resetNote={RESET_NOTE}
          actionNotice={resetNotice}
        />
      );

    case "error":
      return (
        <DeviceStatusScreen
          title={DEVICE_ERROR_TITLES[state.kind]}
          message={state.message}
          onRetry={() => void resolveDeviceState()}
        />
      );

    // Feature 24.5A — offline, and the cache cannot be used. Distinct from
    // "error" because nothing is broken: the till needs the network before it
    // can be trusted again, and Retry is the correct and only action.
    case "reconnect_required":
      return (
        <DeviceStatusScreen
          // Feature 26.2 — a device that repinned and could not reload says so.
          // The cache reason underneath is true but answers a question nobody
          // asked; what the operator needs to know is that the update landed on
          // the server and this till is mid-way through following it.
          title={updateReloadPending ? "Finish updating" : "Reconnect required"}
          message={
            updateReloadPending
              ? APPLY_RELOAD_FAILED_MESSAGE
              : OFFLINE_BLOCKED_MESSAGES[state.reason]
          }
          onRetry={() => void resolveDeviceState()}
          onReset={handleReset}
          resetDisabled={resetBlocked}
          resetNote={RESET_NOTE}
          actionNotice={resetNotice}
        />
      );

    case "ready": {
      // Feature 24.5F — the review REPLACES the POS while it is open, exactly as
      // it does on the revoked screen, and it is the SAME component. A till that
      // is otherwise working can still be holding a sale nobody can act on, and
      // that sale has to be reachable from the screen that reports it.
      // Feature 25.3 — THE TILL SCREENS ARE AN OVERLAY, NOT A REPLACEMENT.
      //
      // These used to `return` a different tree, which unmounted PosRuntime —
      // and the cart is useState INSIDE PosRuntime, so opening a screen threw
      // away whatever the cashier had rung up. That was survivable for unpair
      // (the pairing is going away anyway) and is not survivable for Sales
      // history, which a cashier opens mid-order to check a previous sale.
      //
      // Rendering above a still-mounted PosRuntime keeps the cart, the offline
      // state and the sync engine exactly where they were.
      // Hoisted above `overlay` (Feature 26.2): the settings screen needs it to
      // decide whether Apply update is even offered.
      const offlineMode = getDeviceRuntimeMode(state) === "offline";

      const overlay =
        reviewing ? (
          <RejectedSaleReview
            reviews={reviews}
            onDiscard={handleDiscard}
            onRetry={handleRetry}
            onClose={() => setReviewing(false)}
          />
        ) : historyOrder !== null ? (
          <SalesHistoryDetail
            order={historyOrder}
            config={state.config}
            // Back to the LIST, not out of history.
            onBack={() => setHistoryOrder(null)}
          />
        ) : historyOpen ? (
          <SalesHistoryScreen
            currencySymbol={CURRENCY_SYMBOLS[state.config.receipt.currency]}
            onOpenOrder={(order) => setHistoryOrder(order)}
            onClose={() => setHistoryOpen(false)}
          />
        ) : settingsOpen ? (
          <DeviceSettingsScreen
            pairing={state.pairing}
            onUnpair={() => void handleUnpair()}
            notice={resetNotice}
            unpairBlocked={resetBlocked}
            onClose={() => {
              setResetNotice(null);
              setUpdateNotice(null);
              setSettingsOpen(false);
            }}
            // Feature 26.2 — an offline runtime is shown no Apply button at
            // all. It could not reach the server to apply, and its `offer` came
            // from a cached start that carries none; rendering the control
            // would be offering an action that cannot work.
            updateAvailable={updateOffer.updateAvailable && !offlineMode}
            offeredAt={updateOffer.offeredAt}
            onApplyUpdate={() => void handleApplyUpdate()}
            applying={applyingUpdate}
            updateNotice={updateNotice}
          />
        ) : null;

      const offline = state.offline ?? null;

      // Feature 24.5E — offline checkout is permitted ONLY on an explicit
      // positive answer. An undecided device (null) and a refused one both
      // block, so there is no state in which "we have not checked yet" reads
      // as "go ahead".
      const offlineSaleAllowed = offlineMode && offlineCheckout?.ok === true;

      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          {offline !== null && <DeviceOfflineBanner offline={offline} />}

          {/* Feature 24.5G — the cache write failed on this start. The till is
              online and fully usable; what it cannot do is reopen without a
              network, and an operator who is told that now can act on it. Amber
              and one sentence, matching DeviceOfflineBanner: this is a state,
              not an error, and nothing has gone wrong with the sale path. */}
          {offlinePrepared === false && (
            <div
              role="status"
              className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900"
            >
              <span className="font-semibold">Offline use unavailable</span>
              <span aria-hidden="true"> · </span>
              <span>
                This till could not save its setup for offline use. It works normally
                while connected.
              </span>
            </div>
          )}

          {/* Feature 24.5E — the cashier's count. Renders nothing when the
              queue is empty, which is the normal case. Sync now is offered
              only while the device believes it is online: offering it during
              an outage would be a button that visibly does nothing. */}
          {/* Feature 24.5F — OFFERED WHENEVER THERE IS QUEUED WORK, including
              offline. It used to be hidden in offline mode, on the reasoning
              that a sync button during an outage would visibly do nothing.
              Hardware found the hole in that: when the reconnect signal never
              arrived, the till was still in offline mode, so the one manual
              recovery the cashier had was the one thing hidden from them, and
              only a restart worked.

              A press that fails while genuinely offline is harmless — the
              submission fails as a transport error, every record is preserved,
              and the backoff is unchanged. Availability keys on the queue's own
              counts, never on navigator.onLine. */}
          <DeviceSyncStatus
            status={saleStatus}
            syncing={syncing}
            onSyncNow={saleStatus.waiting > 0 ? () => void runSync("manual") : null}
            onReview={saleStatus.needsAttention > 0 ? () => setReviewing(true) : null}
          />

          <div className="min-h-0 flex-1">
        <PosRuntime
          // Stock tracking is stripped for display: the pinned snapshot's
          // stockQuantity is frozen at build time and is NOT live inventory.
          // The server still enforces stock inside complete_sale_v3, and
          // complete_sale_v4 floors it at zero for a queued sale rather than
          // destroying the sale (docs/OFFLINE_ARCHITECTURE.md §9).
          config={toDeviceDisplayConfig(state.config)}
          submitSale={completeSale}
          // No live stock source: `projects` is invisible to a device under RLS.
          refreshStock={null}
          // A till has nowhere to go back to.
          homeLink={null}
          // Feature 25.1 — the ONLY entry point to device settings on a healthy
          // till. In the header rather than beside checkout: unpairing is an
          // occasional administrative act, and a destructive control next to the
          // pay button is a control that eventually gets pressed by accident.
          // Feature 25.3 — ONE control, not two pills. At the 411 CSS px
          // Android viewport two full buttons would leave the business name
          // almost nothing; a menu costs a fixed ~40px and has room to grow.
          headerTrailing={
            <OperatorMenu
              onOpenHistory={() => {
                setHistoryOrder(null);
                setHistoryOpen(true);
              }}
              onOpenSettings={() => {
                setResetNotice(null);
                setSettingsOpen(true);
              }}
            />
          }
          // Feature 19 — the logo origin. A device reads its logo from the
          // PINNED snapshot's path, so replacing the owner's logo later cannot
          // change what this till displays. Public bucket: no signing, and no
          // storage grant a device does not already have.
          logoBaseUrl={process.env.NEXT_PUBLIC_SUPABASE_URL ?? null}
          onSaleRejected={handleSaleRejected}
          // Feature 24.5E — the fence now closes only when an offline sale
          // would NOT be safe. Online is unaffected (null, as always). Offline
          // and eligible passes null too, and supplies the durable handler
          // below instead. Offline and ineligible states the reason.
          checkoutBlockedReason={
            offlineMode && !offlineSaleAllowed
              ? offlineCheckout === null
                ? OFFLINE_CHECKOUT_PREPARING_MESSAGE
                : describeOfflineCheckoutBlock(
                    offlineCheckout.ok ? "storage_unavailable" : offlineCheckout.reason
                  )
              : null
          }
          // Non-null ONLY for a validated offline session. The owner runtime
          // and the Builder Preview never pass this at all.
          queueOfflineSale={offlineSaleAllowed ? queueOfflineSale : null}
          // Supplied under the SAME condition as the handler above: the two are
          // one capability, and a host that persisted sales without ever
          // reporting an attempt over would let one sale's identity outlive it.
          discardOfflineSaleDraft={offlineSaleAllowed ? discardOfflineSaleDraft : null}
          // Feature 24.5F — durable protection for the ONLINE path's identity.
          // Supplied unconditionally, not gated on offline eligibility: the
          // request this protects is an online one, and it is exactly the till
          // that never goes offline which would otherwise lose the key.
          armOnlineSale={armOnlineSale}
          resolveOnlineSale={resolveOnlineSale}
          persistedUncertainSale={uncertainSale}
          cartLineCountRef={liveCartLineCountRef}
        />
          </div>

          {/* Above the POS, never instead of it — see the note on `overlay`.
              PosRuntime stays mounted, so the cart survives. */}
          {overlay !== null && (
            <div className="fixed inset-0 z-30 overflow-y-auto bg-neutral-50">{overlay}</div>
          )}
        </div>
      );
    }
  }
}
