import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  PAIRING_CODE_GENERATION_ATTEMPTS,
  createPairingFailure,
  formatPairingCode,
  generatePairingCode,
  hashPairingCodeForPostgrest,
} from "@/lib/devicePairing";
import type { CreatePairingTokenResult } from "@/lib/devicePairing";
import type { PairedDeviceSummary } from "@/lib/devices";
import { mapPairedDeviceRow } from "@/lib/devices";
import type { PairedDeviceRow } from "@/lib/devices";

// Feature 16.3, Migration B — the server-authoritative pairing boundary.
//
// NOTE ON PRIVILEGE: this module deliberately uses NO service-role client.
// create_device_pairing_token derives the owner from auth.uid() inside SQL and
// is SECURITY DEFINER, so the ordinary cookie-based RLS-scoped client is
// sufficient to create a token. Device pairing therefore never touches the
// service-role credential at all, which is a strictly smaller blast radius
// than the earlier design where a service-role function trusted a
// caller-supplied owner id.
//
// The plaintext pairing code is generated here, in the Node process, and
// returned to the owner exactly once. Only its SHA-256 digest is sent to the
// database — so the plaintext never crosses the Postgres wire protocol and can
// never appear in query logs or pg_stat_statements.

const GENERIC_FAILURE = "A pairing code could not be created right now.";

// Feature 26.3 — one message for every refusal. Says what is true (nothing
// changed) without confirming whether the device or the build exists.
const OFFER_FAILURE_MESSAGE =
  "This update could not be offered to this device. Refresh and try again.";

function extractUserId(claims: unknown): string | null {
  if (!claims || typeof claims !== "object") {
    return null;
  }

  const sub = (claims as Record<string, unknown>).sub;

  return typeof sub === "string" && sub.trim() !== "" ? sub : null;
}

/**
 * Creates a single-use pairing code for a project + succeeded build job.
 *
 * The returned plaintext code MUST be shown to the owner once and never
 * stored, logged, or re-displayed.
 */
export async function createDevicePairingToken(input: {
  projectId: string;
  buildJobId: string;
}): Promise<CreatePairingTokenResult> {
  if (
    typeof input.projectId !== "string" ||
    input.projectId.trim() === "" ||
    typeof input.buildJobId !== "string" ||
    input.buildJobId.trim() === ""
  ) {
    return createPairingFailure("invalid_request");
  }

  try {
    const supabase = await createClient();

    const { data: claimsData, error: claimsError } =
      await supabase.auth.getClaims();
    const claims = claimsData?.claims ?? null;

    if (claimsError || !claims) {
      return createPairingFailure("not_authenticated");
    }

    if (extractUserId(claims) === null) {
      return createPairingFailure("not_authenticated");
    }

    // Ownership proven through RLS first: a project belonging to someone else
    // is indistinguishable from one that does not exist.
    const { data: projectRow, error: projectError } = await supabase
      .from("projects")
      .select("id")
      .eq("id", input.projectId)
      .maybeSingle();

    if (projectError) {
      return createPairingFailure("unavailable");
    }

    if (!projectRow) {
      return createPairingFailure("project_not_found");
    }

    // The build must be this project's, and must have succeeded. Re-verified
    // inside the SQL function too — this check exists so the caller gets a
    // precise, actionable message instead of a generic failure.
    const { data: jobRow, error: jobError } = await supabase
      .from("build_jobs")
      .select("id, status")
      .eq("id", input.buildJobId)
      .eq("project_id", input.projectId)
      .maybeSingle();

    if (jobError) {
      return createPairingFailure("unavailable");
    }

    if (!jobRow || jobRow.status !== "succeeded") {
      return createPairingFailure("build_not_ready");
    }

    // device_pairing_tokens.token_hash is UNIQUE, so a generated code whose
    // digest already exists — expired, consumed, cancelled or live, since the
    // index covers every row — is rejected by Postgres with a unique violation
    // (23505). At 2^40 possibilities a collision is vanishingly unlikely, but
    // it must not surface as an opaque failure, so a fresh code is generated
    // and retried a small bounded number of times. Neither the code nor its
    // hash is ever logged.
    for (let attempt = 1; attempt <= PAIRING_CODE_GENERATION_ATTEMPTS; attempt += 1) {
      const code = generatePairingCode();

      // The owner is NOT passed: the SQL function derives it from auth.uid()
      // and re-verifies the project, build and artifact itself, so the checks
      // above are for precise messaging, not for authorization. Expiry is
      // fixed at 10 minutes inside SQL and is not a parameter.
      const { data, error } = await supabase.rpc("create_device_pairing_token", {
        p_project_id: input.projectId,
        p_build_job_id: input.buildJobId,
        p_token_hash: hashPairingCodeForPostgrest(code),
      });

      const row = Array.isArray(data) ? data[0] : data;

      // Feature 16.4B — the token id is now required as well as the expiry, so
      // the owner UI can cancel the code it just created. Both come straight
      // from the RPC's own RETURNS TABLE; nothing new is queried.
      if (!error && row?.expires_at && row?.id) {
        return {
          ok: true,
          code,
          formattedCode: formatPairingCode(code),
          expiresAt: row.expires_at as string,
          tokenId: row.id as string,
        };
      }

      const isCollision = (error as { code?: string } | null)?.code === "23505";

      if (!isCollision) {
        // Never echo the raw Postgres message: it can name the project, the
        // build job, or the failing constraint.
        console.error(
          JSON.stringify({
            event: "device_pairing_token_create_failed",
            projectId: input.projectId,
            category: "rpc_failed",
          })
        );
        return createPairingFailure("unavailable");
      }

      console.error(
        JSON.stringify({
          event: "device_pairing_token_hash_collision",
          projectId: input.projectId,
          attempt,
          category: "hash_collision",
        })
      );
    }

    // Retries exhausted. Generic failure only — no code, no hash, no count of
    // existing tokens.
    return createPairingFailure("unavailable");
  } catch {
    // No stack trace, no internal message; the thrown value is not even bound.
    return { ok: false, error: "unavailable", message: GENERIC_FAILURE };
  }
}

