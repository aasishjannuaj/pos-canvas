# POS Canvas brand assets

**Source artwork lives here. Generated platform assets do not.**

This folder is the single home for the master files an owner approves once, from
which the Android and Windows assets are produced. It sits outside `public/`
deliberately: masters are build inputs, not files to serve to browsers.

## Status: Concept D approved as TEMPORARY branding (Feature 24.2)

The owner approved the **Concept D** visual direction as the temporary
production branding. The approved board is committed here as the reference of
record:

```
concept-d-brand-board.png    the owner-approved reference (1448x1086)
```

**This is temporary-approved branding, not a final identity.** It has not been
through a professional design pass, and the mark is raster-only — there is no
vector master. Replacing it later means regenerating from a new master, which is
why every asset below is derived by a scripted, repeatable process rather than
hand-edited.

| Surface | Today | Phase |
|---|---|---|
| Android launcher + adaptive + themed icon | **Concept D mark** | 24.2 ✅ |
| Android splash | **Concept D mark + wordmark** | 24.2 ✅ |
| Website favicon | **Concept D mark** | 24.2 ✅ |
| Windows app + installer icon | Electron's default | 24.3 |
| Windows splash | none | 24.3 |

### Palette (from the approved board)

| Role | Hex |
|---|---|
| Primary — Vibrant Teal | `#0FA7A6` |
| Teal 80% | `#2BCBC4` |
| Mint 60% | `#7FE6DB` |
| Peach 40% | `#FFC7A3` |
| Coral 20% | `#FF7F68` |
| Blush 10% | `#FFE9DE` |
| Board page / icon ground | `#FBF8F3` |
| Splash ground | `#FBFDFD` |
| Wordmark ink | `#000119` |

### Derived masters

Extracted from the approved board, not redrawn — redrawing would have meant
inventing a logo rather than using the approved one.

```
icon-mark-master.png         376x372  the blob mark, alpha, decorative dots removed
icon-monochrome-master.png   376x372  single-colour silhouette, POS + smile knocked out
wordmark-master.png          424x63   "POS Canvas" wordmark, ink only
```

**Why the decorative dots were dropped:** the four accent dots sit at the
extremes of the mark and would fall outside the adaptive icon's 66dp safe zone,
where circular and squircle masks clip them. The splash uses the same dot-free
master so every surface shows one consistent mark.

**Why the ground is `#FBF8F3` rather than white:** the artwork's edges were
anti-aliased against that exact page colour. Compositing onto it reproduces the
original edge with zero halo; compositing onto white leaves a faint cream fringe.

### Generated Android targets (24.2)

| Target | Sizes |
|---|---|
| `mipmap-*/ic_launcher.png` | 48, 72, 96, 144, 192 — mark at 82% on the cream ground |
| `mipmap-*/ic_launcher_round.png` | same, circular |
| `mipmap-*/ic_launcher_foreground.png` | 108, 162, 216, 324, 432 — mark fitted to the 66/108dp safe zone, transparent |
| `mipmap-*/ic_launcher_monochrome.png` | same geometry, single colour (Android 13+ themed icons) |
| `values/ic_launcher_background.xml` | `#FBF8F3` |
| `drawable-port-*/splash.png` | 320x480 … 1280x1920 |
| `drawable-land-*/splash.png` | 480x320 … 1920x1280 |
| `drawable/splash.png` | 480x320 |
| `app/favicon.ico` | 16, 32, 48 |

**Known limit:** at 16px the mark cannot render "POS" legibly — the shape and
coral accent read, the letters do not. The approved board's own 16x16 preview
shows the same. A simplified small-size variant would be a design decision for
the owner, not something to improvise.

## Still needed from the owner

Concept D is approved as **temporary** branding. Outstanding:

| # | Item | Why |
|---|---|---|
| 1 | **Vector master** of the mark (SVG/AI) | Everything today is derived from a 1448x1086 raster board. A vector master would sharpen every size and is required for a clean high-DPI Windows icon. |
| 2 | **Decision on a simplified 16px variant** | The full mark cannot render "POS" at 16px. A reduced form is a design choice, not something to improvise. |
| 3 | **Confirmation of the icon ground** | `#FBF8F3` was chosen because it is the colour the artwork was anti-aliased against. A different ground needs a re-render, not a recolour. |
| 4 | **Final identity sign-off** | Before public launch, if Concept D is not the permanent mark. |

## Feature 24.2 — Android (complete)

```bash
bash assets/brand/generate-android-assets.sh
```

Regenerates every target from the masters. The build is scripted end to end, so
swapping in new approved artwork is a re-run rather than a manual pass.

`app_name` and `applicationId` were already correct and were **not** touched.

## Feature 24.3 — Windows (not started)

- `windows-shell/build/icon.ico` — multi-resolution (16, 24, 32, 48, 64, 128,
  256). electron-builder picks this up by convention from `build/`; 256×256 is
  required.
- Splash artwork, if a splash is added to the shell.
- Installer branding (electron-builder NSIS supports a sidebar/header bitmap),
  only if it looks deliberate rather than decorated.

`productName`, `appId` and `shortcutName` are already correct and are **not**
part of 24.3.

## Rules

1. **No improvised artwork.** No AI-generated marks, no stock icons, no icon
   packs. The mark is an identity decision the owner makes.
2. **Masters here, generated assets in the platform trees.** Do not commit a
   second copy of a generated icon into this folder.
3. **Platform branding is not customer branding.** The marks here identify POS
   Canvas. A customer's own logo lives in their project configuration
   (`ProjectConfig.branding.logo`, the `project-logos` bucket) and appears
   inside their till — the two must never be mixed. Guards in
   `lib/brand.guards.test.ts` assert the separation.
