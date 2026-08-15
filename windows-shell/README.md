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

## Security posture (Feature 23.2)

Everything is denied unless this shell allows it. A till displays one origin and
asks the operating system for nothing.

| Control | Behaviour |
|---|---|
| **Single instance** | A second launch quits itself and focuses/un-minimises the existing window. Not tidiness: two renderers on one profile means two Supabase clients racing over the same refresh token, which is the exact race `lib/supabase/deviceClient.ts` caches its client to avoid. |
| **Navigation** | `will-navigate` **and** `will-redirect` are checked against an origin allow-list. Release allows only `https://pos-canvas.vercel.app`. Development additionally allows the resolved dev origin. Refused: other hosts, lookalikes, subdomains, cleartext, embedded credentials, `javascript:`, `data:`, `file:`, custom schemes, malformed URLs. |
| **New windows** | `setWindowOpenHandler` denies **everything**, trusted URLs included. Nothing on `/device` opens a window, and there is no `shell.openExternal` anywhere — a shell that will open an arbitrary URL is a phishing primitive. |
| **Permissions** | Both the request handler and the check handler deny unconditionally. Camera, microphone, geolocation, notifications, MIDI, clipboard-read, sensors: all refused. |
| **Downloads** | `will-download` cancels everything. Configuration download belongs to the **owner web editor**, behind owner auth, on a surface this shell never loads. |
| **DevTools** | `devTools: !isRelease`, plus F12 / Ctrl+Shift+I / Cmd+Opt+I intercepted in release. Available in development. |
| **TLS** | Untouched, deliberately. There is **no** `certificate-error` handler: Electron's default is to reject, and the only reason to add one would be to override that. |
| **webPreferences** | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`, `webSecurity` at its secure default. |

The navigation decision lives in `navigationPolicy.mjs` as pure, Electron-free
functions, so every sharp edge — lookalike hosts, userinfo prefixes, scheme
swaps — is exercised by the root test suite under plain Node.

**The main process may still load `offline.html`.** `loadURL`/`loadFile` do not
emit `will-navigate`, so blocking `file://` for the page costs the fallback
nothing and required no exception in the allow-list. Verified live.

### Renderer-visible surface

On `https://pos-canvas.vercel.app`, the page sees **nothing**:
`window.posCanvasShell`, `window.require`, `window.process`, `window.module` and
`window.ipcRenderer` are all `undefined`.

The retry bridge is exposed only when the document's own scheme is `file:` — i.e.
only on the local fallback page. Two independent barriers guard it: the preload
gate decides what the page can *see*, and the main process's sender check decides
what it will *act on*. `retry()` takes no arguments, so no destination can cross.

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

## Pairing persistence

The paired device session is **one localStorage entry** —
`pos-canvas-device-auth`, on the runtime origin, written by supabase-js with
`persistSession: true` (`lib/supabase/deviceClient.ts`). No cookie, no IndexedDB.
The pinned configuration is deliberately **never** stored; it is re-fetched on
every cold start so a revoked device stops working immediately.

So the shell's only job is to not get in the way: it uses the default persistent
session (no `fromPartition`, no ephemeral profile), clears no storage, and never
relocates or deletes the user-data directory.

### Verifying it locally

```bash
npm run start:production
```

1. Pair the shell with a code from your project's **Devices** section.
2. Confirm the POS loads with your business's menu.
3. Quit the app properly — **Cmd+Q**, or the app's Quit menu item.
4. Relaunch with the same command.
5. It should return to the paired POS **without** asking for a code, and re-fetch
   its configuration from the backend.

**Quit properly for this test.** Force-killing the process is not the same thing
— see below.

### Verified on macOS (Feature 23.2)

* Pair → **Cmd+Q** → relaunch: returns to the paired POS **without** asking for
  another code, and re-fetches its configuration. Confirmed manually.
* Graceful quit flushes localStorage to disk before exiting.

### Open question: abrupt termination

Also observed on macOS, and **not resolved**:

* Force-kill (`SIGTERM`) → relaunch: **intermittent**. The session survived in
  one trial and was **lost** in another — the shell came back as a brand-new
  anonymous user on the "Set up this till" screen, i.e. unpaired.

Leading hypothesis, **not proven**: Chromium flushes localStorage lazily and
supabase-js rotates the refresh token on each refresh. If a rotation is still
unflushed when the process dies, the stale token left on disk is rejected on the
next launch and the client falls back to a fresh anonymous sign-in.

**For a till this matters, because a power cut is a force-kill.** A device that
loses its session cannot return to its `paired_devices` row; the owner has to
revoke it and pair again.

