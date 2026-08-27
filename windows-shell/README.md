# POS Canvas — Windows shell

The universal POS Canvas application for Windows.

**Feature 23 is COMPLETE.** The shell is built, hardened, packaged as an NSIS
installer by CI, validated on real Windows x64, published as
[`windows-v1.0.0`](https://github.com/aasishjannuaj/pos-canvas/releases/tag/windows-v1.0.0),
and offered as a download on the landing page, the dashboard and the editor's
Devices panel.

> **Windows distribution is currently an UNSIGNED PRE-RELEASE / DEVELOPMENT
> DISTRIBUTION.** POS Canvas is not publicly launched. **Windows code signing is
> mandatory before public launch** — deferred by owner decision, not cancelled.
> Feature 24 also remains before the final MVP/public release.

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

The retry bridge is exposed only on the local fallback page, and since Feature
24.3 that is checked **by name** (`pathname` ends with `/offline.html`) rather
than by scheme. There are now two local documents — `splash.html` is the other —
and the splash gets **neither** bridge: it is not the hosted page, so the identity
fact is not its to claim, and it has no Retry button, so the capability would be
handed to a document with no use for it.

Two independent barriers still guard retry: the preload gate decides what the
page can *see*, and the main process's sender check decides what it will *act
on*. `retry()` takes no arguments, so no destination can cross.

## Startup splash (Feature 24.3)

`splash.html` is a local, branded startup screen shown from disk the instant the
window appears, and replaced the moment the hosted `/device` runtime paints.

Before it, the window was created with `show: false` and stayed invisible until
the remote page was ready — so on a slow connection, launching POS Canvas looked
like launching nothing at all.

**It is one BrowserWindow, not two.** The usual Electron splash recipe adds a
second window; that would be a second surface to secure and a second thing to
create, track, focus and destroy correctly on every path — including
second-instance activation, where a stale splash would be an orphan window the
operator cannot close. Reusing the existing window means the splash inherits
every Feature 23 `webPreference` and every deny-by-default handler already
applied, with no second copy that can drift. Chromium keeps showing the current
document until the next one has something to paint, so the brand screen stays up
for the whole remote load.

| Path | Behaviour |
|---|---|
| Normal launch | splash → `/device` → pairing screen or paired POS |
| Slow connection | splash stays, with an indeterminate bar; no white gap |
| Load failure | `did-fail-load` → `offline.html`; the splash never hangs forever |
| Second instance | second process quits and focuses the first window; there is no splash window to orphan |
| Quit / relaunch | unchanged — the splash stores nothing |
| Revoked device | unchanged — the splash carries no session or configuration |

It runs **no script**, reaches **no network**, and carries **no customer, project
or business identity** — it is byte-identical on every till. The load is wired
with `.finally`, not `.then`: if the local splash somehow fails, the till still
goes to the runtime. A branded screen is never allowed to become the reason a
till does not start.

**The splash is not offline capability.** It caches nothing and knows nothing;
offline work is 24.4+.

## Offline behaviour

`offline.html` is shown when the runtime URL cannot be reached. It is a
**different page from `splash.html`, deliberately**: the splash says the app is
starting, this says it failed. Collapsing them would either accuse the network
before anything went wrong, or make a failure look like normal loading. It is a message
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

### What the workflow does, in order

The job builds **two things, in this order**, and the order is the whole point.

1. **The device runtime, from the repository root.** `npm ci` at the root, then
   `npm run windows:runtime`, which runs the `native-device` vite build and emits
   the POS into `windows-shell/runtime/`.
2. **A hard assertion that the runtime exists** and targets the configured
   Supabase URL, and that no server credential reached the bundle. The job stops
   here if anything is wrong.
3. **The installer, from `windows-shell`.** `npm ci` there for Electron and
   electron-builder, then `npm run build:windows`.

`windows-shell/runtime/` is gitignored build output, so a fresh checkout does not
contain it. Until Feature 25.6 this workflow skipped step 1 entirely:
electron-builder's `runtime/**/*` glob matched nothing and the job produced an
installer with **no POS inside it**. It installed, launched, failed to fetch
`app://poscanvas/index.html` and sat on the offline page forever. The
installer-size check could not catch it — Electron alone is ~95 MB, far above the
40 MB floor — which is why step 2 exists and fails closed.

### Required repository configuration

The runtime build needs the same two **public** values Next.js already inlines
into every browser bundle it serves:

| Name | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | The project URL, e.g. `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The public anon key |

Set them as **repository variables** (Settings → Secrets and variables → Actions
→ Variables). The workflow falls back to secrets of the same names, so either
works. Neither is a credential: both ship inside every APK and EXE by design.

**A service-role key is never available to this job**, and a guard fails the
build if one is ever wired in. That is a server credential and would be
catastrophic inside a customer-installable artifact.

### Running a build

1. GitHub → **Actions** → **Windows app** → **Run workflow** → branch `main` → **Run workflow**.
2. When the run finishes, open it and download the artifact **`pos-canvas-windows-v1.0.0`**.
3. It contains two files:
   - `POS-Canvas-Windows-v1.0.0.exe`
   - `POS-Canvas-Windows-v1.0.0.exe.sha256`

Check the log for `runtime ok:` before trusting the artifact.

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
| Icon | **POS Canvas mark** (Feature 24.3) — `build/icon.ico`, 7 sizes |
| Installer artwork | **POS Canvas** header + wizard sidebar (Feature 24.3) |

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

### Branding (Feature 24.3 — complete)

electron-builder no longer reports *"default Electron icon is used"*. One file,
`build/icon.ico`, becomes every Windows surface:

| Surface | Source |
|---|---|
| `POS Canvas.exe` (executable, taskbar, alt-tab) | `build/icon.ico`, embedded as `RT_ICON` + `RT_GROUP_ICON` |
| Start Menu + Desktop shortcut | the executable's icon |
| Apps & Features entry | the executable's icon |
| Installer `.exe` | `MUI_ICON` — defaults to the application icon |
| Uninstaller | `MUI_UNICON` — same |
| Wizard header | `build/installerHeader.bmp` (150x57) |
| Wizard welcome/finish panel | `build/installerSidebar.bmp` (164x314), reused for the uninstaller |

Verified on the produced binaries by reading their PE resource directories: both
`POS Canvas.exe` and the installer carry all seven sizes (16/24/32/48/64/128/256),
every one 32bpp, 256 PNG-compressed.

**No icon or installer paths appear in `package.json`.** electron-builder resolves
all of them from `build/` by convention. Regenerate with:

```bash
bash assets/brand/generate-windows-assets.sh
```

Artwork is **temporary-approved Concept D**, the same masters as Android. See
`assets/brand/README.md`.

### The published v1.0.0 installer does NOT have this branding

> **`windows-v1.0.0` on GitHub is the older, pre-branding binary. Do not
> overwrite it.**

`CURRENT_WINDOWS_RELEASE` still describes those published bytes
(`03b88e35…`, 99,637,338 bytes) and is **correct as it stands** — the release
metadata must keep describing what is actually downloadable, not what is in the
working tree. Feature 24.3 deliberately did not touch it.

Replacing a published asset in place would invalidate the checksum every existing
surface shows, and would silently change what an already-published URL serves.
Branding therefore ships in a **new version**, not by mutating history:

1. Choose the next version (`1.0.1` for a branding-only change).
2. Bump `version` in `windows-shell/package.json` — the artifact name follows it.
3. Build via **GitHub Actions**, never a macOS cross-build.
4. Publish a **new** release under `windows-v1.0.1`, still pre-release, still
   labelled unsigned.
5. Verify the published bytes, then update `CURRENT_WINDOWS_RELEASE`.

None of that is Feature 24.3, which prepares the branded installer without
releasing it.

## Real Windows validation (Feature 23.5)

Performed by the owner on real Windows x64 hardware. **Owner-reported results**
— recorded here because they gate the release, not because this repository
observed them:

| Check | Result |
|---|---|
| Installation | passed |
| Launch | passed |
| Pairing | passed |
| Owner Devices UI shows **Windows** | passed |
| Correct configuration loaded | passed |
| Logo / menu / modifiers | passed |
| Sale | passed |
| Receipt and print behaviour | passed |
| Normal restart preserves pairing | passed |
| **Windows reboot** preserves pairing | passed |
| Network loss and recovery | passed |
| Revocation | passed |
| **Repeated abrupt Task Manager termination preserves pairing** | passed |

That last row closes the hard gate carried since Feature 23.2, where macOS showed
intermittent session loss on `SIGTERM`. It did **not** reproduce on real Windows
across repeated abrupt terminations, so the stop-ship condition is cleared.

## Publishing a Windows release (Feature 23.6)

### Owner-approved pre-release policy

POS Canvas is **not publicly launched**. For the current development stage the
owner has approved distributing the **unsigned** Windows installer, on these
terms:

* the installer is published as a **PRE-RELEASE / DEVELOPMENT BUILD**
* it is labelled **unsigned** wherever it is offered
* nothing claims it is signed, verified, or trusted
* **code signing remains REQUIRED before the true public launch** — it is
  deferred, *not* cancelled

Before public launch: complete signing, replace the unsigned artifact and its
checksum with the signed ones, update the release wording, and configure Azure
Artifact Signing (or another approved provider). Signing is **not optional** for
public launch.

### What Windows users will see

Windows will show a **SmartScreen / "Unknown publisher"** warning on an unsigned
installer, and enterprise policy or Smart App Control may block it. That is
expected for a pre-release build and is what signing later fixes.

**Do not advise anyone to disable Windows Security**, and do not do so yourself.
The correct route on a machine you control is *More info → Run anyway*.

### Release naming

| | |
|---|---|
| Tag | `windows-v1.0.0` — **never** Android's `v1.0.0`; the two have independent cadence |
| Title | POS Canvas Windows v1.0.0 |
| State | **Pre-release** |
| Installer asset | `POS-Canvas-Windows-v1.0.0.exe` |
| Checksum asset | `POS-Canvas-Windows-v1.0.0.exe.sha256` |

`isWindowsRelease()` enforces the tag and filename: a release object missing the
`windows-v` tag, or whose filename version disagrees with `versionName`, is
rejected rather than rendered.

### The verified artifact

Only the **CI-produced** installer may be published — never a local macOS
cross-build. Verified from the downloaded GitHub Actions artifact:

```
sha-256   03b88e35d12b01ffbf62116519817c554b18f8a8e51c21064b9f6e82a748855d
bytes     99637338
signature none (PE certificate table empty)
```

The macOS cross-build is a different 99,637,032-byte file. The sizes differing is
how "did this come from CI?" stays checkable.

### The published release — verified 2026-08-16

```
tag          windows-v1.0.0        (GitHub pre-release, draft=false)
title        POS Canvas Windows v1.0.0
published_at 2026-08-16T15:24:22Z
installer    POS-Canvas-Windows-v1.0.0.exe
sha-256      03b88e35d12b01ffbf62116519817c554b18f8a8e51c21064b9f6e82a748855d
bytes        99637338
signature    none — PE certificate table empty
```

Verified against the **published** bytes, not the build log: the API's reported
size matched, the downloaded installer verified against its own published
`.sha256` (`shasum -c` → OK), an independent hash matched, and the bytes are
identical to the CI artifact and different from the macOS cross-build.

### Publishing a future release

1. Run the **Windows app** workflow; download the artifact.
2. Sign the installer (once signing exists), then hash the **signed** bytes.
3. Create the GitHub Release under `windows-v<version>` and upload both assets.
4. Read the real `browser_download_url` and `published_at` from the Releases API
   — **do not assume the URL.** Android's first release was tagged `v.1.0.0` with
   a stray dot and the conventional URL 404'd until it was re-tagged.
5. Download the published asset and verify its sha-256 locally.
6. Update `CURRENT_WINDOWS_RELEASE` with those verified values.
7. Deploy. All three surfaces change together, because they read one model.

### Release naming, once unblocked

| | |
|---|---|
| Tag | `windows-v1.0.0` — **never** Android's `v1.0.0`; the two have independent cadence |
| Installer asset | `POS-Canvas-Windows-v1.0.0.exe` |
| Checksum asset | `POS-Canvas-Windows-v1.0.0.exe.sha256` |

`isWindowsRelease()` enforces both: a release object whose URL is missing the
`windows-v` tag, or whose filename version disagrees with `versionName`, is
rejected rather than rendered.

### The procedure, when signing is available

1. Run the **Windows app** workflow; it builds the installer.
2. Sign the installer, then compute the SHA-256 **of the signed bytes** — signing
   changes the file, so a checksum taken before it is worthless.
3. Verify the Authenticode signature and the publisher identity.
4. Create the GitHub Release under `windows-v<version>` and upload both assets.
5. **Download the published asset** and verify its checksum locally. Do not
   transcribe values from a build log — this is how the Android release was
   verified in Feature 21.
6. Populate `CURRENT_WINDOWS_RELEASE` with those verified values.
7. Deploy the web app. Windows becomes downloadable on the landing page, the
   dashboard and the editor's Devices panel simultaneously, because all three
   read the same shared model.

### Updates

Manual, exactly like Android: owners download the new installer and run it over
the existing one. There is no auto-updater. NSIS is configured with
`deleteAppDataOnUninstall: false` so the paired session in `%APPDATA%\POS Canvas`
survives an upgrade — validated on real Windows in Feature 23.5.

### The binary stays universal

One installer for every customer. No project id, no build id, no business
identity and no configuration enters it — verified in Feature 23.4 against the
packaged `app.asar`, and asserted again by the release guards. A till becomes a
specific business's till through pairing at runtime.

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
| 23.5 | **Done** — real-Windows validation, upgrade/pairing-persistence gate |
| 23.6 | **COMPLETE** — release metadata, shared platform model, pre-release UX, published `windows-v1.0.0`, Windows download live. Signing deferred to public launch by owner decision. |
| 24.1 | **Done** — shared brand identity module |
| 24.2 | **Done** — Android launcher, adaptive, themed icon and branded cold-start splash |
| 24.3 | **Done** — Windows icon, installer wizard artwork, branded startup splash |
| 24.4+ | Not started — company information screen, offline capability, cached startup, offline sales/sync, publish progress |

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