/**
 * Lists the devices paired to a project the caller owns.
 *
 * Uses the ordinary RLS-scoped client — `paired_devices` already exposes an
 * owner SELECT policy, so no privileged client is needed and a project owned
 * by someone else simply returns nothing.
 */
export async function getProjectPairedDevices(projectId: string): Promise<{
  devices: PairedDeviceSummary[];
  error: string | null;
}> {
  if (typeof projectId !== "string" || projectId.trim() === "") {
    return { devices: [], error: "A valid project is required." };
  }

  const supabase = await createClient();

  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    return { devices: [], error: "You must be signed in to view devices." };
  }

  const { data, error } = await supabase
    .from("paired_devices")
    // Feature 26.3 — the two offer columns are additive. Both name builds this
    // owner already owns and can already list, so neither widens what the
    // browser can learn; auth_user_id and owner_id remain unselected.
    .select(
      "id, project_id, build_job_id, device_name, platform, created_at, last_seen_at, revoked_at, unpaired_at, offered_build_job_id, offered_at"
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (error) {
    return { devices: [], error: "Unable to load paired devices." };
  }

  const devices = (data ?? [])
    .map((row) => mapPairedDeviceRow(row as PairedDeviceRow))
    .filter((d): d is PairedDeviceSummary => d !== null);

  return { devices, error: null };
}

/**
 * Revokes a paired device. Ownership is enforced inside
 * revoke_paired_device, which raises for a device the caller does not own —
 * so this uses the ordinary authenticated client, not the admin client.
 */
export async function revokePairedDevice(
  deviceId: string
): Promise<{ ok: true; alreadyRevoked: boolean } | { ok: false; message: string }> {
  if (typeof deviceId !== "string" || deviceId.trim() === "") {
    return { ok: false, message: "A valid device is required." };
  }

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("revoke_paired_device", {
    p_device_id: deviceId,
  });

  if (error) {
    console.error(
      JSON.stringify({
        event: "device_revoke_failed",
        deviceId,
        category: "rpc_failed",
      })
    );
    return { ok: false, message: "This device could not be revoked." };
  }

  const result = data as { ok?: boolean; already_revoked?: boolean } | null;

  if (!result?.ok) {
    return { ok: false, message: "This device could not be revoked." };
  }

  return { ok: true, alreadyRevoked: result.already_revoked === true };
}

