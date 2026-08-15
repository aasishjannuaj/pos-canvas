# POS Canvas — Windows shell

The universal POS Canvas application for Windows. **Feature 23.1: the shell
foundation only.** There is no installer, no packaging and no Windows release
yet — Windows is still **Coming Soon** on every customer-facing surface.

## Architecture

```
POS Canvas (Electron)
   └─ one BrowserWindow, no Node exposed to the page
        └─ https://pos-canvas.vercel.app/device
             └─ the existing DeviceApp: pair → pinned configuration → POS
```

The shell is a window. It contains **no POS logic, no menu, no prices, no
configuration, no project id and no credentials**, and it is byte-identical for
every business — exactly like the Android APK. A till becomes a specific
business's till by **pairing at runtime**, never by the binary it runs.

**There are no per-customer Windows builds.** If a change to this shell would
vary by project, business or build job, it is the wrong change.

This mirrors `android-shell/`, deliberately: same remote-load model, same pinned
production URL, same release-mode contract.

## Running it on macOS

Development uses your local Next.js server. In one terminal:

```bash
npm run dev
```

Then, from `windows-shell/`:

```bash
npm install
npm start
```

`npm start` defaults to `http://localhost:3000/device`. To point somewhere else:

```bash
POS_CANVAS_DESKTOP_SERVER_URL=http://localhost:3001/device npm start
```

To run the shell against the **real production** device runtime from your Mac:

```bash
npm run start:production
```

macOS is a first-class development target here — Electron bundles its own
Chromium, so what renders on your Mac is what renders on a Windows till. What
macOS **cannot** tell you is anything about installation, upgrade or
`%APPDATA%` persistence; that is Windows-only and is validated in 23.5.

## The production URL contract

`serverUrl.mjs` is the single source of truth, modelled on the Android shell's
proven version.

| Mode | Behaviour |
|---|---|
| `POS_CANVAS_DESKTOP_RELEASE=1` | Uses **exactly** `https://pos-canvas.vercel.app/device`. `POS_CANVAS_DESKTOP_SERVER_URL` is **not read at all**. |
| Otherwise | Uses `POS_CANVAS_DESKTOP_SERVER_URL` if set, else `http://localhost:3000/device`. |

Release mode does not merely prefer the production URL — it never consults the
environment, so no stale export, CI variable or wrapper script can redirect a
release build. A release URL must be https, must be `pos-canvas.vercel.app`, must
be under `/device` (the site root is the **owner** application and must never be
what a till loads), and must carry no embedded credentials.

Prove it locally:

```bash
POS_CANVAS_DESKTOP_RELEASE=1 POS_CANVAS_DESKTOP_SERVER_URL=http://evil.example/device npm start
```

The window still loads `https://pos-canvas.vercel.app/device`. The same contract
is asserted from the root test suite in `lib/windowsShell.guards.test.ts`, which
executes `serverUrl.mjs` directly and needs no Electron.

## A separate npm project, on purpose

`windows-shell/` has its **own** `package.json` and `package-lock.json`.
Electron must never appear in the root `package.json`: devDependencies are
installed during Vercel builds, so a root-level Electron would add hundreds of
megabytes to every web deploy and couple the web app's dependency tree to a
desktop binary it has nothing to do with. A guard asserts this in both
directions.

`windows-shell/node_modules` is gitignored (~300 MB); the lockfile is tracked.

Electron is pinned to an **exact** version — no `^`, no `~`. A range would let
the Chromium version under a payments surface change silently.

## Offline behaviour

`offline.html` is shown when the runtime URL cannot be reached. It is a message
and a Retry button — **not an offline mode**. POS Canvas requires a connection to
take payments, and the page says so. It caches no menu, no prices, no pairing
state and no credentials, and it loads nothing over the network (it is displayed
precisely when the network is not working).

Retry carries **no destination**. The page signals intent through a
zero-argument channel and the main process re-loads the URL it already resolved,
so development and release both retry the correct target with no URL injected
into the page — and no page can point the shell anywhere.

## Not implemented yet

| Belongs to | Not in this phase |
|---|---|
| 23.2 | navigation lockdown, permission handler, window-open policy, download blocking, certificate handling, single-instance lock, production DevTools lockdown |
| 23.3 | desktop identity signal, `DevicePlatform` `"windows"` |
| 23.4 | electron-builder, NSIS installer, GitHub Actions Windows build |
| 23.5 | real-Windows validation, upgrade/pairing-persistence gate |
| 23.6 | code signing, GitHub release, switching Windows off Coming Soon |

The four structural `webPreferences` (`contextIsolation`, `nodeIntegration`,
`sandbox`, `webviewTag`) are present from the first commit rather than being
retrofitted, so no interim build was ever unsafe.

`app.setName("POS Canvas")` is **permanent**. Electron derives the user-data
directory from it — `%APPDATA%\POS Canvas` on Windows — and that directory holds
the WebView's localStorage, where the paired device session lives
(`pos-canvas-device-auth`, see `lib/supabase/deviceClient.ts`). Renaming it would
silently unpair every installed till. Stability here is *necessary* for pairing
to survive a restart or an upgrade, but not *sufficient* — installer upgrade
behaviour has to preserve that directory too, which 23.5 proves on real Windows.
