"use server";

import { getProjectById } from "@/lib/projects.server";
import { LOGO_REJECTION_MESSAGES, isValidLogoProjectId } from "@/lib/logoUpload";
import type { BrandingLogo } from "@/lib/logoUpload";
import { uploadProjectLogo } from "@/lib/logoUpload.server";

// Feature 19 — the ONLY boundary a browser can reach for a logo upload.
//
// Next compiles this file's exports into server-action references; the
// implementation, and everything it reaches (lib/logoUpload.server.ts, the
// service-role client, node:crypto), never ships in the client bundle. This
// mirrors lib/buildJobs.actions.ts, which is the established pattern for a
// privileged operation triggered from the Builder.
//
// WHAT THE BROWSER MAY SUPPLY: a project id and a file. That is the entire
// input surface, and it is enforced by the parameter type — there is nowhere
// here to put a storage path, a checksum, dimensions, or a mime type to
// persist. Every one of those is computed server-side from the bytes actually
// received.
//
// ORDER IS THE SECURITY PROPERTY, and it is strict:
//   1. authenticate the caller (cookie-backed user client)
//   2. verify the project exists AND belongs to them
//   3. only then reach for the service-role credential and upload
//
// Step 2 uses getProjectById exactly as createBuildJob does. That call runs
// under the normal RLS-bound client, so a project owned by someone else comes
// back indistinguishable from one that does not exist — this can never reveal
// whether another user owns a given id.

export type UploadLogoActionResult =
  | { ok: true; logo: BrandingLogo }
  | { ok: false; message: string };

const SIGN_IN_MESSAGE = "You must be signed in to upload a logo.";
const PROJECT_UNAVAILABLE_MESSAGE = "That project is unavailable.";
const STORAGE_FAILED_MESSAGE =
  "The logo could not be uploaded. Check your connection and try again.";

export async function uploadProjectLogoAction(input: {
  projectId: string;
  file: File;
}): Promise<UploadLogoActionResult> {
  // Shape check before anything else. A project id that is not a UUID cannot
  // name a real row, and rejecting it here means createLogoObjectPath's own
  // guard is never the thing a user sees.
  if (!isValidLogoProjectId(input.projectId)) {
    return { ok: false, message: PROJECT_UNAVAILABLE_MESSAGE };
  }

  if (!(input.file instanceof File)) {
    return { ok: false, message: LOGO_REJECTION_MESSAGES.unreadable };
  }

  // Steps 1 and 2 together: getProjectById authenticates via the cookie client
  // and returns null for anything this caller cannot see under RLS.
  const { project, error } = await getProjectById(input.projectId);

  if (error !== null && project === null) {
    // Distinguish "not signed in" from "not yours" only where the underlying
    // helper already does; both collapse to a safe message otherwise.
    return {
      ok: false,
      message: error.includes("signed in") ? SIGN_IN_MESSAGE : PROJECT_UNAVAILABLE_MESSAGE,
    };
  }

  if (project === null || project.id !== input.projectId) {
    return { ok: false, message: PROJECT_UNAVAILABLE_MESSAGE };
  }

  // Step 3. The project id handed on is the one just verified, never the raw
  // input again — so the object path is derived from validated state.
  const result = await uploadProjectLogo({
    projectId: project.id,
    file: input.file,
  });

  if (!result.ok) {
    return {
      ok: false,
      message:
        result.reason === "storage_failed"
          ? STORAGE_FAILED_MESSAGE
          : LOGO_REJECTION_MESSAGES[result.reason],
    };
  }

  // Deliberately returns the logo only. No bucket name, no credential, no
  // signed URL, no raw storage response.
  return { ok: true, logo: result.logo };
}
