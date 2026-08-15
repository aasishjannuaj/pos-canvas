"use client";

// Feature 16.4B — the confirmation shown before a pairing code is created.
//
// An inline panel rather than a modal overlay: this repository has no modal
// primitive and no UI library, and the editor's own destructive/confirming
// flows are inline. Introducing an overlay system here would be a new design
// system, which this feature explicitly must not add.
import { formatDeviceDate } from "@/lib/devicePairing.owner";

type PairDeviceDialogProps = {
  buildCreatedAt: string;
  onConfirm: () => void;
  onDismiss: () => void;
  isCreating: boolean;
  errorMessage: string | null;
};

export default function PairDeviceDialog({
  buildCreatedAt,
  onConfirm,
  onDismiss,
  isCreating,
  errorMessage,
}: PairDeviceDialogProps) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-6">
      <h3 className="text-sm font-semibold text-neutral-900">
        Pair a new device
      </h3>

      <p className="mt-2 text-sm leading-relaxed text-neutral-500">
        This creates a one-time code for a POS device. The device will be pinned
        to your latest published configuration from{" "}
        <span className="font-medium text-neutral-700">
          {formatDeviceDate(buildCreatedAt)}
        </span>{" "}
        and will charge exactly the prices in that configuration.
      </p>

      {errorMessage !== null && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </p>
      )}

      <div className="mt-5 flex gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={isCreating}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
        >
          {isCreating ? "Creating code…" : "Create pairing code"}
        </button>

        <button
          type="button"
          onClick={onDismiss}
          disabled={isCreating}
          className="rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 disabled:cursor-not-allowed disabled:text-neutral-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
