"use client";

import { useState } from "react";
import { createLogoPublicUrl } from "@/lib/logoUpload";
import type { BrandingSettings, BusinessProfile } from "@/lib/projectConfig";

// Feature 19 — the ONE POS header, shared by every surface that renders one.
//
// Before this there were two near-identical implementations: PosRuntime's
// (which serves both the owner runtime and the paired device) and
// EditorPreview's (the Builder's phone mockup). Adding a logo to each
// separately would have guaranteed they drifted. The three POS layouts
// (MenuGrid/ProductGrid/ServiceGrid) render no header at all, so there is no
// per-template logo code anywhere — this component is the only place a logo is
// drawn on a POS screen.
//
// Purely presentational: no fetching, no state beyond "did this image fail to
// load", no knowledge of Supabase or of which host is rendering it.

type PosHeaderProps = {
  businessProfile: BusinessProfile;
  branding: BrandingSettings;
  /**
   * The origin a stored logo path resolves against, supplied by the caller
   * rather than read here. Two reasons: this component stays a pure function of
   * its props (testable with no environment), and PosRuntime — whose contract
   * is that it knows nothing about what is behind its host — never has to name
   * the storage provider. undefined disables logo rendering.
   */
  logoBaseUrl: string | undefined;
  /** The Builder's phone mockup is narrower than a real till. */
  size?: "full" | "compact";
  /** Optional right-hand affordance (the owner runtime's Back to Dashboard). */
  trailing?: React.ReactNode;
};

/**
 * Caps the logo's rendered height while preserving its aspect ratio.
 *
 * The full header is h-16 (64px) and the compact one is roughly 44px tall, so
 * these leave the existing vertical rhythm untouched — a no-logo header is
 * pixel-identical to what shipped before this feature.
 */
const LOGO_MAX_HEIGHT = { full: 32, compact: 24 } as const;

export default function PosHeader({
  businessProfile,
  branding,
  logoBaseUrl,
  size = "full",
  trailing,
}: PosHeaderProps) {
  // A logo that fails to load must never blank the header. This flips on error
  // and the business name carries the branding alone — the same outcome a
  // no-logo project already has.
  const [logoFailed, setLogoFailed] = useState(false);

  const businessName = businessProfile.businessName.trim();

  // Null unless the stored path passes the strict validator AND the environment
  // supplies a usable origin. A malformed or hostile value that somehow reached
  // projects.config cannot become an image source.
  const logoUrl = branding.logo
    ? createLogoPublicUrl(branding.logo.path, logoBaseUrl)
    : null;

  const showLogo = branding.logo !== undefined && logoUrl !== null && !logoFailed;

  const maxHeight = LOGO_MAX_HEIGHT[size];

  return (
    <header
      className={
        size === "full"
          ? "flex h-16 flex-none items-center justify-between px-6"
          : "flex flex-none items-center justify-between px-4 py-3"
      }
      style={{ backgroundColor: branding.accentColor }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {showLogo && branding.logo && (
          // A plain <img>, not next/image: the file is already bounded to
          // 512 KB and 2048px by the upload path, so there is nothing for an
          // optimizer to do, and this keeps the paired device — a WebView on a
          // Capacitor shell pointed at the hosted runtime — off the
          // /_next/image route entirely. next/image would also require
          // registering the Supabase origin in images.remotePatterns, adding
          // per-environment configuration for no benefit here.
          //
          // width/height are the real stored dimensions, so the browser
          // reserves the correct box before the bytes arrive and the business
          // name does not jump sideways on load.
          // eslint-disable-next-line @next/next/no-img-element -- see above
          <img
            src={logoUrl}
            alt={businessName}
            width={branding.logo.width}
            height={branding.logo.height}
            onError={() => setLogoFailed(true)}
            className="w-auto flex-none object-contain"
            style={{ maxHeight, maxWidth: maxHeight * 4 }}
          />
        )}

        {/* Always rendered, logo or not. It is the accessible label, the
            fallback when an image fails, and the only branding a project
            without a logo has. */}
        <span className="truncate text-sm font-semibold tracking-tight text-white">
          {businessName}
        </span>
      </div>

      {trailing}
    </header>
  );
}
