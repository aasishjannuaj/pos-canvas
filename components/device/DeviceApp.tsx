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
  resolveDeviceIdentity,
  toDeviceDisplayConfig,
} from "@/lib/deviceSession";
import type { DeviceState } from "@/lib/deviceSession";
import { isCapacitorNativeShell } from "@/lib/nativeShell";
import type { PosRuntimeCompleteSale } from "@/lib/posRuntimeHost";

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

      let session = await getDeviceSession();

      if (!session.ok) {
        setState({ status: "signing_in" });
        session = await signInDeviceAnonymously();

        if (!session.ok) {
          // Anonymous sign-in is the one step with no fallback: without it the
          // device cannot call any RPC. Most often this is simply offline.
          setState(createDeviceError("offline"));
          return;
        }
      }

      const pairingState = await fetchDevicePairingState();

      if (!pairingState.ok) {
        setState(createDeviceError("offline"));
        return;
      }

      const next = decidePairingState(pairingState.state);

      // Anything other than "load the config now" is terminal for this pass.
      if (next.status !== "loading_config") {
        setState(next);
        return;
      }

      setState(next);

      const configResult = await fetchDeviceConfig();
      setState(decideConfigState(configResult, next.pairing));
    } finally {
      resolving.current = false;
    }
  }, []);

  useEffect(() => {
    void resolveDeviceState();
  }, [resolveDeviceState]);

  async function handlePairingSubmit(code: string) {
    setPairingError(null);
    setState({ status: "redeeming" });

    const result = await redeemDevicePairingCode({
      code,
      // D4c freezes device_name and platform at insert and there is no rename
      // RPC, so redemption is the ONLY chance to record them. The platform
      // comes from Capacitor's own isNativePlatform() via lib/nativeShell.ts —
      // never from user-agent sniffing — and fails closed to "web".
      identity: resolveDeviceIdentity(isCapacitorNativeShell()),
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

    case "ready":
      return (
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
          onSaleRejected={handleSaleRejected}
        />
      );
  }
}
