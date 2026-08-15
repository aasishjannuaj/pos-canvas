// Feature 16.4B — pure owner-side device-management logic.
//
// Dependency-free (types only): no React, no Supabase, no browser API, so the
// build-selection, readiness and expiry rules are unit-testable under plain
// Node like the rest of this repository's lib/ modules.
//
// Nothing here ever touches a pairing code's plaintext. The code lives in
// component memory for the lifetime of one dialog and nowhere else.
import type { BuildJobSummary } from "@/lib/buildJobs";

// ---------------------------------------------------------------------------
// Build selection — MVP pairs against the latest succeeded build, never a
// build the owner picks by hand.
// ---------------------------------------------------------------------------

/**
 * Picks the build a new device would be pinned to.
 *
 * getProjectBuildJobs already returns newest-first, but this sorts by
 * createdAt rather than trusting arrival order: the pinned build determines
 * the prices a till will charge, so "latest" must be a property of the data,
 * not of the query that happened to fetch it.
 *
 * Only 'succeeded' qualifies. A succeeded build is also the only state that
 * can have a json_config artifact, because finalize_build_job_with_artifact is
 * the sole path to that status — which is exactly what
 * create_device_pairing_token re-verifies server-side.
 */
export function selectLatestSucceededBuild(
  jobs: BuildJobSummary[]
): BuildJobSummary | null {
  const succeeded = jobs.filter((job) => job.status === "succeeded");

  if (succeeded.length === 0) {
    return null;
  }

  return succeeded.reduce((latest, job) =>
    Date.parse(job.createdAt) > Date.parse(latest.createdAt) ? job : latest
  );
}

// ---------------------------------------------------------------------------
// Readiness — the three states the panel can be in before pairing is possible
// ---------------------------------------------------------------------------

export type PairingReadiness =
  | { state: "unsaved_project"; message: string }
  | { state: "no_succeeded_build"; message: string }
  | { state: "ready"; buildJobId: string; buildCreatedAt: string };

// Feature 22 Phase 2 — customer-facing wording only. The states, the readiness
// rule and the Ready-configuration requirement are unchanged.
const UNSAVED_PROJECT_MESSAGE =
  "Save this project before pairing a device. A device is paired to a saved project and one of its published configurations.";

const NO_BUILD_MESSAGE =
  "Publish this configuration before pairing a device. A device runs the exact menu and prices from a published configuration, so there must be one to pin it to.";

export function resolvePairingReadiness(input: {
  projectId: string | null;
  jobs: BuildJobSummary[];
}): PairingReadiness {
  if (input.projectId === null || input.projectId.trim() === "") {
    return { state: "unsaved_project", message: UNSAVED_PROJECT_MESSAGE };
  }

  const build = selectLatestSucceededBuild(input.jobs);

  if (build === null) {
    return { state: "no_succeeded_build", message: NO_BUILD_MESSAGE };
  }

  return {
    state: "ready",
    buildJobId: build.id,
    buildCreatedAt: build.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Pairing-code expiry
//
// The 10-minute lifetime is fixed inside create_device_pairing_token
// (now() + interval '10 minutes'); this only renders the countdown for the
// expiresAt the server returned. It can never extend a real code's life.
// ---------------------------------------------------------------------------

export const PAIRING_CODE_TTL_LABEL = "10 minutes";

/** Whole seconds left, floored at 0. An unparseable timestamp reads as expired. */
export function getPairingCodeRemainingSeconds(
  expiresAt: string,
  now: number = Date.now()
): number {
  const expiry = Date.parse(expiresAt);

  if (Number.isNaN(expiry)) {
    return 0;
  }

  return Math.max(0, Math.floor((expiry - now) / 1000));
}

export function isPairingCodeExpired(
  expiresAt: string,
  now: number = Date.now()
): boolean {
  return getPairingCodeRemainingSeconds(expiresAt, now) === 0;
}

/** M:SS for the countdown. */
export function formatPairingCountdown(remainingSeconds: number): string {
  const safe = Number.isFinite(remainingSeconds)
    ? Math.max(0, Math.floor(remainingSeconds))
    : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Device row presentation
// ---------------------------------------------------------------------------

/** Short, locale-stable date for the paired/revoked columns. */
export function formatDeviceDate(value: string | null): string {
  if (value === null) {
    return "—";
  }

  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    return "—";
  }

  return new Date(parsed).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** A device with no recorded platform still reads sensibly in the list. */
export function formatDevicePlatform(platform: string | null): string {
  if (platform === null || platform.trim() === "") {
    return "Unknown platform";
  }

  // Feature 23.3 — windows added alongside the existing two. The fallback is
  // unchanged and deliberate: an unrecognised non-empty value is shown as-is
  // rather than mapped to "Unknown platform", so a device paired by a newer
  // client than this dashboard still reads sensibly instead of disappearing
  // into a generic label.
  const known: Record<string, string> = {
    android: "Android",
    windows: "Windows",
    web: "Web",
  };

  return known[platform.toLowerCase()] ?? platform;
}
