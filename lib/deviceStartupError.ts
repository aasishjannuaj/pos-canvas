// Feature 25.4 — what a FIRST-RUN startup failure actually means.
//
// THE BUG THIS REPLACES. DeviceApp's cold start already computed a
// DeviceFailureKind for the failed sign-in and then, on the branch where no
// device user had ever been persisted, threw it away:
//
//     if (persistedUserId === null) {
//       setState(createDeviceError("offline"));   // regardless of `failure`
//       return;
//     }
//
// So a fresh install whose anonymous sign-in the server REFUSED — the anonymous
// provider disabled, most memorably — was told "No connection" while the
// network, DNS and the service were all fine. The classification was correct
// and never consulted. This module is the consultation.
//
// PURE. No React, no network, no clock, no storage. It converts one classifier
// answer into one error kind and nothing else, which is what makes the mapping
// testable without a DOM.

import type { DeviceFailureKind } from "@/lib/deviceConnectivity";
import type { DeviceErrorKind } from "@/lib/deviceSession";

/**
 * Maps a classified failure to what the operator is told on a fresh install.
 *
 * ONLY POSITIVE TRANSPORT EVIDENCE EARNS "No connection". `transport` is not a
 * default here — classifyDeviceFailure reaches it from an OS socket code or a
 * known fetch-failure message, both of which mean nothing answered. Everything
 * else means either that something answered and refused, or that the failure
 * could not be proven to be the network — and in both cases telling an operator
 * to check their internet connection sends them to fix a thing that is working.
 *
 * `undefined` — no failure kind at all — is the shape a sign-in returns when
 * there was simply no session to read. It cannot demonstrate a transport
 * problem either, so it lands with the rest.
 *
 * DELIBERATELY NOT KEYED ON ANY VENDOR STRING OR CODE. The transport-versus-
 * answered distinction is the classifier's job and is already evidence-based;
 * repeating a provider's error text here would give this file an opinion that
 * goes stale the first time that text is reworded.
 */
export function classifyStartupFailure(
  failure: DeviceFailureKind | undefined
): DeviceErrorKind {
  return failure === "transport" ? "offline" : "startup_failed";
}

/**
 * Whether Retry is worth offering for this kind.
 *
 * TRUE FOR BOTH, and that is a decision rather than an oversight. A refused
 * sign-in is usually a configuration fault that an operator cannot fix from the
 * till, but it is one an administrator can fix in seconds — and when they do,
 * the operator needs a way to proceed that is not "reinstall the app". Retry
 * runs the same cold start once, on a press, and starts no timer: a definite
 * refusal must never become a backoff loop quietly minting anonymous users.
 */
export function startupFailureOffersRetry(kind: DeviceErrorKind): boolean {
  return kind === "offline" || kind === "startup_failed" || kind === "unavailable";
}
