import Image from "next/image";
import markMaster from "@/assets/brand/icon-mark-master.png";
import wordmarkMaster from "@/assets/brand/wordmark-master.png";
import { BRAND } from "@/lib/brand";

// The POS Canvas PLATFORM lockup — the mark, the wordmark, or both.
//
// WHY THIS EXISTS. Until now the website's identity was the string "POS Canvas"
// typed into a <Link> in Navbar.tsx and again into Footer.tsx, styled by hand
// each time. The product has had approved artwork since Feature 24.2; the
// Android launcher, the Android splash, the Windows icon, the Windows installer
// and the favicon all render it, and the website was the one surface still
// spelling the name out in whatever font the page happened to be using.
//
// WHAT IT DRAWS, AND WHAT IT DOES NOT. Both images are the EXISTING approved
// masters in assets/brand/, imported unmodified. Nothing here redraws,
// recolours, re-crops or regenerates the mark: assets/brand/README.md records
// that Concept D is TEMPORARY approved branding and that replacing it is an
// owner decision made by swapping the masters, after which every surface —
// including this one — follows automatically.
//
// WHY THE MASTERS AND NOT public/. assets/brand/ is deliberately outside
// public/ (see its README), and lib/brand.guards.test.ts asserts that no
// public/brand tree exists. A static import keeps that intact: the file stays
// a build input, and Next emits an optimised, content-hashed copy at build
// time rather than a second checked-in copy of the artwork. There is still no
// vector master — the README lists one as outstanding from the owner — so the
// mark is raster here as it is everywhere else, rendered well below its
// intrinsic 376px so the raster origin is not visible.
//
// PLATFORM, NOT CUSTOMER. This is POS Canvas identifying itself. A merchant's
// own logo lives in ProjectConfig.branding and is rendered by
// components/editor/BrandingLogoField.tsx and the till header — never by this
// component, and never from these files.

export type PosCanvasLockupSize = "sm" | "md" | "lg";

/** Heights only; widths stay `auto` so the artwork keeps its exact aspect.
    `md` and `lg` step down below the `sm` breakpoint: at 390px the full-size
    lockup and the header's two actions end up about eight pixels apart, which
    reads as a collision rather than a layout. */
const MARK_CLASS: Record<PosCanvasLockupSize, string> = {
  sm: "h-7 w-auto",
  md: "h-8 w-auto sm:h-9",
  lg: "h-10 w-auto sm:h-12",
};

/** Sized to sit optically on the mark's x-height rather than match its box. */
const WORDMARK_CLASS: Record<PosCanvasLockupSize, string> = {
  sm: "h-[0.875rem] w-auto",
  md: "h-[0.9375rem] w-auto sm:h-[1.0625rem]",
  lg: "h-[1.25rem] w-auto sm:h-[1.5rem]",
};

/**
 * Lane 3 Task 3 — `sizes` on the MARK ONLY, and the asymmetry is the finding.
 *
 * MEASURED, NOT ASSUMED, AND THE OBVIOUS VERSION OF THIS WAS WRONG. Without
 * `sizes`, next/image builds its candidate list from the INTRINSIC width, so a
 * browser at 2x DPR fetched the 376px mark into a 36px slot: 7,580 bytes of
 * image for something drawn at 36 CSS px. Declaring the real slot width lets it
 * pick the 96w candidate instead — 3,118 bytes, a 59% saving on every page
 * view.
 *
 * The same change applied to the WORDMARK made things WORSE, which is only
 * visible if you measure both. That master is 424x63; with no `sizes` the
 * browser asks for a width Next cannot upscale to and gets the original back at
 * 4,200 bytes. With `sizes`, it picks the 256w candidate, and downscaling fine
 * letterforms produces high-frequency detail that re-encodes to 6,906 bytes —
 * 64% BIGGER for a smaller image. So the wordmark deliberately has no `sizes`:
 * the default behaviour is already the best available candidate for artwork
 * this small.
 *
 * Together: 11,780 -> 7,318 bytes, with no regression on either image.
 */
const MARK_SIZES: Record<PosCanvasLockupSize, string> = {
  sm: "28px",
  md: "36px",
  lg: "48px",
};

const GAP_CLASS: Record<PosCanvasLockupSize, string> = {
  sm: "gap-2",
  md: "gap-2.5",
  lg: "gap-3",
};

type PosCanvasLockupProps = {
  size?: PosCanvasLockupSize;
  /** Mark alone when false — for tight rails and square slots. */
  showWordmark?: boolean;
  /** Set on an above-the-fold lockup so the header does not pop in. */
  priority?: boolean;
  className?: string;
};

export default function PosCanvasLockup({
  size = "md",
  showWordmark = true,
  priority = false,
  className = "",
}: PosCanvasLockupProps) {
  return (
    <span className={`inline-flex items-center ${GAP_CLASS[size]} ${className}`}>
      {/* Exactly ONE accessible name for the lockup. When the wordmark is
          rendered it carries the name and the mark is decorative; when it is
          not, the mark carries it. Two named images would make a screen reader
          announce the product twice. */}
      <Image
        src={markMaster}
        alt={showWordmark ? "" : BRAND.productName}
        sizes={MARK_SIZES[size]}
        className={MARK_CLASS[size]}
        priority={priority}
      />

      {showWordmark && (
        <Image
          src={wordmarkMaster}
          alt={BRAND.productName}
          className={WORDMARK_CLASS[size]}
          priority={priority}
        />
      )}
    </span>
  );
}
