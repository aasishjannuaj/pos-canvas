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

      if (!error && row?.expires_at) {
        return {
          ok: true,
          code,
          formattedCode: formatPairingCode(code),
          expiresAt: row.expires_at as string,
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
    .select(
      "id, project_id, build_job_id, device_name, platform, created_at, last_seen_at, revoked_at"
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
