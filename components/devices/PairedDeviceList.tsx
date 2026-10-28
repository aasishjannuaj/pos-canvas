"use client";

// Feature 16.4B — the paired-device list.
//
// Refresh is MANUAL and explicit. There is no Realtime subscription and no
// polling: a device pairs seconds after the owner reads a code out, so one
// button covers the only moment the list is meaningfully stale.
import DeviceRow from "@/components/devices/DeviceRow";
import type { PairedDeviceSummary } from "@/lib/devices";

type PairedDeviceListProps = {
  devices: PairedDeviceSummary[];
  isLoading: boolean;
  errorMessage: string | null;
  onRefresh: () => void;
  onRevoke: (device: PairedDeviceSummary) => void;
  busyDeviceId: string | null;
  /** Feature 26.3 — passed straight through; this list derives nothing. */
  latestBuildJobId: string | null;
  onOfferUpdate: (device: PairedDeviceSummary) => void;
  offeringDeviceId: string | null;
  /**
   * Feature 26.3 — kept SEPARATE from errorMessage above. That one means the
   * list could not be loaded; this one means the list is fine and one offer
   * did not go through. Collapsing them would tell an owner their devices are
   * unreadable when they are looking straight at them.
   */
  offerErrorMessage: string | null;
  /**
   * Feature 26.3 — the build list could not be loaded, so what these rows say
   * about updates may be out of date. Shown as a warning rather than an error:
   * the devices below are real and correct, it is only the "is there something
   * newer" question that went unanswered.
   */
  buildsErrorMessage: string | null;
  /**
   * Feature 26.4 — how many active devices would actually be offered an update.
   * Zero renders no bulk control at all: a button that would act on nothing is
   * worse than no button, because it implies there is something to do.
   */
  offerableCount: number;
  onOfferUpdateToAll: () => void;
  bulkOffering: boolean;
  /** The counts sentence from the last bulk offer. */
  bulkNotice: string | null;
};

export default function PairedDeviceList({
  devices,
  isLoading,
  errorMessage,
  onRefresh,
  onRevoke,
  busyDeviceId,
  latestBuildJobId,
  onOfferUpdate,
  offeringDeviceId,
  offerErrorMessage,
  buildsErrorMessage,
  offerableCount,
  onOfferUpdateToAll,
  bulkOffering,
  bulkNotice,
}: PairedDeviceListProps) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-neutral-900">Paired devices</h3>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 disabled:cursor-not-allowed disabled:text-neutral-300"
        >
          {isLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {errorMessage !== null && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </p>
      )}

      {/* Feature 26.4 — the bulk control, present only when it would do
          something. It states the count in its own label so the owner knows
          the size of what they are about to do before they press it, and it is
          disabled while ANY offer is in flight, including a single-row one. */}
      {offerableCount > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
          <p className="text-sm text-neutral-700">
            {offerableCount === 1
              ? "1 device can be updated to the latest configuration."
              : `${offerableCount} devices can be updated to the latest configuration.`}
          </p>
          <button
            type="button"
            onClick={onOfferUpdateToAll}
            disabled={bulkOffering || offeringDeviceId !== null}
            aria-busy={bulkOffering}
            className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:bg-neutral-400"
          >
            {bulkOffering ? "Offering…" : "Offer update to all"}
          </button>
        </div>
      )}

      {/* What the server actually did. Neutral, not green: a partial result is
          not a success story, and the sentence itself carries both numbers. */}
      {bulkNotice !== null && (
        <p
          role="status"
          className="mt-4 rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-800"
        >
          {bulkNotice}
        </p>
      )}

      {buildsErrorMessage !== null && (
        <p
          role="status"
          className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Could not check for a newer configuration, so the update status below
          may be out of date. Refresh to try again.
        </p>
      )}

      {offerErrorMessage !== null && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {offerErrorMessage}
        </p>
      )}

      {devices.length === 0 && errorMessage === null ? (
        <p className="mt-4 text-sm text-neutral-500">
          {isLoading
            ? "Loading devices…"
            : "No devices are paired to this project yet. Create a pairing code and enter it on the POS device, then refresh."}
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              onRevoke={onRevoke}
              isBusy={busyDeviceId === device.id}
              latestBuildJobId={latestBuildJobId}
              onOfferUpdate={onOfferUpdate}
              isOffering={offeringDeviceId === device.id}
              anyOfferInFlight={offeringDeviceId !== null || bulkOffering}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
