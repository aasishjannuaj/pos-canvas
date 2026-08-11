import "server-only";
import {
  GITHUB_API_VERSION,
  GITHUB_BUILD_WORKER_DISPATCH_URL,
  GITHUB_BUILD_WORKER_USER_AGENT,
  buildWorkflowDispatchBody,
  interpretWorkflowDispatchStatus,
} from "@/lib/githubBuildWorker";
import type { WorkflowDispatchOutcome } from "@/lib/githubBuildWorker";

// Feature 17.2 — the ONLY module that touches the GitHub credential.
//
// `import "server-only"` is the load-bearing line: Next.js fails the build if
// any client component pulls this module into the browser bundle, so the token
// read below cannot reach a browser even by accident. It is reached exclusively
// from lib/buildJobs.actions.ts ("use server"), never from a React component.
//
// CREDENTIAL DISCIPLINE, asserted by lib/githubBuildWorker.guards.test.ts:
//   * the variable is GITHUB_BUILD_WORKER_TOKEN, never NEXT_PUBLIC_-prefixed
//     (a NEXT_PUBLIC_ variable is inlined into client JavaScript by definition)
//   * the token is read inside the function, never at module scope, so importing
//     this file never captures a value
//   * the token appears in exactly one expression — the Authorization header —
//     and is never logged, never returned, and never put in an error
//   * no response body and no statusText is ever read, logged, or returned:
//     the only thing taken from GitHub's answer is its numeric status
//
// WHAT IS *NOT* SENT: no build job id, no project id, no owner id, no config.
// A dispatch is a content-free "there is work" signal. The worker then claims
// from Postgres under RLS-bypassing service-role credentials it already holds,
// so GitHub never learns anything about the customer whose build this is.

const TOKEN_ENV_VAR = "GITHUB_BUILD_WORKER_TOKEN";

/**
 * A build request must not hang on GitHub. The owner's Build click already
 * awaits this call, and the queued row is already committed by the time we get
 * here — so a slow GitHub should degrade to the retry path quickly rather than
 * hold the Server Action open.
 */
const DISPATCH_TIMEOUT_MS = 10_000;

/**
 * Asks GitHub to start a Build worker run now.
 *
 * Fire-and-confirm: a 204 means GitHub accepted the dispatch, NOT that a build
 * succeeded, and this function deliberately learns nothing further. The
 * build_jobs row remains the only source of truth for what happened to a build;
 * this call's outcome only decides whether the UI offers "Retry processing".
 *
 * Never throws. Every failure mode — missing token, network error, timeout,
 * non-204 status — becomes an `ok: false` outcome, because a failed dispatch
 * must never turn a successfully queued build into a failed request.
 */
export async function dispatchBuildWorkerWorkflow(): Promise<WorkflowDispatchOutcome> {
  const token = process.env[TOKEN_ENV_VAR];

  if (typeof token !== "string" || token.trim() === "") {
    // Distinct from a network failure on purpose: this one is a deployment
    // mistake (the variable was never set in Vercel), and it will not fix
    // itself on retry. The name of the variable stays in this log line and
    // never in the returned outcome.
    console.error(
      `dispatchBuildWorkerWorkflow: ${TOKEN_ENV_VAR} is not configured; ` +
        "no build worker run was requested."
    );
    return { ok: false, reason: "not_configured" };
  }

  try {
    const response = await fetch(GITHUB_BUILD_WORKER_DISPATCH_URL, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": GITHUB_BUILD_WORKER_USER_AGENT,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: buildWorkflowDispatchBody(),
      // Next.js caches fetch responses in some server contexts. A dispatch is a
      // side effect; a cached one would silently stop reaching GitHub.
      cache: "no-store",
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });

    const outcome = interpretWorkflowDispatchStatus(response.status);

    if (!outcome.ok) {
      // Status code and reason only. GitHub's response body is never read, so
      // there is nothing here that could echo a request header back into a log.
      console.error(
        "dispatchBuildWorkerWorkflow: GitHub declined the dispatch " +
          `(status ${response.status}, reason ${outcome.reason}).`
      );
    }

    return outcome;
  } catch {
    // Network failure, DNS failure, or the 10s timeout above. The error object
    // is deliberately not inspected: a fetch error can carry the request it
    // came from, and that request carries the Authorization header.
    console.error(
      "dispatchBuildWorkerWorkflow: the GitHub API could not be reached."
    );
    return { ok: false, reason: "unreachable" };
  }
}
