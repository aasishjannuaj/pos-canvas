"use client";

// Feature 16.4B — the Devices section, self-contained.
//
// Owns all of its own state and calls the existing owner server actions
// directly, rather than threading ten more props through EditorShell and
// EditorPropertiesPanel (already ~1500 and ~1460 lines with flat prop lists).
// EditorShell passes exactly one prop: the project id.
//
// SECURITY POSTURE, unchanged from the backend's design:
//   * every call goes through an existing server action — the browser never
//     touches paired_devices, device_pairing_tokens or build_jobs directly;
//   * no owner id is ever sent: create_device_pairing_token and
//     revoke_paired_device both derive it from auth.uid() inside SQL;
//   * no service-role client is reachable from here (the pairing layer uses
//     none at all — see lib/devicePairing.server.ts);
//   * PairedDeviceSummary carries no auth_user_id, owner_id or revoked_by, so
//     no identity field is available to render;
//   * error text is always a first-party sanitized message, never a raw
//     Postgres error.
//
// THE PLAINTEXT PAIRING CODE lives only in this component's React state. It is
// never written to storage, a URL, or the console, and clearing it is
// irreversible by design — the owner creates a new code instead.
import { useCallback, useEffect, useState } from "react";
import PairDeviceDialog from "@/components/devices/PairDeviceDialog";
import PairedDeviceList from "@/components/devices/PairedDeviceList";
import PairingCodeCard from "@/components/devices/PairingCodeCard";
import RevokeDeviceDialog from "@/components/devices/RevokeDeviceDialog";
import { listProjectBuildJobs } from "@/lib/buildJobs.actions";
import type { BuildJobSummary } from "@/lib/buildJobs";
import {
  cancelPairingToken,
  listProjectPairedDevices,
  requestDevicePairingToken,
  revokeDevice,
} from "@/lib/devicePairing.actions";
import type { PairedDeviceSummary } from "@/lib/devices";
import { resolvePairingReadiness } from "@/lib/devicePairing.owner";

/** The live code, held in memory only. `tokenId` is what Cancel acts on. */
type ActivePairingCode = {
  tokenId: string;
  formattedCode: string;
  expiresAt: string;
};

type DeviceManagementPanelProps = {
  projectId: string | null;
  onGoToBuild: () => void;
};

