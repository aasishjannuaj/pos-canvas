"use client";

// Feature 16.4A — the paired device's root component and state machine host.
//
// Every decision this component makes is delegated to the pure functions in
// lib/deviceSession.ts; every effect goes through lib/device.rpc.ts, which
// owns the dedicated device Supabase client. This file holds no parsing logic
// and no authorization logic of its own.
//
// IMPORT DISCIPLINE (asserted by lib/device.guards.test.ts): nothing under
// components/device/ or lib/device*.ts may import lib/supabase/client.ts,
// lib/supabase/server.ts or lib/supabase/admin.ts. The first would clobber the
// owner's cookie session; the others cannot run in a browser at all.
import { useCallback, useEffect, useRef, useState } from "react";
import PosRuntime from "@/components/runtime/PosRuntime";
import DevicePairingScreen from "@/components/device/DevicePairingScreen";
import DeviceStatusScreen from "@/components/device/DeviceStatusScreen";
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
import type { DeviceState } from "@/lib/deviceSession";
import { permitsOfflineFallback } from "@/lib/deviceConnectivity";
import type { DeviceFailureKind } from "@/lib/deviceConnectivity";
import {
  clearOfflineCache,
  loadOfflineFallback,
  persistDeviceCache,
} from "@/lib/deviceOfflineSession";
import DeviceOfflineBanner from "@/components/device/DeviceOfflineBanner";
import { isCapacitorNativeShell } from "@/lib/nativeShell";
import { isWindowsShell } from "@/lib/windowsShell";
import type { PosRuntimeCompleteSale } from "@/lib/posRuntimeHost";

/**
 * Feature 24.5A — why Complete Sale is unavailable while running from cache.
 *
 * Concise, non-technical, and honest about the shape of the limitation rather
 * than the cause: the operator can neither fix the internet nor install 24.5C,
 * so the message says what is true and what is coming.
 */
const OFFLINE_CHECKOUT_BLOCKED_MESSAGE =
  "Internet connection required to complete sales. Offline sales will be added in a later update.";

const RESET_NOTE =
  "Resetting only signs this device out. It does not remove the device from " +
  "the owner's account — an owner revokes a device from the POS Canvas builder.";

export default function DeviceApp() {
  const [state, setState] = useState<DeviceState>({ status: "checking" });
  const [pairingError, setPairingError] = useState<string | null>(null);

  // Guards against a second resolve running while the first is in flight (e.g.
  // a retry tapped twice, or a rejected sale firing while a check is running).
  const resolving = useRef(false);

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
        if (next.status === "revoked") {
          void clearOfflineCache();
        }

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

  async function handleReset() {
    // Feature 24.5A — the cached configuration belongs to the pairing being
    // reset. Clearing it here is what guarantees Business A's menu cannot
    // appear on this device after it is paired to Business B; the auth-user
    // check in decideOfflineFallback is the second, independent barrier.
    await clearOfflineCache();
    await resetDeviceSession();
    setPairingError(null);
    setState({ status: "unpaired", notice: null });
    await resolveDeviceState();
  }

  // Feature 16.4A — device checkout through the device client, with the pinned
  // project id from trusted server state. Feature 18.2 moved it to
  // complete_sale_v3 (see below); v2 is no longer reached from here.
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
        />
      );

    case "ready": {
      const offline = state.offline ?? null;

      return (
        <div className="flex h-full min-h-0 w-full flex-col">
          {offline !== null && <DeviceOfflineBanner offline={offline} />}

          <div className="min-h-0 flex-1">
        <PosRuntime
          // Stock tracking is stripped for display: the pinned snapshot's
          // stockQuantity is frozen at build time and is NOT live inventory.
          // The server still enforces stock inside complete_sale_v3.
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
          // Feature 24.5A — THE FENCE. Non-null only when this start came from
          // cache, and PosRuntime refuses the sale before it reaches
          // planSaleSubmission, so no sale RPC is called and no request id is
          // minted offline. Browsing, the cart, modifiers and totals are
          // untouched; only the money-writing action is closed.
          checkoutBlockedReason={
            getDeviceRuntimeMode(state) === "offline_read_only"
              ? OFFLINE_CHECKOUT_BLOCKED_MESSAGE
              : null
          }
        />
          </div>
        </div>
      );
    }
  }
}
