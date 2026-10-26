"use client";

// IND-1 — the live status indicator in the shared header's top-right slot.
//
// Two pills, deliberately separate: CONNECTION (can this till reach POS Canvas
// right now?) and SALES (what does this device still hold?). See lib/liveStatus.ts
// for every label rule and lib/serverReachability.ts for the check schedule.
//
// DISPLAY ONLY. It reads props and runs the display-only reachability loop; it
// writes nothing that checkout, offline entry, reconnect, sync, pairing or the
// employee gate reads. A green "Online" is not confirmation that a sale was saved.
//
// It is not interactive: the existing sync bar below the header keeps Sync now
// and Review, unchanged.
import { useEffect, useRef, useState } from "react";

import { probeDeviceReachability } from "@/lib/device.rpc";
import { readOnlineHint } from "@/lib/deviceConnectivity";
import {
  deriveConnectionView,
  deriveSalesView,
  nextConnectionExpiryAt,
} from "@/lib/liveStatus";
import type { ConnectionTone, ConnectionView, LiveEvidence } from "@/lib/liveStatus";
import type { OfflineSaleStatus } from "@/lib/offlineSaleStatus";
import { startServerReachability } from "@/lib/serverReachability";
import type { ReachabilityControl } from "@/lib/serverReachability";

type LiveStatusIndicatorProps = {
  /** The paired device this till is. A change restarts the loop with no evidence. */
  expectedDeviceId: string;
  runtimeMode: "online" | "offline";
  saleStatus: OfflineSaleStatus;
  /** False until the first saved-sale read has returned. */
  saleStatusLoaded: boolean;
  syncing: boolean;
  /** True while an overlay covers the header: checks pause, as when hidden. */
  paused: boolean;
};

const DOT: Record<ConnectionTone, string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-300",
  bad: "bg-red-400",
  neutral: "bg-white/70 animate-pulse",
};

/** The pill text. The full detail is always in the accessible label and title. */
function connectionText(view: ConnectionView): string {
  if (view.label === "Offline") {
    return `Offline · ${view.detail}`;
  }

  if (view.label === "Checking" && view.detail !== "Checking connection…") {
    return "Checking · reconnecting";
  }

  return view.label;
}

function Pill({ tone, text, label }: { tone: ConnectionTone; text: string; label: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
      className="flex max-w-[13.5rem] items-center gap-1.5 whitespace-nowrap rounded-full border border-white/30 bg-black/15 px-2 py-0.5 text-[11px] font-semibold leading-4 text-white md:max-w-none md:text-xs"
    >
      <span aria-hidden="true" className={`h-2 w-2 flex-none rounded-full ${DOT[tone]}`} />
      <span className="truncate">{text}</span>
    </span>
  );
}

export default function LiveStatusIndicator({
  expectedDeviceId,
  runtimeMode,
  saleStatus,
  saleStatusLoaded,
  syncing,
  paused,
}: LiveStatusIndicatorProps) {
  // `now` is the instant the view was last evaluated: set with each piece of
  // evidence, and once more when a success goes stale (no request involved).
  const [view, setView] = useState<{ evidence: LiveEvidence | null; now: number }>({
    evidence: null,
    now: 0,
  });
  const control = useRef<ReachabilityControl | null>(null);
  const pausedRef = useRef(paused);

  useEffect(() => {
    pausedRef.current = paused;
    control.current?.setPaused(paused);
  }, [paused]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const loop = startServerReachability(
      {
        now: () => Date.now(),
        isVisible: () => document.visibilityState === "visible",
        readOnlineHint: () => readOnlineHint(),
        setTimer: (run, delayMs) => setTimeout(run, delayMs),
        clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
        subscribe: ({ visibility, online, offline }) => {
          document.addEventListener("visibilitychange", visibility);
          window.addEventListener("focus", visibility);
          window.addEventListener("online", online);
          window.addEventListener("offline", offline);

          return () => {
            document.removeEventListener("visibilitychange", visibility);
            window.removeEventListener("focus", visibility);
            window.removeEventListener("online", online);
            window.removeEventListener("offline", offline);
          };
        },
        check: (signal) => probeDeviceReachability(signal),
        report: (evidence) => {
          setView({ evidence, now: evidence?.at ?? Date.now() });
        },
      },
      { expectedDeviceId }
    );

    loop.setPaused(pausedRef.current);
    control.current = loop;

    return () => {
      loop.stop();

      if (control.current === loop) {
        control.current = null;
      }
    };
  }, [expectedDeviceId]);

  // Re-evaluates the label when a fresh success would go stale. One timer, no
  // request: the loop's own schedule decides when the server is asked again.
  useEffect(() => {
    const expiresAt = nextConnectionExpiryAt(view.evidence);

    if (expiresAt === null) {
      return;
    }

    const timer = setTimeout(
      () => setView((current) => ({ ...current, now: Date.now() })),
      Math.max(0, expiresAt - Date.now())
    );

    return () => clearTimeout(timer);
  }, [view.evidence]);

  const connection = deriveConnectionView({
    now: view.now,
    evidence: view.evidence,
    runtimeMode,
  });
  const sales = deriveSalesView({ status: saleStatus, loaded: saleStatusLoaded, syncing });

  return (
    <div
      data-testid="live-status-indicator"
      className="flex flex-none flex-col items-end gap-1 md:flex-row md:items-center md:gap-2"
    >
      <Pill
        tone={connection.tone}
        text={connectionText(connection)}
        label={`Connection: ${connection.label}. ${connection.detail}`}
      />
      <Pill tone={sales.tone} text={sales.label} label={`Sales: ${sales.label}`} />
    </div>
  );
}
