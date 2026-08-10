"use client";

// Feature 16.4B — the one-time pairing code display.
//
// THE CODE IS NEVER PERSISTED. It arrives as a prop, lives in the parent's
// React state for the lifetime of this card, and disappears when the card
// unmounts. It is never written to localStorage, sessionStorage, a cookie,
// the URL, or the console, and there is deliberately no way to recover it
// after the card closes — the owner generates a new one instead.
import { useEffect, useState } from "react";
import {
  PAIRING_CODE_TTL_LABEL,
  formatPairingCountdown,
  getPairingCodeRemainingSeconds,
} from "@/lib/devicePairing.owner";

type PairingCodeCardProps = {
  formattedCode: string;
  expiresAt: string;
  onCancel: () => void;
  isCancelling: boolean;
  cancelError: string | null;
};

export default function PairingCodeCard({
  formattedCode,
  expiresAt,
  onCancel,
  isCancelling,
  cancelError,
}: PairingCodeCardProps) {
  // Only the clock is state; the countdown is DERIVED from it during render.
  // Recomputing from expiresAt each tick (rather than decrementing a counter)
  // means a backgrounded tab or a sleeping laptop resumes showing the true
  // remaining time instead of a drifted one, and it keeps the effect free of a
  // synchronous setState when expiresAt changes.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);

    return () => window.clearInterval(timer);
  }, []);

  const remainingSeconds = getPairingCodeRemainingSeconds(expiresAt, now);
  const expired = remainingSeconds === 0;

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-6">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">
          Pairing code
        </h3>
        <span
          className={`text-xs font-medium tabular-nums ${
            expired ? "text-red-600" : "text-neutral-400"
          }`}
          role="status"
        >
          {expired ? "Expired" : `Expires in ${formatPairingCountdown(remainingSeconds)}`}
        </span>
      </div>

      <p
        className={`mt-4 text-center font-mono text-4xl font-semibold tracking-[0.2em] ${
          expired ? "text-neutral-300 line-through" : "text-neutral-900"
        }`}
      >
        {formattedCode}
      </p>

      {expired ? (
        <p className="mt-4 text-sm text-neutral-500">
          This code has expired and can no longer be used. Create a new one to
          pair a device.
        </p>
      ) : (
        <>
          <p className="mt-4 text-sm font-medium text-neutral-900">
            Enter this code on the POS device.
          </p>
          <p className="mt-1 text-sm text-neutral-500">
            The code works once and expires {PAIRING_CODE_TTL_LABEL} after it was
            created. It is shown only now — closing this card does not save it.
          </p>
        </>
      )}

      {cancelError !== null && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {cancelError}
        </p>
      )}

      <button
        type="button"
        onClick={onCancel}
        disabled={isCancelling}
        className="mt-5 rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 disabled:cursor-not-allowed disabled:text-neutral-300"
      >
        {isCancelling ? "Cancelling…" : expired ? "Dismiss" : "Cancel code"}
      </button>
    </div>
  );
}
