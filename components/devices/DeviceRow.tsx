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
  getDeviceUpdateStateLabel,
  getPairedDeviceDisplayName,
  getPairedDeviceStatusLabel,
  isPairedDeviceActive,
  resolveCashDrawerConfigState,
  resolveDeviceUpdateState,
} from "@/lib/devices";
import type { PairedDeviceSummary } from "@/lib/devices";
import { formatDeviceDate, formatDevicePlatform } from "@/lib/devicePairing.owner";

type DeviceRowProps = {
  device: PairedDeviceSummary;
  onRevoke: (device: PairedDeviceSummary) => void;
  isBusy: boolean;
  /**
   * Feature 26.3 — the build this device would be offered, or null when the
   * project has none yet. The row derives its own state from it rather than
   * being told, so the chip and the button can never disagree.
   */
  latestBuildJobId: string | null;
  onOfferUpdate: (device: PairedDeviceSummary) => void;
  /** This row is the one in flight — drives the label. */
  isOffering: boolean;
  /**
   * ANY row is in flight — drives disabled.
   *
   * The panel's latch is a single-flight across the whole list, so a second
   * row's button did nothing when pressed while looking perfectly clickable.
   * Two props rather than one because the two questions differ: "am I the one
   * working" decides the words, "is anything working" decides whether a press
   * can do anything at all.
   */
  anyOfferInFlight: boolean;
  /**
   * Cash Drawer 1D — the owner's request to change this register's setting.
   *
   * The row never changes the value itself. It reports the intent and goes on
   * rendering `device.cashDrawerEnabled`, which only moves when an
   * authoritative re-read says so.
   */
  onCashDrawerChange: (device: PairedDeviceSummary, enabled: boolean) => void;
  /** This row's drawer setting is the one in flight. */
  isCashDrawerUpdating: boolean;
  /**
   * ANY drawer change is in flight, or the list is stale after one.
   *
   * Two reasons, one prop, because they have the same consequence: a further
   * drawer change must not be attempted. Separate from `anyOfferInFlight` so a
   * configuration offer and a drawer setting never disable each other.
   */
  cashDrawerLocked: boolean;
  /** This row's failure, already a first-party sentence. */
  cashDrawerError: string | null;
};

export default function DeviceRow({
  device,
  onRevoke,
  isBusy,
  latestBuildJobId,
  onOfferUpdate,
  isOffering,
  anyOfferInFlight,
  onCashDrawerChange,
  isCashDrawerUpdating,
  cashDrawerLocked,
  cashDrawerError,
}: DeviceRowProps) {
  const active = isPairedDeviceActive(device);
  const updateState = resolveDeviceUpdateState(device, latestBuildJobId);
  const updateLabel = getDeviceUpdateStateLabel(updateState);
  const drawerState = resolveCashDrawerConfigState(device);
  const drawerControlId = `cash-drawer-${device.id}`;

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

          {/* Feature 26.3 — the configuration chip, separate from the pairing
              status chip beside it. They answer different questions: one is
              whether the till is connected, this one is whether it is running
              the owner's newest published menu. `null` for a device with no
              configuration story — a revoked till is not "up to date". */}
          {updateLabel !== null && (
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                updateState === "update_available"
                  ? "bg-amber-100 text-amber-800"
                  : updateState === "update_offered"
                    ? "bg-blue-100 text-blue-700"
                    : "bg-neutral-100 text-neutral-600"
              }`}
            >
              {updateLabel}
            </span>
          )}
        </div>

        <p className="mt-1 text-xs text-neutral-500">
          {formatDevicePlatform(device.platform)} · Paired{" "}
          {formatDeviceDate(device.createdAt)}
          {device.status === "revoked" && device.revokedAt !== null && (
            <> · Revoked {formatDeviceDate(device.revokedAt)}</>
          )}
          {/* Feature 25.1 — the device removed itself. Shown, not hidden: an
              owner should see that a till was taken out of service and when.
              Reachable only when status is `unpaired`, so a revoked device that
              had also unpaired still reads as Revoked. */}
          {device.status === "unpaired" && device.unpairedAt !== null && (
            <> · Unpaired {formatDeviceDate(device.unpairedAt)}</>
          )}
        </p>
      </div>

      {/* Neither a revoked nor an unpaired device has an action. Revocation is
          terminal, and a device that already removed itself has nothing left to
          cut off — offering Revoke there would change a financial boundary for
          no reason. */}
      <div className="flex items-center gap-2">
        {/* Feature 26.3 — shown ONLY in the one actionable state. `up_to_date`
            has nothing to offer, `update_offered` has already been offered and
            pressing again would be a no-op the server would report as
            already_offered, and an inactive device cannot be offered at all —
            the RPC refuses it, so a button here would be a lie. */}
        {updateState === "update_available" && (
          <button
            type="button"
            onClick={() => onOfferUpdate(device)}
            disabled={anyOfferInFlight}
            aria-busy={isOffering}
            className="rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-800 transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 disabled:cursor-not-allowed disabled:text-neutral-300"
          >
            {isOffering ? "Offering…" : "Offer update"}
          </button>
        )}

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
      </div>

      {/* Cash Drawer 1D — this register's automatic-drawer setting.
          `basis-full` so it sits beside the actions where the row is wide and
          drops onto its own line when it is not; the existing flex-wrap row
          does the rest, and neither Revoke nor Offer update moves. */}
      {drawerState !== "none" && (
        <div className="basis-full border-t border-neutral-100 pt-3">
          {drawerState === "configurable" ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {/* A real checkbox: keyboard-operable, announced as a checkbox,
                    and its ON/OFF state is the control's own, never conveyed
                    by colour alone. */}
                <input
                  id={drawerControlId}
                  type="checkbox"
                  checked={device.cashDrawerEnabled}
                  disabled={cashDrawerLocked}
                  aria-busy={isCashDrawerUpdating}
                  aria-describedby={`${drawerControlId}-description`}
                  onChange={(event) => onCashDrawerChange(device, event.target.checked)}
                  className="h-4 w-4 rounded border-neutral-300 text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed"
                />
                <label
                  htmlFor={drawerControlId}
                  className="text-xs font-medium text-neutral-800"
                >
                  Auto-open cash drawer
                </label>
                {/* The pending word, beside the control rather than replacing
                    it: the confirmed state stays visible the whole time. */}
                {isCashDrawerUpdating && (
                  <span className="text-xs text-neutral-500">Updating…</span>
                )}
              </div>
              <p
                id={`${drawerControlId}-description`}
                className="mt-1 text-xs text-neutral-500"
              >
                For this register only. Opens automatically after successful cash
                sales on Windows.
              </p>
            </>
          ) : drawerState === "unsupported_platform" ? (
            <>
              {/* Named, not hidden, and not dressed up as something the owner
                  could fix. There is no control here because there is nothing
                  to turn on, which is a fact about the platform. */}
              <p className="text-xs font-medium text-neutral-800">
                Auto-open cash drawer
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                Automatic drawer opening is supported on Windows registers only.
              </p>
            </>
          ) : (
            <p className="text-xs text-neutral-500">
              Cash drawer settings are unavailable for revoked registers.
            </p>
          )}

          {cashDrawerError !== null && (
            <p role="alert" className="mt-2 text-xs text-red-700">
              {cashDrawerError}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
