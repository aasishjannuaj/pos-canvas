"use client";

// Feature 25.1 — device settings, and the one deliberate way off a working till.
//
// WHY THIS SCREEN EXISTS. Reset was already implemented and already safe, but it
// was only reachable from `revoked`, `config_unavailable` and
// `reconnect_required` — three states a healthy till is never in. A shop that
// simply wanted to move a tablet to a different business had to break it first
// or reinstall the app. The safety machinery needed an entry point, not a
// rewrite.
//
// IT OWNS NO SAFETY DECISION. `onUnpair` is DeviceApp's existing handleReset,
// unchanged: that function re-reads durable storage, re-runs
// decideDeviceResetSafety, and refuses before anything is cleared. This screen
// asks for confirmation and shows whatever notice comes back. There is exactly
// one authoritative answer to "may this device be reset", and it is not here.
//
// AND IT IS NOT REVOCATION. Nothing on this screen contacts the server. Unpair
// clears this device's local pairing once it is safe to do so; paired_devices,
// revoked_at and every server rule are untouched.

import { useState } from "react";

import type { DevicePairing } from "@/lib/deviceSession";
import { getDeviceDisplayName } from "@/lib/deviceSession";

export const UNPAIR_ACTION = "Unpair this device";

export const UNPAIR_EXPLANATION =
  "Remove this POS Canvas pairing from this device and return to the pairing screen.";

/**
 * The confirmation. Deliberate without being alarming: unpairing a till that has
 * nothing outstanding loses no money and no records — the sales are on the
 * server — so this states what will happen rather than warning about damage.
 * The genuinely dangerous case never reaches this dialog, because handleReset
 * refuses it.
 */
export const UNPAIR_CONFIRM_LINES: readonly string[] = [
  "This device will stop taking payments and return to the pairing screen.",
  "Your published configuration and completed sales are not affected.",
  "You will need a new pairing code to use this device again.",
];

export const UNPAIR_CONFIRM_ACTION = "Unpair device";

// Feature 26.2 — the configuration update section.
//
// IT IS NOT A SOFTWARE UPDATE and must not read like one. Nothing is downloaded,
// no app version changes, and the POS the operator is holding is the same POS
// afterwards. What changes is the menu, prices and receipt details their owner
// published — so the words are about the shop, not about the binary.
export const UPDATE_AVAILABLE_HEADING = "Menu update";

export const UPDATE_AVAILABLE_EXPLANATION =
  "Your business owner has published changes to this POS. Apply them to start using the updated menu and prices.";

export const APPLY_UPDATE_ACTION = "Apply update";

export const APPLYING_UPDATE_LABEL = "Applying…";

/**
 * Renders "Offered 4 Sept, 09:12" from an ISO instant, or null when the server
 * did not send one or sent something unparseable.
 *
 * A wrong time is worse than no time: an operator deciding whether to interrupt
 * service wants to know if this appeared minutes or days ago, and a fabricated
 * or misparsed instant answers that question incorrectly.
 */
export function formatOfferedAt(offeredAt: string | null): string | null {
  if (offeredAt === null) {
    return null;
  }

  const parsed = new Date(offeredAt);

  return Number.isNaN(parsed.getTime()) ? null : `Offered ${parsed.toLocaleString()}`;
}

type DeviceSettingsScreenProps = {
  pairing: DevicePairing;
  /** DeviceApp's handleReset. The only safety decision in the flow. */
  onUnpair: () => void;
  /** Set when handleReset refused — usually unresolved sales. */
  notice: string | null;
  /** True when known state says evidence exists; an affordance, never the guard. */
  unpairBlocked: boolean;
  onClose: () => void;

  /**
   * Feature 26.2 — false renders NO update section at all.
   *
   * A permanent "no updates available" card would be noise on a screen a
   * cashier opens for one reason; absence is the correct way to say nothing is
   * waiting.
   */
  updateAvailable: boolean;
  /** ISO instant the owner made the offer, when the server supplied one. */
  offeredAt: string | null;
  /** DeviceApp's handleApplyUpdate. Like onUnpair, it owns the safety decision. */
  onApplyUpdate: () => void;
  /** True while a request is in flight — disables the button and shows progress. */
  applying: boolean;
  /** What the apply attempt said, refusal or failure. Null when nothing to say. */
  updateNotice: string | null;
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className="text-sm font-medium text-neutral-900">{value}</span>
    </div>
  );
}

