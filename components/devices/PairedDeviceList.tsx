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
};

export default function PairedDeviceList({
  devices,
  isLoading,
  errorMessage,
  onRefresh,
  onRevoke,
  busyDeviceId,
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
            />
          ))}
        </ul>
      )}
    </section>
  );
}
