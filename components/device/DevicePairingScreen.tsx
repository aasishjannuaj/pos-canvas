"use client";

// Feature 16.4A — the pairing-code entry screen.
//
// Deliberately a setup screen, not an admin screen: one field, one button, one
// instruction. It is the first thing an operator sees on a new till.
import { useState } from "react";
import {
  PAIRING_CODE_LENGTH,
  isValidPairingCodeShape,
  normalizePairingCode,
} from "@/lib/devicePairing";

/**
 * Formats keystrokes as XXXX-XXXX for readability.
 *
 * Built on the SHARED normalizePairingCode, so everything the SQL side accepts
 * is accepted here: lowercase, spaces, punctuation, and the Crockford aliases
 * I/L -> 1 and O -> 0. Typing "abcd efgh" or "abcd-efgh" or "ABCDEFGH" all
 * produce the same code.
 */
export function formatPairingCodeInput(raw: string): string {
  const normalized = normalizePairingCode(raw).slice(0, PAIRING_CODE_LENGTH);

  if (normalized.length <= 4) {
    return normalized;
  }

  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

type DevicePairingScreenProps = {
  onSubmit: (code: string) => void;
  isSubmitting: boolean;
  errorMessage: string | null;
  notice: string | null;
};

export default function DevicePairingScreen({
  onSubmit,
  isSubmitting,
  errorMessage,
  notice,
}: DevicePairingScreenProps) {
  const [value, setValue] = useState("");

  const canSubmit = isValidPairingCodeShape(value) && !isSubmitting;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    // Double-submit guard: a second press while a redemption is in flight must
    // never start a second attempt against the same single-use token.
    if (!canSubmit) {
      return;
    }

    onSubmit(value);
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-6 py-12">
      <div className="w-full max-w-sm">
        {/* RC-polish — PLATFORM identity only. This device is not paired yet,
            so there is no merchant to brand it with: no business name, no
            merchant logo, no accent colour. Inventing any of them here would
            show a shop that may not be the one this till is about to join. */}
        <div className="mb-6 flex flex-col items-center text-center">
          <span
            aria-hidden="true"
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-neutral-900"
          >
            {/* Drawn, not an asset: a till slip. No merchant mark is loaded. */}
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5 text-white"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" />
              <path d="M9.5 8h5M9.5 12h5" />
            </svg>
          </span>

          <p className="mt-3 text-xs font-semibold uppercase tracking-widest text-neutral-400">
            POS Canvas
          </p>
        </div>

        {/* The setup card. One field, one button, one instruction — the screen
            is deliberately a setup step, not an admin console. */}
        <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">
            Set up this till
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-neutral-500">
            Enter the pairing code from the POS Canvas builder. Codes expire a
            few minutes after they are created.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="pairing-code"
                className="text-xs font-semibold uppercase tracking-wide text-neutral-400"
              >
                Pairing code
              </label>
              <input
                id="pairing-code"
                type="text"
                value={value}
                onChange={(event) =>
                  setValue(formatPairingCodeInput(event.target.value))
                }
                disabled={isSubmitting}
                // 8 code characters plus the display hyphen.
                maxLength={PAIRING_CODE_LENGTH + 1}
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="XXXX-XXXX"
                aria-describedby={errorMessage ? "pairing-error" : undefined}
                aria-invalid={errorMessage !== null}
                className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-4 text-center font-mono text-2xl uppercase tracking-[0.3em] text-neutral-900 transition-colors placeholder:tracking-[0.2em] placeholder:text-neutral-300 focus:border-neutral-900 focus:bg-white focus:outline-none focus:ring-4 focus:ring-neutral-900/10 disabled:bg-neutral-100 disabled:text-neutral-400"
              />
            </div>

            {/* An expired or rejected code is the common case here, so it is a
                bordered block rather than a tinted line — it has to survive
                being glanced at on a counter. */}
            {errorMessage !== null && (
              <p
                id="pairing-error"
                role="alert"
                className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-relaxed text-red-700"
              >
                {errorMessage}
              </p>
            )}

            {notice !== null && errorMessage === null && (
              <p className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-relaxed text-blue-700">
                {notice}
              </p>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-xl bg-neutral-900 px-4 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
            >
              {isSubmitting ? "Pairing…" : "Pair this device"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs leading-relaxed text-neutral-400">
          This device keeps its own sign-in. It does not use the owner account
          signed in on this browser.
        </p>
      </div>
    </div>
  );
}
