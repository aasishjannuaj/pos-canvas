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
  completeDeviceSaleV3,
  fetchDeviceConfig,
  fetchDevicePairingState,
  getDeviceSession,
  isPossibleRevocationError,
  redeemDevicePairingCode,
  resetDeviceSession,
  signInDeviceAnonymously,
} from "@/lib/device.rpc";
import {
  createDeviceError,
  decideConfigState,
  decidePairingState,
  getDeviceDisplayName,
  getDeviceRuntimeMode,
  OFFLINE_BLOCKED_MESSAGES,
  resolveDeviceIdentity,
  toDeviceDisplayConfig,
} from "@/lib/deviceSession";
import type { DevicePairing, DeviceState } from "@/lib/deviceSession";
import { permitsOfflineFallback } from "@/lib/deviceConnectivity";
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
import type { OfflineSaleStatus } from "@/lib/offlineSaleStatus";
import {
  subscribeToReconnect,
  triggerSaleSync,
  triggerStartupSaleSyncOnce,
} from "@/lib/saleSyncEngine";
import DeviceOfflineBanner from "@/components/device/DeviceOfflineBanner";
import { isCapacitorNativeShell } from "@/lib/nativeShell";
import { isWindowsShell } from "@/lib/windowsShell";
import type {
  PosRuntimeCompleteSale,
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
    async (trigger: "reconnect" | "manual") => {
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
   */
  const openOfflineOrFail = useCallback(
    async (sessionUserId: string, failure: DeviceFailureKind | undefined) => {
      if (failure === undefined || !permitsOfflineFallback(failure)) {
        setState(createDeviceError("offline"));
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
        // Feature 24.5A — no session means no RPC is even possible. If the
        // sign-in failed for a TRANSPORT reason there may still be a usable
        // cached session id from a previous run; there is not, because the
        // session itself is what failed, so this stays the existing offline
        // error. A device that has never signed in has nothing cached either.
        setState(createDeviceError("offline"));
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
      if (resolved.status === "ready") {
        void persistDeviceCache({
          deviceAuthUserId: sessionUserId,
          pairing: resolved.pairing,
          config: resolved.config,
          verifiedAt: new Date().toISOString(),
        });
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
      void runSync("reconnect");
    });
  }, [syncSessionKey, runSync]);

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

  const handleSaleRejected = useCallback(
    (message: string | null) => {
      // A rejection that looks like lost authorization triggers a full
      // re-resolve; the authoritative answer comes from get_device_pairing_state,
      // never from the message itself.
      if (isPossibleRevocationError(message)) {
        void resolveDeviceState();
      }
    },
    [resolveDeviceState]
  );

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
      return (
        <DeviceStatusScreen
          title="Device revoked"
          message={`${getDeviceDisplayName(
            state.pairing
          )} can no longer take payments. Its access was removed by the account owner. Pair it again with a new code to bring it back into service.`}
          onReset={handleReset}
          resetNote={RESET_NOTE}
          actionNotice={resetNotice}
        />
      );

    case "config_unavailable":
      return (
        <DeviceStatusScreen
          title="Device configuration unavailable"
          message="This device is paired, but its menu could not be loaded. The build it is pinned to may no longer be available."
          onRetry={() => void resolveDeviceState()}
          onReset={handleReset}
          resetNote={RESET_NOTE}
          actionNotice={resetNotice}
        />
      );

    case "error":
      return (
        <DeviceStatusScreen
          title={state.kind === "offline" ? "No connection" : "Something went wrong"}
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
          title="Reconnect required"
          message={OFFLINE_BLOCKED_MESSAGES[state.reason]}
          onRetry={() => void resolveDeviceState()}
          onReset={handleReset}
          resetNote={RESET_NOTE}
          actionNotice={resetNotice}
        />
      );

    case "ready": {
      const offline = state.offline ?? null;
      const offlineMode = getDeviceRuntimeMode(state) === "offline";

      // Feature 24.5E — offline checkout is permitted ONLY on an explicit
      // positive answer. An undecided device (null) and a refused one both
      // block, so there is no state in which "we have not checked yet" reads
      // as "go ahead".
      const offlineSaleAllowed = offlineMode && offlineCheckout?.ok === true;

      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          {offline !== null && <DeviceOfflineBanner offline={offline} />}

          {/* Feature 24.5E — the cashier's count. Renders nothing when the
              queue is empty, which is the normal case. Sync now is offered
              only while the device believes it is online: offering it during
              an outage would be a button that visibly does nothing. */}
          <DeviceSyncStatus
            status={saleStatus}
            syncing={syncing}
            onSyncNow={offlineMode ? null : () => void runSync("manual")}
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
        />
          </div>
        </div>
      );
    }
  }
}
