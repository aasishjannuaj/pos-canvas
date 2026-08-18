#!/usr/bin/env bash
# Feature 24.3 — regenerates every Windows brand asset from the approved masters.
#
# Run from the repository root:  bash assets/brand/generate-windows-assets.sh
#
# Deterministic and idempotent, exactly like generate-android-assets.sh: it only
# ever writes the generated targets listed in assets/brand/README.md, and it
# derives all of them from the SAME approved Concept D masters the Android
# assets come from. Nothing here redraws the logo. Swapping in new approved
# artwork is a re-run, not a manual pass.
#
# Requires ImageMagick 7 (`magick`) and python3. No network access.
#
# WHERE THE OUTPUT GOES, and why it is two places:
#   windows-shell/build/    electron-builder's buildResources directory. These
#                           are BUILD INPUTS consumed by the packager and are
#                           NOT packaged into the app. Filenames are fixed by
#                           electron-builder's own convention (verified in
#                           app-builder-lib: iconConverter appends "icon.ico",
#                           NsisTarget calls getResource(..., "installerHeader
#                           .bmp"/"installerSidebar.bmp")), which is why no
#                           icon/installer paths appear in package.json at all.
#   windows-shell/          the splash artwork, which IS packaged and shipped,
#                           and therefore has to be on build.files.
set -euo pipefail
cd "$(dirname "$0")/../.."

MARK=assets/brand/icon-mark-master.png
WORD=assets/brand/wordmark-master.png
BUILD=windows-shell/build
SHELL_DIR=windows-shell
SPLASHBG="#FBFDFD"   # the board's splash panel — same ground as the Android splash

mkdir -p "$BUILD"

# ---------------------------------------------------------------------------
# icon.ico — the application, taskbar, Start Menu, shortcut and installer icon.
#
# TRANSPARENT GROUND, DELIBERATELY. The Android launcher icon sits on the cream
# board colour because Android masks every icon into a shape and fills it. A
# Windows icon is composited straight onto the taskbar, so a cream square
# becomes a visible light box on the default dark taskbar — the "cream halo"
# failure. Rendered on transparency the mark's own teal silhouette carries the
# shape on light and dark alike; this was checked at 16/24/32/48 on both.
#
# Each size is resampled from the 376px master rather than cascaded down from
# 256, so no size inherits another's resampling loss.
# ---------------------------------------------------------------------------
ICO_SIZES="16 24 32 48 64 128 256"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for N in $ICO_SIZES; do
  # 94% leaves the breathing room Windows expects without wasting pixels at 16px.
  INNER=$(python3 -c "print(round($N*0.94))")
  magick -size ${N}x${N} xc:none \
    \( "$MARK" -filter Lanczos -resize ${INNER}x${INNER} \) \
    -gravity center -compose over -composite \
    -depth 8 -strip "$TMP/icon-$N.png"
done

# -type TrueColorAlpha IS NOT COSMETIC, and it belongs on THIS command rather
# than on the frames above. Left to itself ImageMagick palettises any frame that
# fits 256 colours — at 16x16 the mark uses 209 — and an 8bpp ICO frame carries a
# 1-bit transparency mask, which turns the mark's soft anti-aliased edge into a
# hard jagged cut-out at exactly the size that can least afford it. Setting the
# type on the intermediate PNGs does NOT survive, because the PNG encoder
# re-palettises on write; setting it here, where the ICO frames are actually
# encoded, pins every frame to 32bpp BGRA. Verified by reading the ICO directory.
# shellcheck disable=SC2086 -- word splitting is the intent
magick $(for N in $ICO_SIZES; do printf '%s ' "$TMP/icon-$N.png"; done) \
  -type TrueColorAlpha -depth 8 -strip "$BUILD/icon.ico"

# ---------------------------------------------------------------------------
# NSIS wizard bitmaps.
#
# DIMENSIONS ARE NOT GUESSED. They were measured from the NSIS 3.0.4.1 toolchain
# electron-builder actually downloads and uses:
#   Contrib/Graphics/Wizard/nsis3-metro.bmp   164x314   (MUI_WELCOMEFINISHPAGE_BITMAP)
#   Contrib/Graphics/Header/nsis3-metro.bmp   150x57    (MUI_HEADERIMAGE_BITMAP)
#
# BMP3, 24-bit, alpha removed: MUI draws these as plain bitmaps and an alpha
# channel renders as garbage rather than transparency. The ground is the brand
# splash colour, which is within 4/255 of the wizard's own white chrome, so the
# panel reads as branded rather than as a pasted-on rectangle.
#
# uninstallerSidebar is deliberately NOT generated — electron-builder defaults it
# to installerSidebar, so a second identical file would be a copy to keep in sync
# for no gain.
# ---------------------------------------------------------------------------
magick -size 150x57 xc:"$SPLASHBG" \
  \( "$MARK" -filter Lanczos -resize x38 \) \
  \( "$WORD" -filter Lanczos -resize x13 \) \
  -background none -gravity center \
  \( -clone 1 -clone 2 +smush 8 \) -delete 1,2 \
  -gravity center -compose over -composite \
  -alpha remove -alpha off -type TrueColor -strip "BMP3:$BUILD/installerHeader.bmp"

magick -size 164x314 xc:"$SPLASHBG" \
  \( "$MARK" -filter Lanczos -resize 92x92 \) \
  \( "$WORD" -filter Lanczos -resize 116x \) \
  -background none -gravity center \
  \( -clone 1 -clone 2 -smush 14 \) -delete 1,2 \
  -gravity north -geometry +0+96 -compose over -composite \
  -alpha remove -alpha off -type TrueColor -strip "BMP3:$BUILD/installerSidebar.bmp"

# ---------------------------------------------------------------------------
# splash-mark.png — the artwork the local startup page shows.
#
# Generated at 2x its CSS size so it stays sharp on a high-DPI till, on
# transparency so the page supplies the ground (splash.html and this file
# therefore cannot disagree about the background colour).
# ---------------------------------------------------------------------------
magick -background none \
  \( "$MARK" -filter Lanczos -resize 256x256 \) \
  \( "$WORD" -filter Lanczos -resize 392x \) \
  -gravity center -smush 26 \
  -depth 8 -define png:compression-level=9 -strip "$SHELL_DIR/splash-mark.png"

echo "windows assets generated:"
for f in "$BUILD/icon.ico" "$BUILD/installerHeader.bmp" "$BUILD/installerSidebar.bmp" "$SHELL_DIR/splash-mark.png"; do
  printf '  %-44s %s\n' "$f" "$(magick identify -format '%wx%h %m' "$f" | head -1)"
done
