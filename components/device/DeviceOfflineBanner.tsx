// Feature 24.5A — the operator's one-line answer to "is this till connected?".
//
// TONE, decided deliberately: this is a STATE, not an error. A shop losing its
// internet for ten minutes has not broken anything, and a red alarm on the till
// during a lunch rush teaches staff to ignore the banner. Amber, one sentence,
// and the date the setup was last confirmed — which is the only fact an
// operator can act on, because it tells them how long they have.
//
// NO PERCENTAGES AND NO SPINNERS. There is nothing to measure: the device is
// either reaching the server or it is not.
import type { OfflineRuntimeInfo } from "@/lib/deviceSession";

/** Local, human date. Falls back to the raw value rather than showing "Invalid Date". */
function formatVerified(iso: string): string | null {
  const parsed = Date.parse(iso);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function DeviceOfflineBanner({ offline }: { offline: OfflineRuntimeInfo }) {
  const verified = formatVerified(offline.lastVerifiedAt);

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900"
    >
      <span className="font-semibold">Offline</span>
      <span aria-hidden="true">·</span>
      <span>Using last verified configuration</span>

      {verified !== null && (
        <>
          <span aria-hidden="true">·</span>
          <span className="text-amber-800">Last verified: {verified}</span>
        </>
      )}

      {/* Shown only inside the warning window, so it means something when it
          appears rather than being permanent decoration. */}
      {offline.expiringSoon && (
        <>
          <span aria-hidden="true">·</span>
          <span className="font-semibold">Reconnect soon</span>
        </>
      )}
    </div>
  );
}