export default function DeviceManagementPanel({
  projectId,
  onGoToBuild,
}: DeviceManagementPanelProps) {
  const [jobs, setJobs] = useState<BuildJobSummary[]>([]);
  const [devices, setDevices] = useState<PairedDeviceSummary[]>([]);
  // Starts true when there is something to load, so the first paint reads
  // "Loading devices…" without the mount effect having to set state
  // synchronously (react-hooks/set-state-in-effect).
  const [isLoading, setIsLoading] = useState(projectId !== null);
  const [listError, setListError] = useState<string | null>(null);

  const [pairDialogOpen, setPairDialogOpen] = useState(false);
  const [isCreatingCode, setIsCreatingCode] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [activeCode, setActiveCode] = useState<ActivePairingCode | null>(null);

  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const [deviceToRevoke, setDeviceToRevoke] = useState<PairedDeviceSummary | null>(
    null
  );
  const [isRevoking, setIsRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Every state write happens AFTER the await, so this is safe to call from a
  // mount effect as well as from the Refresh button. The button sets the
  // loading flag itself, which an event handler may do freely.
  const loadDevices = useCallback(async () => {
    if (projectId === null) {
      return;
    }

    const result = await listProjectPairedDevices(projectId);

    if (result.ok) {
      setDevices(result.devices);
      setListError(null);
    } else {
      setListError(result.message);
    }

    setIsLoading(false);
  }, [projectId]);

  const loadBuilds = useCallback(async () => {
    if (projectId === null) {
      return;
    }

    const result = await listProjectBuildJobs(projectId);
    setJobs(result.ok ? result.jobs : []);
  }, [projectId]);

  useEffect(() => {
    // Sequenced inside an async IIFE so no state write is synchronously
    // reachable from the effect body: the builds settle first (they gate the
    // Pair button), then the device list.
    void (async () => {
      await loadBuilds();
      await loadDevices();
    })();
  }, [loadBuilds, loadDevices]);

  const readiness = resolvePairingReadiness({ projectId, jobs });

  async function handleCreateCode() {
    if (readiness.state !== "ready" || projectId === null || isCreatingCode) {
      return;
    }

    setIsCreatingCode(true);
    setCreateError(null);

    const result = await requestDevicePairingToken({
      projectId,
      // Always the latest succeeded build. The owner cannot choose a build in
      // this MVP, and create_device_pairing_token re-verifies that it belongs
      // to this project, succeeded, and has a config artifact.
      buildJobId: readiness.buildJobId,
    });

    if (!result.ok) {
      setCreateError(result.message);
      setIsCreatingCode(false);
      return;
    }

    setActiveCode({
      // The action returns the plaintext once. Only the FORMATTED value is
      // kept for display; the raw `result.code` is deliberately not copied
      // into state, and neither form is ever persisted.
      formattedCode: result.formattedCode,
      expiresAt: result.expiresAt,
      tokenId: result.tokenId,
    });
    setPairDialogOpen(false);
    setIsCreatingCode(false);
  }

  async function handleCancelCode() {
    if (activeCode === null || isCancelling) {
      return;
    }

    setCancelError(null);
    setIsCancelling(true);

    // Consumes the token server-side so the code stops working immediately,
    // rather than merely hiding it. Idempotent — alreadyCancelled is success.
    const result = await cancelPairingToken(activeCode.tokenId);
    setIsCancelling(false);

    if (!result.ok) {
      setCancelError(result.message);
      return;
    }

    // Dropping the state is what makes the plaintext unrecoverable: nothing
    // else holds it, so there is no cache or storage entry to clear.
    setActiveCode(null);
  }

  async function handleConfirmRevoke() {
    if (deviceToRevoke === null || isRevoking) {
      return;
    }

    setIsRevoking(true);
    setRevokeError(null);

    const result = await revokeDevice(deviceToRevoke.id);

    if (!result.ok) {
      setRevokeError(result.message);
      setIsRevoking(false);
      return;
    }

    // alreadyRevoked is a success: revoke_paired_device is idempotent and
    // preserves the original revocation timestamp. Either way the list is
    // reloaded so the row renders its true server state.
    setIsRevoking(false);
    setDeviceToRevoke(null);
    await loadDevices();
  }

  return (
    <div className="flex-1 overflow-y-auto bg-neutral-50 p-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <header>
          <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
            Devices
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-neutral-500">
            Pair a POS device to take payments on this project. Each device runs
            the menu and prices from the build it was paired against.
          </p>
        </header>

        {readiness.state !== "ready" ? (
          <section className="rounded-xl border border-neutral-200 bg-white p-6">
            <h3 className="text-sm font-semibold text-neutral-900">
              {readiness.state === "unsaved_project"
                ? "Save this project first"
                : "Build this POS first"}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-500">
              {readiness.message}
            </p>

            {readiness.state === "no_succeeded_build" && (
              <button
                type="button"
                onClick={onGoToBuild}
                className="mt-4 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
              >
                Go to Build
              </button>
            )}
          </section>
        ) : activeCode !== null ? (
          <PairingCodeCard
            formattedCode={activeCode.formattedCode}
            expiresAt={activeCode.expiresAt}
            onCancel={handleCancelCode}
            isCancelling={isCancelling}
            cancelError={cancelError}
          />
        ) : pairDialogOpen ? (
          <PairDeviceDialog
            buildCreatedAt={readiness.buildCreatedAt}
            onConfirm={handleCreateCode}
            onDismiss={() => {
              setPairDialogOpen(false);
              setCreateError(null);
            }}
            isCreating={isCreatingCode}
            errorMessage={createError}
          />
        ) : (
          <section className="rounded-xl border border-neutral-200 bg-white p-6">
            <h3 className="text-sm font-semibold text-neutral-900">
              Pair a new device
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-neutral-500">
              Creates a one-time code to enter on the POS device.
            </p>
            {createError !== null && (
              <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {createError}
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                setCreateError(null);
                setPairDialogOpen(true);
              }}
              className="mt-4 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
            >
              Pair New Device
            </button>
          </section>
        )}

        {deviceToRevoke !== null && (
          <RevokeDeviceDialog
            device={deviceToRevoke}
            onConfirm={handleConfirmRevoke}
            onDismiss={() => {
              setDeviceToRevoke(null);
              setRevokeError(null);
            }}
            isRevoking={isRevoking}
            errorMessage={revokeError}
          />
        )}

        {projectId !== null && (
          <PairedDeviceList
            devices={devices}
            isLoading={isLoading}
            errorMessage={listError}
            onRefresh={() => {
              setIsLoading(true);
              void loadDevices();
            }}
            onRevoke={(device) => {
              setRevokeError(null);
              setDeviceToRevoke(device);
            }}
            busyDeviceId={isRevoking ? deviceToRevoke?.id ?? null : null}
          />
        )}
      </div>
    </div>
  );
}
