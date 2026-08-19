#!/usr/bin/env bash
# Feature 24.2 — regenerates every Android brand asset from the approved masters.
#
# Run from the repository root:   bash assets/brand/generate-android-assets.sh
#
# Deterministic and idempotent: it only ever writes the generated targets listed
# in assets/brand/README.md, at the exact dimensions Capacitor already uses.
# Swapping in new approved artwork is a re-run, not a manual pass.
#
# Requires ImageMagick 7 (`magick`) and python3.
#
# PNG output is deliberately tuned: icons stay 8-bit truecolour+alpha to keep the
# mark's gradients and soft edges exact, while splashes — which are one flat
# colour behind a small logo — are palettised. ImageMagick defaults to 16-bit
# here, which made the splash set 2.7 MB; this brings it to roughly a tenth of
# that for an RMSE of 0.0025.
set -euo pipefail
cd "$(dirname "$0")/../.."
RES=android/app/src/main/res
MARK=assets/brand/icon-mark-master.png
MONO=assets/brand/icon-monochrome-master.png
WORD=assets/brand/wordmark-master.png
CREAM="#FBF8F3"      # the page colour the approved art was rendered against
SPLASHBG="#FBFDFD"   # the board's splash panel

# --- adaptive foreground + monochrome: blob occupies the 66dp safe zone of 108dp
for d in "mdpi 108" "hdpi 162" "xhdpi 216" "xxhdpi 324" "xxxhdpi 432"; do
  set -- $d; DPI=$1; C=$2
  SAFE=$(python3 -c "print(round($C*66/108))")
  magick -size ${C}x${C} xc:none \
    \( "$MARK" -resize ${SAFE}x${SAFE} \) -gravity center -compose over -composite \
    -depth 8 -define png:compression-level=9 -strip "$RES/mipmap-$DPI/ic_launcher_foreground.png"
  magick -size ${C}x${C} xc:none \
    \( "$MONO" -resize ${SAFE}x${SAFE} \) -gravity center -compose over -composite \
    -depth 8 -define png:compression-level=9 -strip "$RES/mipmap-$DPI/ic_launcher_monochrome.png"
done

# --- legacy square + round launcher icons on the cream ground
for d in "mdpi 48" "hdpi 72" "xhdpi 96" "xxhdpi 144" "xxxhdpi 192"; do
  set -- $d; DPI=$1; N=$2
  INNER=$(python3 -c "print(round($N*0.82))")
  magick -size ${N}x${N} xc:"$CREAM" \
    \( "$MARK" -resize ${INNER}x${INNER} \) -gravity center -compose over -composite \
    -depth 8 -define png:compression-level=9 -strip "$RES/mipmap-$DPI/ic_launcher.png"
  magick -size ${N}x${N} xc:none \
    \( -size ${N}x${N} xc:"$CREAM" \
       \( "$MARK" -resize ${INNER}x${INNER} \) -gravity center -compose over -composite \) \
    -compose over -composite \
    \( -size ${N}x${N} xc:black -fill white -draw "circle $((N/2)),$((N/2)) $((N/2)),0" -alpha off \) \
    -compose CopyOpacity -composite -depth 8 -define png:compression-level=9 -strip "$RES/mipmap-$DPI/ic_launcher_round.png"
done

# --- Android 12+ system splash icon (24.2 polish pass)
#
# WHY A DEDICATED ASSET RATHER THAN @mipmap/ic_launcher, which is what the launch
# theme pointed at until now: the launcher icon's adaptive foreground is produced
# by DOWNSCALING the 376px master into a 66dp safe zone — 198px at xxhdpi — and
# the platform then scales that up to the splash icon size. On this 420dpi
# emulator the mark is drawn at 504px, so it was a 2.5x upscale of an image that
# had already thrown most of its detail away. That double resampling is the blur
# the owner reported.
#
# WHY IT IS STILL AN ADAPTIVE ICON. Verified on a real API 36 device, not
# assumed: a plain PNG in windowSplashScreenAnimatedIcon renders as NOTHING —
# the cream background appears and the mark never does, with no error in logcat.
# Bisecting against @mipmap/ic_launcher showed the adaptive-icon path is what
# the platform actually draws. So the fix keeps that path and changes only what
# feeds it: the same approved master, resampled ONCE, at a resolution high
# enough that the platform DOWNSCALES to reach the screen instead of upscaling.
#
# GEOMETRY is the adaptive contract: a 108dp canvas whose visible content sits
# in the centred 66dp safe zone. 972 = 9x108, so the mark lands on 594px, which
# is comfortably above the ~504px the platform asks for at 420dpi and above the
# 576px a 3x device asks for. nodpi because an adaptive icon scales its layers
# to its own bounds; a density ladder would add four more files that the
# platform resamples anyway.
mkdir -p "$RES/drawable-nodpi" "$RES/drawable-anydpi-v26"
magick -size 972x972 xc:none \
  \( "$MARK" -filter Lanczos -resize 594x594 \) \
  -gravity center -compose over -composite \
  -depth 8 -define png:compression-level=9 -strip "$RES/drawable-nodpi/pos_canvas_splash_foreground.png"

# The API 24-25 fallback: the same mark already composited on the brand ground,
# because those releases have no adaptive-icon support and androidx's compat
# splash draws whatever it is given.
magick -size 972x972 xc:"$CREAM" \
  \( "$MARK" -filter Lanczos -resize 594x594 \) \
  -gravity center -compose over -composite \
  -depth 8 -define png:compression-level=9 -strip "$RES/drawable-nodpi/pos_canvas_splash_icon.png"

# --- splash: light ground, centred mark above the wordmark, never stretched
splash() {
  OUT="$1"; W="$2"; H="$3"
  S=$(python3 -c "print(min($W,$H))")
  MW=$(python3 -c "print(round($S*0.30))")
  WW=$(python3 -c "print(round($S*0.46))")
  GAP=$(python3 -c "print(round($S*0.045))")
  magick -size ${W}x${H} xc:"$SPLASHBG" \
    \( "$MARK" -resize ${MW}x${MW} \) \
    \( "$WORD" -resize ${WW}x \) \
    -background none -gravity center \
    \( -clone 1 -clone 2 -smush $GAP \) -delete 1,2 \
    -gravity center -compose over -composite \
    -depth 8 -colors 255 -define png:compression-level=9 -strip "$OUT"
}
for d in "mdpi 320 480" "hdpi 480 800" "xhdpi 720 1280" "xxhdpi 960 1600" "xxxhdpi 1280 1920"; do
  set -- $d; splash "$RES/drawable-port-$1/splash.png" "$2" "$3"
done
for d in "mdpi 480 320" "hdpi 800 480" "xhdpi 1280 720" "xxhdpi 1600 960" "xxxhdpi 1920 1280"; do
  set -- $d; splash "$RES/drawable-land-$1/splash.png" "$2" "$3"
done
splash "$RES/drawable/splash.png" 480 320
echo "android assets generated"
