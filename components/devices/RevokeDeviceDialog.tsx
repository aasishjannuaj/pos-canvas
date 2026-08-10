"use client";

// Feature 16.4B — the revoke confirmation.
//
// Deliberately explicit about all three facts an owner needs, because
// revocation has no undo in the current backend: revoke_paired_device only
// ever sets revoked_at/revoked_by, and nothing anywhere clears them.
import { getPairedDeviceDisplayName } from "@/lib/devices";
import type { PairedDeviceSummary } from "@/lib/devices";

type RevokeDeviceDialogProps = {
  device: PairedDeviceSummary;
  onConfirm: () => void;
  onDismiss: () => void;
  isRevoking: boolean;
  errorMessage: string | null;
};

export default function RevokeDeviceDialog({
  device,
  onConfirm,
  onDismiss,
  isRevoking,
  errorMessage,
}: RevokeDeviceDialogProps) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50/40 p-6">
      <h3 className="text-sm font-semibold text-neutral-900">
        Revoke {getPairedDeviceDisplayName(device)}?
      </h3>

      <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-neutral-600">
        <li>This device will stop being able to make sales immediately.</li>
        <li>Revoking cannot currently be undone.</li>
        <li>
          Resetting the physical device is separate from revoking it — a reset
          only signs the device out, and does not remove its access here.
        </li>
      </ul>

      {errorMessage !== null && (
        <p role="alert" className="mt-4 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800">
          {errorMessage}
        </p>
      )}

      <div className="mt-5 flex gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={isRevoking}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:cursor-not-allowed disabled:bg-red-200"
        >
          {isRevoking ? "Revoking…" : "Revoke device"}
        </button>

        <button
          type="button"
          onClick={onDismiss}
          disabled={isRevoking}
          className="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 disabled:cursor-not-allowed disabled:text-neutral-300"
        >
          Keep device
        </button>
      </div>
    </div>
  );
}
