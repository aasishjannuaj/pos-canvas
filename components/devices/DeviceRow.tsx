"use client";

// Feature 16.4B — one paired device.
//
// Every label comes from the existing helpers in lib/devices.ts rather than
// being re-derived here, so the owner list and the device itself can never
// disagree about what a device is called or whether it is active.
//
// PairedDeviceSummary has no auth_user_id, owner_id or revoked_by field —
// those are never selected server-side — so there is nothing identity-bearing
// available to render even by accident.
import {
  getPairedDeviceDisplayName,
  getPairedDeviceStatusLabel,
  isPairedDeviceActive,
} from "@/lib/devices";
import type { PairedDeviceSummary } from "@/lib/devices";
import { formatDeviceDate, formatDevicePlatform } from "@/lib/devicePairing.owner";

type DeviceRowProps = {
  device: PairedDeviceSummary;
  onRevoke: (device: PairedDeviceSummary) => void;
  isBusy: boolean;
};

export default function DeviceRow({ device, onRevoke, isBusy }: DeviceRowProps) {
  const active = isPairedDeviceActive(device);

  return (
    <li
      className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 ${
        active ? "border-neutral-200 bg-white" : "border-neutral-200 bg-neutral-50"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`text-sm font-medium ${
              active ? "text-neutral-900" : "text-neutral-400"
            }`}
          >
            {getPairedDeviceDisplayName(device)}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              active
                ? "bg-green-100 text-green-700"
                : "bg-neutral-200 text-neutral-600"
            }`}
          >
            {getPairedDeviceStatusLabel(device.status)}
          </span>
        </div>

        <p className="mt-1 text-xs text-neutral-500">
          {formatDevicePlatform(device.platform)} · Paired{" "}
          {formatDeviceDate(device.createdAt)}
          {!active && device.revokedAt !== null && (
            <> · Revoked {formatDeviceDate(device.revokedAt)}</>
          )}
        </p>
      </div>

      {/* A revoked device has no action: revocation is terminal in the current
          backend, so there is nothing here to offer. */}
      {active && (
        <button
          type="button"
          onClick={() => onRevoke(device)}
          disabled={isBusy}
          className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:text-neutral-300"
        >
          Revoke
        </button>
      )}
    </li>
  );
}
