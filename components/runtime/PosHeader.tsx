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
// v1.3 Lane 2 Task 1 — the logo was enlarged here, in the one shared component,
// and NOT per template. All six templates (Restaurant, Cafe, Food Truck, Retail,
// Liquor Store, Salon) and every future template mounting this header get the
// same treatment; there is deliberately no branch on templateId, layout, or
// business type anywhere in this file.
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
 * v1.3 Lane 2 Task 1 — the approved header geometry, in one table.
 *
 * WHAT CHANGED AND WHY. The logo was capped at 32px inside a fixed 64px bar
 * (24px inside ~48px for the Builder). At a register's viewing distance that
 * is a favicon, not a business's identity. These caps are ~1.75x taller at
 * md and above — roughly 3x the drawn area — which is the approved target.
 *
 * WHY THESE ARE CLASSES AND NOT AN INLINE style OBJECT. The previous
 * implementation set maxHeight/maxWidth through `style`, and an inline style
 * cannot carry a media query. The 411px Android till measured in Feature 16.2
 * cannot afford the same 224px logo box a 1280px register can — it would leave
 * the business name under ~90px — so the caps have to differ by viewport, and
 * that means utilities. Every string below is a complete literal so Tailwind's
 * scanner actually emits it; never build one by concatenation.
 *
 * WHY min-h AND NOT h. A fixed height clips anything taller than itself. With
 * a min-height an unexpectedly tall mark grows the bar instead of being cut,
 * which is what "never crop" has to mean structurally rather than by luck.
 * `flex-none` is retained so the bar can still never be squeezed.
 *
 * THE OLD INVARIANT IS DELIBERATELY RETIRED. This used to promise that "a
 * no-logo header is pixel-identical to what shipped before this feature".
 * That is no longer true and is not meant to be: a no-logo header is now the
 * same taller bar carrying a larger business name, because the name is the
 * whole of that project's branding and was being under-set for the same
 * reason the logo was.
 *
 * Vertical fit, worked rather than assumed (padding + the taller of logo and
 * name line-box):  full md+ 10+56+10 = 76 <= 80 · full below md 8+44+8 = 60
 * <= 68 · compact 8+40+8 = 56 <= 60. Every tier keeps clearance.
 */
const SIZES = {
  full: {
    header:
      "min-h-[68px] gap-3 px-4 py-2 md:min-h-20 md:gap-4 md:px-6 md:py-2.5",
    brand: "gap-3 md:gap-4",
    logo: "max-h-[44px] max-w-[132px] md:max-h-[56px] md:max-w-[224px]",
    name: "text-base md:text-xl",
  },
  compact: {
    // The Builder's frame is a ~384px mock of a ~411px till, so compact tracks
    // the below-md tier rather than inventing a third scale — otherwise the
    // preview quietly lies about what the register will look like.
    header: "min-h-[60px] gap-3 px-4 py-2",
    brand: "gap-3",
    logo: "max-h-[40px] max-w-[120px]",
    name: "text-[15px]",
  },
} as const;

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

  const sizing = SIZES[size];

  return (
    <header
      // `gap` on the header itself, not just inside the brand block: with
      // justify-between alone a truncated business name can run right up
      // against the trailing control (Back to Dashboard, or the till's
      // OperatorMenu) at narrow widths. Both trailing controls already carry
      // flex-none of their own, so this only ever costs space the name had.
      className={`flex flex-none items-center justify-between ${sizing.header}`}
      style={{ backgroundColor: branding.accentColor }}
    >
      <div className={`flex min-w-0 items-center ${sizing.brand}`}>
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
          //
          // SIZING IS MAX-ONLY, and that is load-bearing in both directions.
          // Upward: whichever cap binds first scales the other axis with it,
          // so an 8:1 banner lands at 224x28 and a 1:3 mark at ~19x56 — each
          // contained whole, never cropped. Downward: a mark smaller than the
          // caps (say 48x16) keeps its intrinsic size rather than being
          // stretched to fill them. Do not add w-full, h-full, object-cover,
          // or a fixed-aspect wrapper here; each one reintroduces exactly the
          // crop or the distortion this sizing exists to prevent. Tailwind's
          // preflight already supplies height: auto, and w-auto is kept
          // alongside it so the intrinsic ratio governs both axes.
          // eslint-disable-next-line @next/next/no-img-element -- see above
          <img
            src={logoUrl}
            alt={businessName}
            width={branding.logo.width}
            height={branding.logo.height}
            onError={() => setLogoFailed(true)}
            className={`w-auto flex-none object-contain ${sizing.logo}`}
          />
        )}

        {/* Always rendered, logo or not. It is the accessible label, the
            fallback when an image fails, and the only branding a project
            without a logo has. `truncate` keeps a long name on one line and
            stops it pushing the trailing control off-screen; min-w-0 on the
            parent is what lets it actually shrink. */}
        <span
          className={`truncate font-semibold tracking-tight text-white ${sizing.name}`}
        >
          {businessName}
        </span>
      </div>

      {trailing}
    </header>
  );
}
