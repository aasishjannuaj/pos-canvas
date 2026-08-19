"use client";

// Feature 16.4A — every non-POS device screen: loading, offline, revoked and
// configuration-unavailable. One layout, so a till never jumps between visual
// languages while it is resolving its own state.

type DeviceStatusScreenProps = {
  title: string;
  message: string;
  /** Shown while the device is resolving state; suppresses the actions. */
  busy?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
  onReset?: () => void;
  /** Explains what Reset does — never shown without it. */
  resetNote?: string;
  /**
   * Feature 24.5E — the outcome of the LAST action taken on this screen.
   *
   * Exists so a refused reset can say why in the place the operator pressed the
   * button, rather than failing silently. Rendered as a notice rather than an
   * error: refusing to reset a device holding unsynced sales is the system
   * working, not breaking.
   */
  actionNotice?: string | null;
};

export default function DeviceStatusScreen({
  title,
  message,
  busy = false,
  onRetry,
  retryLabel = "Try again",
  onReset,
  resetNote,
  actionNotice = null,
}: DeviceStatusScreenProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-6 py-12">
      <div className="w-full max-w-md text-center">
        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">
          POS Canvas
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">
          {title}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-neutral-500">{message}</p>

        {busy && (
          <p className="mt-6 text-sm text-neutral-400" role="status">
            Working…
          </p>
        )}

        {!busy && (onRetry || onReset) && (
          <div className="mt-8 flex flex-col gap-3">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-xl bg-neutral-900 px-4 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900"
              >
                {retryLabel}
              </button>
            )}

            {onReset && (
              <button
                type="button"
                onClick={onReset}
                className="rounded-xl border border-neutral-200 bg-white px-4 py-3.5 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
              >
                Reset this device
              </button>
            )}
          </div>
        )}

        {!busy && actionNotice !== null && (
          <p
            aria-live="polite"
            className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900"
          >
            {actionNotice}
          </p>
        )}

        {!busy && onReset && resetNote && (
          <p className="mt-4 text-xs leading-relaxed text-neutral-400">
            {resetNote}
          </p>
        )}
      </div>
    </div>
  );
}
