import "server-only";

import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  LOGO_BUCKET,
  MAX_LOGO_BYTES,
  MAX_LOGO_DIMENSION,
  createLogoObjectPath,
  detectImageMimeType,
  isAllowedLogoMimeType,
  readImageDimensions,
} from "@/lib/logoUpload";
import type { BrandingLogo, LogoRejectionReason } from "@/lib/logoUpload";

// Feature 19 — the privileged half of the logo upload.
//
// "server-only" for the same reason lib/buildJobs.server.ts carries it: this
// module constructs the service-role client, which bypasses RLS entirely. If it
// were ever imported from a Client Component the build fails rather than
// shipping the credential to a browser.
//
// AUTHENTICATION AND OWNERSHIP ARE NOT DONE HERE. They are the action
// boundary's job (lib/logoUpload.actions.ts), which must have already
// established both before calling this. What this module owns is everything
// that must not be decided by a caller:
//
//   - the real format, from MAGIC BYTES rather than a browser-reported type
//   - the real pixel dimensions, read from the same header
//   - the sha-256 of the exact bytes received
//   - the object path, derived from the already-validated project id
//
// A browser therefore cannot choose where its bytes land, what they are called,
// what checksum is recorded, or what mime type is persisted — even though it is
// the thing that triggers the upload.
//
// NOTHING HERE IS EVER LOGGED. Not the bytes, not the credential, not the
// caller's token. The result is a small value or a reason code; failures return
// a category, never a raw storage error, matching the sanitized-error posture
// of lib/buildJobs.server.ts.

/** Supabase reports an existing object on an upsert:false collision. */
const ALREADY_EXISTS_STATUS = "409";

export type UploadProjectLogoResult =
  | { ok: true; logo: BrandingLogo }
  | { ok: false; reason: LogoRejectionReason | "storage_failed" };

/**
 * Validates and stores one logo, returning the reference to persist.
 *
 * `projectId` MUST already be a project the caller owns — this function does
 * not and cannot check that.
 */
export async function uploadProjectLogo(input: {
  projectId: string;
  file: File;
}): Promise<UploadProjectLogoResult> {
  // ---------------------------------------------------------------------
  // 1. Size, before anything is read into memory in full.
  //
  // File.size is metadata and could disagree with the real stream, so the
  // decoded length is re-checked below. This early exit only avoids buffering
  // something obviously oversized.
  // ---------------------------------------------------------------------
  if (!Number.isFinite(input.file.size) || input.file.size <= 0) {
    return { ok: false, reason: "unreadable" };
  }

  if (input.file.size > MAX_LOGO_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  let bytes: Uint8Array;

  try {
    bytes = new Uint8Array(await input.file.arrayBuffer());
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  // The authoritative size check: the actual byte count, not the claim.
  if (bytes.length === 0) {
    return { ok: false, reason: "unreadable" };
  }

  if (bytes.length > MAX_LOGO_BYTES) {
    return { ok: false, reason: "too_large" };
  }

  // ---------------------------------------------------------------------
  // 2. Format, from the bytes themselves.
  //
  // A browser's File.type is caller-controlled: renaming evil.svg to logo.png
  // is enough to forge it. detectImageMimeType reads the actual signature, and
  // its answer — never the claim — is what gets stored and what determines the
  // object's extension.
  // ---------------------------------------------------------------------
  const detectedMimeType = detectImageMimeType(bytes);

  if (detectedMimeType === null || !isAllowedLogoMimeType(detectedMimeType)) {
    return { ok: false, reason: "unsupported_type" };
  }

  // A claimed type that disagrees with the real one is rejected outright rather
  // than silently corrected. The two disagreeing means the request is not what
  // it says it is, and storing it under either answer would be a guess.
  if (isAllowedLogoMimeType(input.file.type) && input.file.type !== detectedMimeType) {
    return { ok: false, reason: "unsupported_type" };
  }

  // ---------------------------------------------------------------------
  // 3. Dimensions, from the same header walk.
  //
  // null means the header is truncated, corrupt, or not the structure the
  // signature promised — all of which are rejections, never "unknown but
  // acceptable".
  // ---------------------------------------------------------------------
  const dimensions = readImageDimensions(bytes, detectedMimeType);

  if (dimensions === null) {
    return { ok: false, reason: "unreadable" };
  }

  if (
    dimensions.width > MAX_LOGO_DIMENSION ||
    dimensions.height > MAX_LOGO_DIMENSION
  ) {
    return { ok: false, reason: "too_many_pixels" };
  }

  // ---------------------------------------------------------------------
  // 4. Content address.
  //
  // The digest of the exact bytes received. This names the object, which is
  // what makes every stored reference permanently immutable.
  // ---------------------------------------------------------------------
  const checksum = createHash("sha256").update(bytes).digest("hex");

  let path: string;

  try {
    path = createLogoObjectPath({
      projectId: input.projectId,
      checksum,
      mimeType: detectedMimeType,
    });
  } catch {
    // Only reachable if the caller passed a non-UUID project id, which the
    // action boundary already prevents.
    return { ok: false, reason: "storage_failed" };
  }

  let admin: ReturnType<typeof createAdminClient>;

  try {
    admin = createAdminClient();
  } catch {
    // SUPABASE_SERVICE_ROLE_KEY missing or malformed. No environment variable
    // name or value is ever surfaced to the caller.
    return { ok: false, reason: "storage_failed" };
  }

  // ---------------------------------------------------------------------
  // 5. Upload, never overwrite.
  //
  // upsert:false is load-bearing rather than defensive. An object at this path
  // can only have been produced by these exact bytes, so overwriting would at
  // best be a no-op and at worst — if the addressing were ever weakened — would
  // silently rewrite the branding of every historical build pinned to it.
  // ---------------------------------------------------------------------
  const { error: uploadError } = await admin.storage
    .from(LOGO_BUCKET)
    .upload(path, bytes, { contentType: detectedMimeType, upsert: false });

  if (uploadError && !isAlreadyExistsError(uploadError)) {
    return { ok: false, reason: "storage_failed" };
  }

  // An already-exists collision is SUCCESS: the owner re-uploaded a logo they
  // already have, or two projects legitimately share one. The bytes at that
  // path are identical by construction, so reusing it is correct and avoids a
  // duplicate object. Deliberately narrow — every other storage error above is
  // still a failure, so this does not become a blanket error suppressor.
  return {
    ok: true,
    logo: {
      path,
      mimeType: detectedMimeType,
      width: dimensions.width,
      height: dimensions.height,
      checksum,
    },
  };
}

/**
 * True only for the specific "an object already exists at this path" condition.
 *
 * Matched on the structured status/error fields Supabase Storage returns rather
 * than on free-text alone, so an unrelated failure whose message happens to
 * contain the word "exists" is not mistaken for a successful reuse.
 */
function isAlreadyExistsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { statusCode?: unknown; error?: unknown; message?: unknown };

  if (candidate.statusCode === ALREADY_EXISTS_STATUS || candidate.statusCode === 409) {
    return true;
  }

  if (candidate.error === "Duplicate") {
    return true;
  }

  return (
    typeof candidate.message === "string" &&
    candidate.message.toLowerCase().includes("already exists")
  );
}