This is a property of the storage layer, not of this shell's code — nothing on
the Electron side fixes it alone — so it does not block 23.2. It is carried
forward as a **hard validation gate for Feature 23.5**:

> **23.5 HARD VALIDATION ITEM — abrupt termination on real Windows x64**
>
> 1. Pair the installed Windows app.
> 2. Verify an operational POS (menu renders, a sale completes).
> 3. Abruptly terminate the process / simulate power loss — not a clean quit.
> 4. Restart the app.
> 5. Confirm the pairing survives and the POS is operational without a new code.
>
> **Repeat multiple times** — the macOS behaviour was intermittent, so a single
> pass proves nothing.
>
> **If pairing loss reproduces on real Windows, the public Windows release
> stops** until a mitigation is designed and validated. Shipping a till that can
> silently unpair after a power cut is not acceptable.

## Building the Windows installer (Feature 23.4)

**The authoritative build path is GitHub Actions, not your Mac.**

### Running a build

1. GitHub → **Actions** → **Windows app** → **Run workflow** → branch `main` → **Run workflow**.
2. When the run finishes, open it and download the artifact **`pos-canvas-windows-v1.0.0`**.
3. It contains two files:
   - `POS-Canvas-Windows-v1.0.0.exe`
   - `POS-Canvas-Windows-v1.0.0.exe.sha256`

### Verifying the download

```bash
shasum -a 256 -c POS-Canvas-Windows-v1.0.0.exe.sha256
```

The checksum file uses the standard two-column format, so `sha256sum -c` works on
Linux and `Get-FileHash` on Windows produces the same value.

### What gets built

| | |
|---|---|
| Target | NSIS `.exe` only — no MSI, no portable, no ARM64 |
| Architecture | **x64 only** |
| Installer | Assisted (`oneClick: false`), **per-user** (`perMachine: false`), no administrator rights |
| User data | **Never deleted on uninstall** (`deleteAppDataOnUninstall: false`) |
| Shortcuts | Start Menu + Desktop, named "POS Canvas" |
| Signing | **None** — see below |
| Icon | Electron's default — see below |

### Minimum Windows version

**Windows 10 or later, x64.** This is Electron 43.4.0's own stated support, read
from the installed package's README: *"Windows (Windows 10 and up)"*. Support for
Windows 7/8/8.1 was removed in Electron 23. The package documentation does not
narrow this to a specific Windows 10 build number, so neither does this project —
verify again if the Electron major version changes.

### Building locally on a Mac (optional)

```bash
npm run build:windows
```

electron-builder can cross-build the NSIS installer from macOS, and it currently
does. **Treat that as a convenience, never as the release gate** — it is not the
path electron-builder's maintainers test, and Authenticode signing (23.6) cannot
happen there at all. Output lands in `windows-shell/dist/`, which is gitignored.

### This build is UNSIGNED

There is no code signing in this phase: no certificate, no `.pfx`, no signing
secrets, and no configuration referencing any. Verified on the produced binary —
its PE certificate table is empty.

Consequences, stated plainly:

* Windows SmartScreen will warn on it, and under Smart App Control or enterprise
  policy it may be **blocked outright**.
* It is therefore suitable for **our own engineering and private testing only**.
* It is **not** the public customer distribution plan.

Signing is a **Feature 23.6** decision, together with publishing a GitHub Release
and switching Windows off "Coming Soon".

### Branding is not final

electron-builder reports *"default Electron icon is used"*, which is deliberate.
**Final Windows icon, installer branding, splash screen and company branding are
Feature 24 work, before any public release.** Nothing in this phase should be
treated as final artwork, and no placeholder company branding was invented.

### Still to come

* **23.5** — install and validate on real Windows x64, including the abrupt-
  termination and upgrade-persistence gates.
* **23.6** — signing, GitHub Release, release metadata, and switching Windows
  from Coming Soon to a real download.

Windows remains **Coming Soon** everywhere in the product until all of that is
done. No public download URL exists.

## Not implemented yet

| Belongs to | Status |
|---|---|
| 23.2 | **Done** — navigation lockdown, permission handler, window-open policy, download blocking, single-instance lock, production DevTools lockdown |
| 23.3 | **Done** — identity signal, `DevicePlatform` `"windows"` |
| 23.4 | **Done** — electron-builder, NSIS installer, GitHub Actions Windows build |
| 23.5 | Not started — real-Windows validation, upgrade/pairing-persistence gate |
| 23.6 | Not started — code signing, GitHub Release, switching Windows off Coming Soon |
| 24 | Not started — final icon, installer branding, splash, company branding |

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