/**
 * Feature 26.3 — offers a published configuration to ONE paired device.
 *
 * WHAT THIS DOES NOT DO. It does not repin the device, does not touch
 * build_job_id, and does not make the till use anything: an offer is a message,
 * and Feature 26.2's Apply on the device is the only thing that moves a pricing
 * pin. Nothing here can change what a till charges.
 *
 * OWNERSHIP IS THE DATABASE'S, NOT THIS FUNCTION'S. offer_device_config_update
 * is SECURITY DEFINER and resolves the owner from auth.uid(), then requires the
 * device AND the build to belong to that caller, the device to be active, the
 * build to belong to the device's own project, and its status to be
 * 'succeeded'. No owner id is passed, so there is none to forge — the ordinary
 * cookie-scoped client is sufficient and no service-role client is used here or
 * anywhere in this module.
 *
 * EVERY REFUSAL IS ONE MESSAGE. The RPC raises for a device that is missing,
 * someone else's, revoked or unpaired, and for a build that is missing,
 * someone else's, from another project or not succeeded. Those are collapsed
 * deliberately: distinguishing them would let a caller use the error as an
 * oracle for which device and build ids exist, which is the same reason
 * redemption failures collapse to `invalid_code`. The raw Postgres message is
 * never returned — it names the device, the build, and the failing check.
 */
export async function offerDeviceConfigUpdate(input: {
  deviceId: string;
  buildJobId: string;
}): Promise<
  { ok: true; alreadyOffered: boolean } | { ok: false; message: string }
> {
  if (
    typeof input.deviceId !== "string" ||
    input.deviceId.trim() === "" ||
    typeof input.buildJobId !== "string" ||
    input.buildJobId.trim() === ""
  ) {
    return { ok: false, message: "A valid device and configuration are required." };
  }

  // Wrapped, matching createDevicePairingToken. Without it a throw from
  // createClient or from the transport escapes the server action, the caller's
  // await rejects, and the owner is left with a button that never finishes and
  // no message at all. The thrown value is not even bound, so nothing it
  // carries can reach the response.
  let data: unknown;

  try {
    const supabase = await createClient();

    const { data: rpcData, error } = await supabase.rpc(
      "offer_device_config_update",
      {
        p_device_id: input.deviceId,
        p_build_job_id: input.buildJobId,
      }
    );

    if (error) {
      console.error(
        JSON.stringify({
          event: "device_config_offer_failed",
          deviceId: input.deviceId,
          category: "rpc_failed",
        })
      );
      return { ok: false, message: OFFER_FAILURE_MESSAGE };
    }

    data = rpcData;
  } catch {
    console.error(
      JSON.stringify({
        event: "device_config_offer_failed",
        deviceId: input.deviceId,
        category: "threw",
      })
    );
    return { ok: false, message: OFFER_FAILURE_MESSAGE };
  }

  const result = data as { ok?: boolean; already_offered?: boolean } | null;

  if (!result?.ok) {
    return { ok: false, message: OFFER_FAILURE_MESSAGE };
  }

  // already_offered is a SUCCESS. The RPC is idempotent for the same build and
  // deliberately does not move offered_at, so a second press reports the
  // original offer rather than restarting the clock on it.
  return { ok: true, alreadyOffered: result.already_offered === true };
}

/**
 * Cancels an unredeemed pairing token.
 *
 * Ownership and the legal state transition are both enforced inside
 * cancel_device_pairing_token — owners hold only SELECT on the table, so this
 * RPC is the sole write path. Idempotent; a token already redeemed by a device
 * is refused rather than rewritten.
 */
export async function cancelDevicePairingToken(
  tokenId: string
): Promise<
  | { ok: true; alreadyCancelled: boolean }
  | { ok: false; message: string }
> {
  if (typeof tokenId !== "string" || tokenId.trim() === "") {
    return { ok: false, message: "A valid pairing code is required." };
  }

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("cancel_device_pairing_token", {
    p_token_id: tokenId,
  });

  if (error) {
    console.error(
      JSON.stringify({
        event: "device_pairing_token_cancel_failed",
        tokenId,
        category: "rpc_failed",
      })
    );
    return { ok: false, message: "This pairing code could not be cancelled." };
  }

  const result = data as
    | { ok?: boolean; error?: string; already_cancelled?: boolean }
    | null;

  if (!result?.ok) {
    return {
      ok: false,
      message:
        result?.error === "already_redeemed"
          ? "This pairing code has already been used by a device."
          : "This pairing code could not be cancelled.",
    };
  }

  return { ok: true, alreadyCancelled: result.already_cancelled === true };
}
