// Feature 17.2 — the GitHub Actions workflow_dispatch contract, expressed as
// pure values and pure functions.
//
// Split out from lib/githubBuildWorker.server.ts for the same reason
// lib/supabase/adminConfig.ts is split out from lib/supabase/admin.ts: the part
// worth testing (which repository, which workflow, which ref, and what each
// HTTP status means) should be reachable from a unit test, while the part that
// touches a credential stays behind `import "server-only"`.
//
// THIS MODULE NEVER SEES THE TOKEN. It reads no environment variable, builds
// no Authorization header, and performs no I/O. That is deliberate and is
// asserted by lib/githubBuildWorker.guards.test.ts — it means nothing here can
// leak a secret even if it were somehow bundled for a browser.

/**
 * The repository whose Actions queue POS Canvas drives.
 *
 * Hardcoded rather than configured. A misconfigured environment variable here
 * would silently point production at someone else's repository — and the token
 * is scoped to this repository alone, so a wrong value cannot even work, it can
 * only fail confusingly.
 */
export const GITHUB_BUILD_WORKER_OWNER = "aasishjannuaj";
export const GITHUB_BUILD_WORKER_REPO = "pos-canvas";

/**
 * Referenced by FILE NAME, not by numeric workflow id. The file name survives
 * the workflow being deleted and recreated; a numeric id does not.
 */
export const GITHUB_BUILD_WORKER_WORKFLOW_FILE = "build-worker.yml";

/**
 * workflow_dispatch requires a git ref, and GitHub resolves the workflow's
 * CONTENTS from that ref. Pinned to the default branch: dispatching a side
 * branch would run whatever version of the workflow lives there, with the
 * production service-role secrets attached.
 */
export const GITHUB_BUILD_WORKER_REF = "main";

/** The version-pinned REST surface, per GitHub's current API-versioning scheme. */
export const GITHUB_API_VERSION = "2022-11-28";

/** GitHub rejects API requests without a User-Agent. */
export const GITHUB_BUILD_WORKER_USER_AGENT = "pos-canvas-build-dispatcher";

export const GITHUB_BUILD_WORKER_DISPATCH_URL =
  `https://api.github.com/repos/${GITHUB_BUILD_WORKER_OWNER}/${GITHUB_BUILD_WORKER_REPO}` +
  `/actions/workflows/${GITHUB_BUILD_WORKER_WORKFLOW_FILE}/dispatches`;

/**
 * Why a dispatch did not happen.
 *
 * Server-side diagnostics only — every one of these collapses to a single
 * user-facing sentence before it reaches a browser. They exist so a Vercel log
 * line can distinguish "the token is missing" from "GitHub was unreachable",
 * which are very different operator problems with identical UI.
 */
export type WorkflowDispatchFailureReason =
  | "not_configured"
  | "unauthorized"
  | "not_found"
  | "rejected"
  | "unreachable";

export type WorkflowDispatchOutcome =
  | { ok: true }
  | { ok: false; reason: WorkflowDispatchFailureReason };

/**
 * The entire request body. `ref` is the only field sent: this workflow declares
 * no `inputs`, and GitHub rejects a dispatch carrying inputs the workflow does
 * not declare. Nothing about the build job — no id, no project, no owner — is
 * sent to GitHub; the worker discovers its work by claiming from Postgres.
 */
export function buildWorkflowDispatchBody(): string {
  return JSON.stringify({ ref: GITHUB_BUILD_WORKER_REF });
}

/**
 * Maps a workflow_dispatch response status to an outcome.
 *
 * 204 No Content is the documented success: GitHub accepts the dispatch and
 * returns no body, so there is no run id to report and nothing to parse.
 */
export function interpretWorkflowDispatchStatus(
  status: number
): WorkflowDispatchOutcome {
  if (status === 204) {
    return { ok: true };
  }

  // 401 is a bad/expired token; 403 is a token whose fine-grained permissions
  // lack Actions: write, or one whose repository access does not include this
  // repository. Both are "fix the PAT", so they share a reason.
  if (status === 401 || status === 403) {
    return { ok: false, reason: "unauthorized" };
  }

  // GitHub deliberately answers 404 rather than 403 when a token cannot see a
  // repository at all, so this covers both a genuinely missing workflow file
  // and a token scoped to the wrong repository.
  if (status === 404) {
    return { ok: false, reason: "not_found" };
  }

  // 422 is the shape/ref rejection: an unknown ref, or a workflow that carries
  // no workflow_dispatch trigger on that ref.
  if (status === 422) {
    return { ok: false, reason: "rejected" };
  }

  // 5xx and anything else unexpected. Treated as transient — the retry path
  // exists precisely for this case.
  return { ok: false, reason: "unreachable" };
}
