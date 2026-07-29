// Feature 15.7 — Secure Artifact Download: the pure, dependency-free
// half of the download path. Constants, the browser-facing result type,
// the eligibility decision, and the single source of every public error
// message. No React, no Supabase, no Node-only import — the authenticated
// reads, the service-role client, and the signed-URL call all live in
// lib/buildJobs.server.ts (see createBuildArtifactDownloadUrl), which
// imports from this file rather than duplicating any of it.
//
// Deliberately kept separate from lib/buildJobs.artifact.ts: that module
// is the *worker's* artifact-production domain (byte generation,
// checksums, storage paths, upload/finalize decisions) and is only ever
// imported by worker/once.ts. This one is the *reader's* download domain,
// imported by server code that a browser can reach. They share only the
// artifact-type concept, re-declared here as its own explicitly-named
// download constant so the download path can never accidentally start
// serving whatever future artifact type the worker happens to produce.
import type { BuildStatus } from "@/lib/buildJobs";

// Feature 15.7 — 60 seconds. The URL is consumed inside the same
// click -> anchor-click flow that produced it, so a longer window would
// only extend how long a bearer credential stays valid for no user-facing
// benefit. Every click generates a brand-new URL; none is ever cached,
// persisted, or reused.
export const DOWNLOAD_SIGNED_URL_SECONDS = 60;

// Feature 15.7 — the one artifact type this feature serves, as a
// server-controlled constant. Never accepted as a Server Action argument:
// a future job may also carry a 'log', 'apk', or 'desktop_installer'
// artifact (Feature 15.6's UNIQUE (build_job_id, artifact_type) allows
// exactly one of each), and none of those may be reachable through this
// download path until a feature deliberately adds them.
export const JSON_CONFIG_DOWNLOAD_ARTIFACT_TYPE = "json_config";

export const BUILD_ARTIFACTS_DOWNLOAD_BUCKET = "build-artifacts";

export type DownloadArtifactErrorCode =
  | "unauthenticated"
  | "not_found"
  | "not_ready"
  | "expired"
  | "unavailable";

// Feature 15.7 — the exact shape the browser receives. The success arm
// carries only a short-lived URL and the server-trusted filename: no
// storage_path, no owner_id, no project_id, no checksum, no bucket name,
// no artifact id, and nothing about the service-role credential — none of
// those have a field to leak through here in the first place, which is
// the point (the same "no field, no leak" reasoning behind
// BuildJobSummary in lib/buildJobs.ts).
export type DownloadArtifactResult =
  | {
      ok: true;
      url: string;
      filename: string;
    }
  | {
      ok: false;
      error: DownloadArtifactErrorCode;
      message: string;
    };

// Feature 15.7 — every public message, in one table. All are fixed,
// first-party, and sanitized: a raw Supabase/Storage error string can
// never reach a caller through this map, because no code path here ever
// interpolates one.
//
// "not_found" deliberately covers both "no such build job/artifact" and
// "it exists but belongs to someone else" — the two are never
// distinguishable to a caller, matching getBuildJobById's existing
// RLS-based guarantee (an unowned row simply doesn't come back).
const DOWNLOAD_ARTIFACT_ERROR_MESSAGES: Record<
  DownloadArtifactErrorCode,
  string
> = {
  unauthenticated: "Please sign in again to download this artifact.",
  not_found: "This build artifact could not be found.",
  not_ready: "This build is not ready for download.",
  expired: "This build artifact has expired.",
  unavailable: "The build artifact is temporarily unavailable.",
};

// Feature 15.7 — the message for an *unexpected* exception, distinct from
// the "unavailable" storage-signing message above even though both are
// reported under the same "unavailable" error code: one means "we know
// the object couldn't be signed right now", the other means "something
// we did not anticipate went wrong." Neither ever includes a stack trace
// or an internal error string.
export const UNEXPECTED_DOWNLOAD_ERROR_MESSAGE =
  "The artifact could not be downloaded.";

export function getDownloadArtifactErrorMessage(
  code: DownloadArtifactErrorCode
): string {
  return DOWNLOAD_ARTIFACT_ERROR_MESSAGES[code];
}

// Feature 15.7 — the only way server code constructs a failure result, so
// a hand-written (and possibly unsanitized) message can never diverge
// from the approved table above.
export function createDownloadArtifactFailure(
  code: DownloadArtifactErrorCode
): Extract<DownloadArtifactResult, { ok: false }> {
  return {
    ok: false,
    error: code,
    message: getDownloadArtifactErrorMessage(code),
  };
}

export function createUnexpectedDownloadFailure(): Extract<
  DownloadArtifactResult,
  { ok: false }
> {
  return {
    ok: false,
    error: "unavailable",
    message: UNEXPECTED_DOWNLOAD_ERROR_MESSAGE,
  };
}

export type BuildArtifactDownloadEligibility =
  | "eligible"
  | "not_ready"
  | "expired";

// Feature 15.7 — the pure eligibility decision, separated from any
// Supabase query so it is testable without a database. Deliberately does
// NOT decide authentication, ownership, existence, or storage
// availability: those are all answered by the authenticated RLS-scoped
// reads and the signing call in lib/buildJobs.server.ts, and none of them
// can be reduced to a pure function over these three inputs.
//
// Order matters: a non-succeeded job is "not_ready" regardless of any
// expiry value, so the status check comes first. `now` is an explicit
// parameter (never Date.now() read internally) so tests can pin the clock.
// A null expiresAt means "does not expire" — the current state of every
// json_config artifact Feature 15.6 writes.
export function decideBuildArtifactDownloadEligibility(input: {
  buildStatus: BuildStatus;
  expiresAt: string | null;
  now: Date;
}): BuildArtifactDownloadEligibility {
  if (input.buildStatus !== "succeeded") {
    return "not_ready";
  }

  if (input.expiresAt !== null) {
    const expiresAtMs = new Date(input.expiresAt).getTime();

    // An unparseable expires_at is treated as expired rather than
    // ignored: this column is written only by trusted server code, so a
    // value that can't be read is a real anomaly, and failing closed is
    // the safe direction for a download gate.
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= input.now.getTime()) {
      return "expired";
    }
  }

  return "eligible";
}