export default function DeviceSettingsScreen({
  pairing,
  onUnpair,
  notice,
  unpairBlocked,
  onClose,
  updateAvailable,
  offeredAt,
  onApplyUpdate,
  applying,
  updateNotice,
}: DeviceSettingsScreenProps) {
  const [confirming, setConfirming] = useState(false);
  const offeredLabel = formatOfferedAt(offeredAt);

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 px-6 py-10">
      <div className="mx-auto w-full max-w-md">
        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-400">
          POS Canvas
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900">
          Device settings
        </h1>

        <section className="mt-6 rounded-2xl border border-neutral-200 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            This device
          </p>

          <div className="mt-2 border-t border-neutral-100 pt-2">
            <Row label="Name" value={getDeviceDisplayName(pairing)} />
            <Row label="Status" value={pairing.revokedAt === null ? "Paired" : "Revoked"} />
            {pairing.platform !== null && <Row label="Platform" value={pairing.platform} />}
            {pairing.createdAt !== null && (
              <Row label="Paired" value={new Date(pairing.createdAt).toLocaleString()} />
            )}
          </div>
        </section>

        {/* Feature 26.2 — present only when there is genuinely something to
            apply. Placed above Pairing because it is the one thing on this
            screen an operator may have come here to do. */}
        {updateAvailable && (
          <section className="mt-4 rounded-2xl border border-neutral-200 bg-white p-5">
            <div className="flex items-center gap-2">
              {/* Restrained on purpose: a dot, not a badge. This is routine
                  shop admin, not an alert. */}
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-500" />
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                {UPDATE_AVAILABLE_HEADING}
              </p>
            </div>

            <p className="mt-2 text-sm leading-relaxed text-neutral-600">
              {UPDATE_AVAILABLE_EXPLANATION}
            </p>

            {offeredLabel !== null && (
              <p className="mt-1 text-xs text-neutral-500">{offeredLabel}</p>
            )}

            <button
              type="button"
              onClick={onApplyUpdate}
              disabled={applying}
              aria-busy={applying}
              className="mt-4 w-full rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-400"
            >
              {applying ? APPLYING_UPDATE_LABEL : APPLY_UPDATE_ACTION}
            </button>

            {/* Amber, matching the unpair refusal: a till declining to repin
                itself over an open cart or an unsynced sale is the system
                working, and red would say something broke. */}
            {updateNotice !== null && (
              <p
                aria-live="polite"
                className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900"
              >
                {updateNotice}
              </p>
            )}
          </section>
        )}

        <section className="mt-4 rounded-2xl border border-neutral-200 bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Pairing
          </p>
          <p className="mt-2 text-sm leading-relaxed text-neutral-600">
            {UNPAIR_EXPLANATION}
          </p>

          {!confirming && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="mt-4 w-full rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100"
            >
              {UNPAIR_ACTION}
            </button>
          )}

          {confirming && (
            <div className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 p-4">
              {UNPAIR_CONFIRM_LINES.map((line) => (
                <p key={line} className="mb-2 text-xs leading-relaxed text-neutral-700 last:mb-0">
                  {line}
                </p>
              ))}

              {/* Keep first and solid: the destructive action must never be the
                  one a thumb finds by default. */}
              <div className="mt-4 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="w-full rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-neutral-800"
                >
                  Keep this device paired
                </button>

                <button
                  type="button"
                  onClick={onUnpair}
                  className="w-full rounded-xl border border-red-300 bg-white px-4 py-3 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50"
                >
                  {UNPAIR_CONFIRM_ACTION}
                </button>
              </div>
            </div>
          )}

          {/* What handleReset said when it refused. Amber, not red: refusing to
              unpair a device holding unsynced sales is the system working. */}
          {notice !== null && (
            <p
              aria-live="polite"
              className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900"
            >
              {notice}
            </p>
          )}

          {notice === null && unpairBlocked && (
            <p className="mt-3 text-xs leading-relaxed text-neutral-500">
              This device still has sales that have not reached POS Canvas. Let them
              sync, or resolve them, before unpairing.
            </p>
          )}
        </section>

        <button
          type="button"
          onClick={onClose}
          className="mt-8 w-full rounded-xl border border-neutral-200 bg-white px-4 py-3.5 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100"
        >
          Back to POS
        </button>
      </div>
    </div>
  );
}
