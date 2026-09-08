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
import { useCallback, useEffect, useRef, useState } from "react";
import PairDeviceDialog from "@/components/devices/PairDeviceDialog";
import PairedDeviceList from "@/components/devices/PairedDeviceList";
import PairingCodeCard from "@/components/devices/PairingCodeCard";
import RunYourPosPanel from "@/components/devices/RunYourPosPanel";
import RevokeDeviceDialog from "@/components/devices/RevokeDeviceDialog";
import { listProjectBuildJobs } from "@/lib/buildJobs.actions";
import type { BuildJobSummary } from "@/lib/buildJobs";
import {
  cancelPairingToken,
  listProjectPairedDevices,
  offerDeviceUpdate,
  requestDevicePairingToken,
  revokeDevice,
} from "@/lib/devicePairing.actions";
import type { PairedDeviceSummary } from "@/lib/devices";
import { canOfferDeviceUpdate } from "@/lib/devices";
// The one message this component owns. Every other refusal string comes back
// from the server already sanitized.
const OFFER_UNAVAILABLE_MESSAGE =
  "This update could not be offered right now. Refresh and try again.";
import {
  resolvePairingReadiness,
  selectLatestSucceededBuild,
} from "@/lib/devicePairing.owner";

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
  /**
   * Feature 26.3 — set when the build list could not be loaded. Distinct from
   * listError, which is about the devices: one means "I cannot tell you what
   * is published", the other "I cannot tell you what is paired".
   */
  const [buildsError, setBuildsError] = useState<string | null>(null);

  const [pairDialogOpen, setPairDialogOpen] = useState(false);
  const [isCreatingCode, setIsCreatingCode] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [activeCode, setActiveCode] = useState<ActivePairingCode | null>(null);

  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Feature 26.3 — which device has an offer in flight, and what went wrong.
  // One id rather than a boolean: two rows must not both read as busy.
  const [offeringDeviceId, setOfferingDeviceId] = useState<string | null>(null);
  const [offerError, setOfferError] = useState<string | null>(null);
  /**
   * Feature 26.3 — the latch the guard actually reads.
   *
   * `offeringDeviceId` above drives the button; it cannot drive the guard.
   * React state is not written synchronously, so several taps dispatched in one
   * tick all read the same `null` and all proceed — Feature 26.2 shipped that
   * exact hole and staging fired five apply requests through it. A ref is
   * written the instant it is set, so the second tap in the same tick loses.
   */
  const offeringRef = useRef(false);

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

  /**
   * Feature 26.3 — a failed build load must not read as "there are no builds".
   *
   * This used to do `setJobs(result.ok ? result.jobs : [])`. An empty list is a
   * STATEMENT — it says this project has never published — and on a transient
   * failure it was a false one with real consequences: latestBuildJobId became
   * null, every row silently lost its chip and its Offer button, and an owner
   * with a genuinely newer configuration was told, in effect, that everything
   * was fine. Nothing on screen said a load had failed.
   *
   * So the last known jobs are KEPT and the failure is RECORDED instead. What
   * the rows show may now be stale, which is why buildsError also blocks
   * offering: the panel says what it last knew, admits it could not check, and
   * refuses to act on a baseline it cannot vouch for.
   */
  const loadBuilds = useCallback(async () => {
    if (projectId === null) {
      return;
    }

    const result = await listProjectBuildJobs(projectId);

    if (!result.ok) {
      setBuildsError(result.message);
      return;
    }

    setJobs(result.jobs);
    setBuildsError(null);
  }, [projectId]);

  /**
   * Feature 26.3 — builds AND devices, in that order.
   *
   * WHY BOTH, EVERY TIME. `latestBuildJobId` is derived from `jobs`, and it is
   * what the Offer button sends to the server. Reloading devices alone leaves
   * that baseline frozen at whatever it was when this panel mounted, which is
   * how an owner ends up offering a build that a newer publish has already
   * superseded — the server accepts it, because it is still a real succeeded
   * build of this project, and the till is quietly offered last week's menu.
   *
   * Builds first: they decide what every row's state MEANS, so settling them
   * before the devices arrive avoids a frame where rows are judged against a
   * baseline that is about to change.
   */
  const refreshAll = useCallback(async () => {
    await loadBuilds();
    await loadDevices();
  }, [loadBuilds, loadDevices]);

  useEffect(() => {
    // Still wrapped in an async IIFE, deliberately. react-hooks/set-state-in-effect
    // traces loadBuilds' setJobs back to this line otherwise; the IIFE is what
    // makes the write unreachable synchronously from the effect body, and it is
    // the same shape this effect has always had.
    void (async () => {
      await refreshAll();
    })();
  }, [refreshAll]);

  const readiness = resolvePairingReadiness({ projectId, jobs });

  // Feature 26.3 — the SAME build a new pairing would pin, resolved by the same
  // helper. Reusing it is the point: a till paired today and a till offered an
  // update today must land on one configuration, and two selectors would be two
  // chances to disagree about which.
  //
  // Target is deliberately not consulted, exactly as pairing does not consult
  // it: config_snapshot is generated from the project's configuration alone, so
  // the android and desktop builds of one publish carry identical snapshots and
  // nothing on the device reads `target`.
  const latestBuildJobId = selectLatestSucceededBuild(jobs)?.id ?? null;

  async function handleOfferUpdate(device: PairedDeviceSummary) {
    // Three reasons to refuse before a request exists: one is already in
    // flight, this row is not actually offerable, or there is no build. The
    // second is re-derived here rather than trusted from the row that rendered
    // the button — the list may have gone stale since it was drawn, and the
    // server would refuse anyway.
    if (
      offeringRef.current ||
      // The baseline could not be checked this pass. Offering now could send a
      // build a newer publish has already superseded, which is the exact
      // failure this feature's second pass existed to close.
      buildsError !== null ||
      latestBuildJobId === null ||
      !canOfferDeviceUpdate(device, latestBuildJobId)
    ) {
      return;
    }

    offeringRef.current = true;
    setOfferingDeviceId(device.id);
    setOfferError(null);

    // try/finally, so a throw cannot strand the latch. Without it a rejected
    // action leaves offeringRef true and the row stuck on "Offering…" until
    // this panel is remounted, with nothing on screen saying why.
    let result: Awaited<ReturnType<typeof offerDeviceUpdate>>;

    try {
      result = await offerDeviceUpdate({
        deviceId: device.id,
        buildJobId: latestBuildJobId,
      });
    } catch {
      setOfferError(OFFER_UNAVAILABLE_MESSAGE);
      return;
    } finally {
      offeringRef.current = false;
      setOfferingDeviceId(null);
    }

    if (!result.ok) {
      setOfferError(result.message);
      return;
    }

    // Reloaded rather than patched locally: the row's state comes from
    // offered_build_job_id on the server, and inventing it here would let the
    // list claim an offer the database does not have. alreadyOffered is a
    // success and needs no separate branch — the reload renders the truth
    // either way. Builds come too: the row's verdict is offered-vs-latest, so
    // judging it against a stale latest right after the owner acted is exactly
    // when a wrong answer is most believed.
    await refreshAll();
  }

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
            the menu and prices from the configuration it was paired against.
          </p>
        </header>

        {/* Feature 22 Phase 3 — where the universal app is discovered. Placed
            above the pairing controls because installing it is step 3 of the
            same sequence, and deliberately NOT beside the Publish section's
            "Download configuration", which is this project's json_config. */}
        <RunYourPosPanel readiness={readiness} />

        {readiness.state !== "ready" ? (
          <section className="rounded-xl border border-neutral-200 bg-white p-6">
            <h3 className="text-sm font-semibold text-neutral-900">
              {readiness.state === "unsaved_project"
                ? "Save this project first"
                : "Publish this configuration first"}
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
                Go to Publish
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
              void refreshAll();
            }}
            onRevoke={(device) => {
              setRevokeError(null);
              setDeviceToRevoke(device);
            }}
            busyDeviceId={isRevoking ? deviceToRevoke?.id ?? null : null}
            latestBuildJobId={latestBuildJobId}
            onOfferUpdate={(device) => void handleOfferUpdate(device)}
            offeringDeviceId={offeringDeviceId}
            offerErrorMessage={offerError}
            buildsErrorMessage={buildsError}
          />
        )}
      </div>
    </div>
  );
}
