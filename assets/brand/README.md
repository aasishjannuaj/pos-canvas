# POS Canvas brand assets

**Source artwork lives here. Generated platform assets do not.**

This folder is the single home for the master files an owner approves once, from
which the Android and Windows assets are produced. It sits outside `public/`
deliberately: masters are build inputs, not files to serve to browsers.

## Status: empty, awaiting owner-approved artwork

**Feature 24.1 established the identity, not the artwork.** No POS Canvas logo
has been designed or approved, so nothing has been placed here, and nothing has
been generated, downloaded or improvised in its place. The apps currently ship
the toolchains' default marks:

| Surface | Today | Replaced in |
|---|---|---|
| Android launcher icon | Capacitor's default `ic_launcher` set | 24.2 |
| Android splash | Capacitor's default `splash.png` | 24.2 |
| Windows app + installer icon | Electron's default icon | 24.3 |
| Website favicon | `app/favicon.ico` — still the Next.js default | 24.2 or 24.3 |

These are placeholders by omission, not by choice, and they are the reason
24.2 and 24.3 exist.

## What the owner must supply

One master mark, from which everything else is derived. Requested as:

| # | Asset | Format | Size | Notes |
|---|---|---|---|---|
| 1 | **Master app icon** | SVG preferred, else PNG | ≥ 1024×1024, square | Opaque or transparent; the full mark |
| 2 | **Adaptive foreground** | SVG or PNG, transparent | 1024×1024 | Android crops to a circle/squircle — keep the mark inside the centre **66%** safe zone |
| 3 | **Adaptive background** | Solid colour hex, or PNG | 1024×1024 | A flat brand colour is usually enough |
| 4 | **Monochrome mark** | SVG or PNG, single colour on transparent | 1024×1024 | Android 13+ themed icons |
| 5 | **Splash / wordmark** | SVG preferred | ≥ 1024 wide | Centred on a flat background; used on both platforms |
| 6 | **Brand colours** | Hex values | — | At minimum a background colour for the splash and adaptive background |

Suggested filenames once approved:

```
assets/brand/
  icon-master.svg          (1)
  icon-adaptive-fg.svg     (2)
  icon-adaptive-bg.svg     (3)  — or a hex value recorded in lib/brand.ts
  icon-monochrome.svg      (4)
  splash-master.svg        (5)
```

## Feature 24.2 — Android (not started)

Generated from the masters into the existing tree, which already has the right
shape (`mipmap-*`, `mipmap-anydpi-v26/ic_launcher.xml`,
`drawable/ic_launcher_background.xml`, `drawable*/splash.png`):

- `mipmap-{m,h,xh,xxh,xxx}dpi/ic_launcher.png`, `ic_launcher_round.png`,
  `ic_launcher_foreground.png`
- `mipmap-anydpi-v26/ic_launcher.xml` + `ic_launcher_round.xml` (adaptive)
- `drawable/ic_launcher_background.xml` (or a colour resource)
- `drawable-{port,land}-{m,h,xh,xxh,xxx}dpi/splash.png`

`app_name` and `applicationId` are already correct and are **not** part of 24.2.

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
