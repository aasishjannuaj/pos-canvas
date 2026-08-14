"use client";

import {
  LOGO_ACCEPT_ATTRIBUTE,
  LOGO_REJECTION_MESSAGES,
  MAX_LOGO_BYTES,
  checkLogoFileBeforeUpload,
  createLogoPublicUrl,
} from "@/lib/logoUpload";
import type { BrandingLogo } from "@/lib/logoUpload";

// Feature 19 — the Logo control, replacing the "Logo upload coming soon"
// placeholder inside the EXISTING Branding section. No new editor section, no
// navigation change.
//
// Presentational, following the ModifierGroupsEditor convention: it holds no
// draft state of its own. The logo lives in exactly one place — EditorShell's
// projectConfig.branding — and upload status lives beside it in EditorShell,
// so this component only renders what it is given and reports intent upward.

export type LogoUploadStatus = "idle" | "uploading" | "error";

type BrandingLogoFieldProps = {
  logo: BrandingLogo | undefined;
  logoBaseUrl: string | undefined;
  /** null while the project has never been saved — upload is blocked then. */
  projectId: string | null;
  status: LogoUploadStatus;
  error: string | null;
  onUpload: (file: File) => void;
  onRemove: () => void;
  /** Surfaces a client-side rejection without a pointless round trip. */
  onReject: (message: string) => void;
};

const LABEL_CLASS =
  "text-xs font-medium uppercase tracking-wide text-neutral-400";

const BUTTON_CLASS =
  "rounded-full border border-neutral-200 px-4 py-2 text-xs font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50";

const UNSAVED_PROJECT_MESSAGE = "Save this project before uploading a logo.";

/** "PNG · 240 × 80" — what is safely known without storing a filename. */
function describeLogo(logo: BrandingLogo): string {
  const format = logo.mimeType.replace("image/", "").toUpperCase();
  return `${format === "JPEG" ? "JPEG" : format} · ${logo.width} × ${logo.height}`;
}

export default function BrandingLogoField({
  logo,
  logoBaseUrl,
  projectId,
  status,
  error,
  onUpload,
  onRemove,
  onReject,
}: BrandingLogoFieldProps) {
  const previewUrl = logo ? createLogoPublicUrl(logo.path, logoBaseUrl) : null;
  const isUploading = status === "uploading";

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    // Reset immediately so selecting the SAME file again still fires onChange —
    // otherwise a retry after a failed upload would appear to do nothing.
    event.target.value = "";

    if (!file) {
      return;
    }

    if (projectId === null) {
      onReject(UNSAVED_PROJECT_MESSAGE);
      return;
    }

    // Client pre-check: instant feedback only. The server repeats both of these
    // against the real bytes and additionally verifies magic bytes and pixel
    // dimensions, so nothing here is a security boundary.
    const rejection = checkLogoFileBeforeUpload(file);

    if (rejection !== null) {
      onReject(LOGO_REJECTION_MESSAGES[rejection]);
      return;
    }

    onUpload(file);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className={LABEL_CLASS}>Logo</label>

      {logo && previewUrl ? (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-3">
          {/* Checkerboard behind the preview, so an owner can actually see
              whether their PNG's transparency is what they expected. */}
          <div
            className="flex h-20 items-center justify-center rounded-lg border border-neutral-100"
            style={{
              backgroundImage:
                "linear-gradient(45deg,#f1f5f9 25%,transparent 25%),linear-gradient(-45deg,#f1f5f9 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#f1f5f9 75%),linear-gradient(-45deg,transparent 75%,#f1f5f9 75%)",
              backgroundSize: "12px 12px",
              backgroundPosition: "0 0,0 6px,6px -6px,-6px 0px",
            }}
          >
            {/* Plain <img> for the same reason PosHeader uses one: the file is
                already size- and dimension-bounded by the upload path, and
                next/image would need the Supabase origin registered in
                images.remotePatterns per environment. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
            <img
              src={previewUrl}
              alt="Business logo"
              className="max-h-16 w-auto max-w-full object-contain"
            />
          </div>

          <p className="text-xs text-neutral-500">{describeLogo(logo)}</p>

          <div className="flex gap-2">
            <label className={`${BUTTON_CLASS} cursor-pointer`}>
              {isUploading ? "Uploading…" : "Replace"}
              <input
                type="file"
                accept={LOGO_ACCEPT_ATTRIBUTE}
                disabled={isUploading}
                onChange={handleFileChange}
                className="sr-only"
              />
            </label>

            <button
              type="button"
              onClick={onRemove}
              disabled={isUploading}
              className={BUTTON_CLASS}
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-200 p-6 text-center">
          <span className="text-2xl">🖼️</span>
          <p className="text-xs text-neutral-500">
            PNG, JPEG or WebP · Max {Math.round(MAX_LOGO_BYTES / 1024)} KB
          </p>

          <label className={`${BUTTON_CLASS} mt-1 cursor-pointer`}>
            {isUploading ? "Uploading…" : "Upload logo"}
            <input
              type="file"
              accept={LOGO_ACCEPT_ATTRIBUTE}
              disabled={isUploading}
              onChange={handleFileChange}
              className="sr-only"
            />
          </label>
        </div>
      )}

      {/* A failed upload never disturbs the logo above — this is the only thing
          that changes on failure. */}
      {status === "error" && error && (
        <p aria-live="polite" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
