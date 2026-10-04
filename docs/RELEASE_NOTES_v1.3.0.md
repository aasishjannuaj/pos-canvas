# POS Canvas v1.3.0 — release candidate notes

> ## v1.3.0 is a RELEASE CANDIDATE. It is NOT RELEASED.
>
> | | |
> |---|---|
> | **Released product today** | **v1.2.0** — web, Android, Windows |
> | **v1.3.0 status** | **Release candidate — not published, not downloadable** |
> | Accepted v1.3 product base | `018a76f05849599a9e5755a77daada4e64f0cf50` |
> | Test-harness hardening | `44ddf224fcc5db0e31d16b27a21e0c59abe33464` |
> | v1.3.0 artifacts | **none built, none published** |
> | Production migrations applied | **none** — see `PRODUCTION_MIGRATION_RUNBOOK_v1.3.0.md` |
> | v1.3 feature scope | **FROZEN** |
>
> The download page, `lib/androidRelease.ts` and `lib/windowsRelease.ts` all
> still describe **1.2.0**, and that is correct: they describe bytes that
> actually exist at a URL. Nothing advertises 1.3.0.

The version in the tree (`versionName 1.3.0`, `versionCode 4`,
`windows-shell/package.json 1.3.0`) is **the version being cut**, not a version
that shipped. The release pointers deliberately lag until artifacts are built,
published and checksum-verified — see §0 and §10 step 8 of
`RELEASE_CHECKLIST.md`.

---

## What v1.3.0 adds

### Core

| Capability | What it is |
|---|---|
| **Employee identity** | Employees belong to a project, with their own records |
| **Employee ID** | A short per-project code an employee is known by |
| **4-digit PIN** | Employee sign-in credential, bcrypt-hashed in the database via `pgcrypto`; never stored or compared in the browser |
| **Roles** | Employee role model distinguishing what a cashier and a manager may do |
| **POS employee sessions** | A till knows which employee is signed in, server-side |
| **Ring Out** | An employee ends their own POS session and hands the till over |
| **10-minute Auto-Lock** | An idle till locks itself and requires a PIN to resume |
| **Employee / device / register attribution** | Each sale records the employee, the paired device and the register session that produced it |
| **DAILY register / business-date** | A register session carries an explicit business date, resolved against the project's business timezone rather than the server's |
| **Time Clock** | Employees clock in and out; the owner can read the resulting time |
| **Cash Movements** | Cash Drop, Paid In and Paid Out, recorded against the register session |
| **Barcode foundation** | The shared barcode value contract, catalogue index and item-activation decision |

### Templates

| Capability | What it is |
|---|---|
| **Liquor Store** | Liquor-store till template |
| **Liquor Search / Scan** | The Liquor template's search field, which also accepts a scanned barcode |
| **Retail Store** | Retail-store till template |

### Owner / Admin

| Capability | What it is |
|---|---|
| **Business Timezone** | The project's business timezone, which the business date is resolved against |
| **Employee Management** | Create employees, set Employee ID, PIN, role and active state |
| **Sales Reporting** | Owner sales reporting |
| **Sales by Employee** | Sales attributed per employee |
| **Employee Time** | Time Clock reporting |
| **Cash Activity** | Cash Movement reporting |
| **Devices** | Paired-device administration, including per-register drawer configuration |

### Cash Drawer software

Checkpoints **1A**, **1B**, **1C** and **1D** are included as software.

> ### Cash Drawer physical end-to-end validation: NOT YET COMPLETED
>
> Checkpoint **1E** has **not** been performed and **1E-PREP is paused**. No
> physical drawer has been opened by this release under validation conditions.
>
> `cash_drawer_enabled` is **`false`** for every device, is written only by an
> explicit owner action, and no production device gains drawer capability from
> this release.
>
> v1.3 must **not** be described as:
> - production-proven
> - physically validated
> - release-proven hardware support
>
> Windows *packaging* of the 1C hardware bridge is validated. That is packaging,
> not drawer hardware validation, and the two must not be conflated.

---

## Deferred scope — not in v1.3.0

Do not read any of the following as present in v1.3.

| Item | Status |
|---|---|
| **Financial Close / Register Reconciliation** | **DEFERRED TO v1.4** |
| **Refund / Void / Post-Sale Correction** | **DEFERRED TO v1.4** |
| Extended discounts | Deferred to v1.4 |
| Time Clock auditable correction | Deferred to v1.4 |
| Cash Drop threshold | Deferred to v1.4 |
| Android native receipt printing | Deferred to v1.4 or later |
| Centralized entitlement expansion | Deferred to v1.4 |
| Vendor / PO / advanced purchasing | **Not currently scheduled** |

v1.3 records cash movements; it does **not** reconcile a drawer or close a
register. There is no way to refund, void or correct a completed sale in v1.3 —
that is v1.4 work, and no part of it is present.

---

## Receipt and payment truth

These are the product's actual limits, stated plainly so no release note implies
otherwise:

- **Android native receipt printing is not in v1.3.** The Android app has no
  receipt printing. Printing goes through the browser print path.
- **There is no general printer-hardware integration.** Cash Drawer software
  support is **not** automatic receipt-printer support. A cash drawer and a
  receipt printer are different devices, and shipping drawer software says
  nothing about printers.
- **No payment processing exists.** Cash and card are **recorded as the tender**
  on a sale. There is no payment gateway, no card processing, no settlement and
  no integration with any payment provider. The POS records how the customer
  said they paid; it does not take the money.

---

## Known limitations carried into v1.3.0

- Cash Drawer physical validation not performed (above).
- Sales recorded before v1.3 are **not** backfilled with employee, device or
  register attribution. Reports covering earlier dates show those sales as
  unattributed, which is truthful rather than reconstructed.
- No owner UI exists yet for some employee administration paths; see the Devices
  and Employee Management sections for what is actually exposed.
- The Windows installer remains **unsigned**; Windows may show a SmartScreen
  warning.

---

## RC-2 — native packaging validation record

> **No artifact was published. No tag or GitHub Release was created. The public
> download pointers were not moved.** v1.3.0 remains a release candidate.

Validated against source SHA `96b25b8f32da57e49e37220fefe0e59267173f24`
(`release/v1.3.0-rc`), chain `96b25b8 → 44ddf22 → 018a76f`.

### Shared device runtime — BUILT AND VERIFIED

Both native targets package the same runtime, built by `native-device/` + vite
from the RC-1 checkout. Built twice, once per target output directory, and the
bundles are byte-identical:

| Field | Value |
|---|---|
| Source SHA | `96b25b8f32da57e49e37220fefe0e59267173f24` |
| Android command | `npm run android:release:sync` (`android:runtime` + `cap sync android`) |
| Windows command | `npm run windows:runtime` |
| Bundle | `index-DldWgyS-.js` — 589,776 bytes, sha-256 `cf8a5a49cbd2d32d…` |
| Stylesheet | `index-BZ9g1jHk.css` — 62,053 bytes |
| Android output | `android/app/src/main/assets/public/` |
| Windows output | `windows-shell/runtime/` (entry `index.html` present — the workflow's fail-closed check, replicated locally) |
| Status | **PASS** — generated from this checkout, not inherited from an earlier build |

### Android — RC ARTIFACT NOT PRODUCED (signing material absent)

| Field | Value |
|---|---|
| Source SHA | `96b25b8f32da57e49e37220fefe0e59267173f24` |
| versionName | `1.3.0` (source: `android/app/build.gradle`) |
| versionCode | `4` (source: `android/app/build.gradle`) |
| applicationId / namespace | `com.poscanvas.app` — **unchanged** |
| Build command | `./gradlew clean assembleRelease` (JDK 21, Android SDK build-tools 36.0.0) |
| Build type | release |
| Result | **FAILED AT THE SIGNING GATE, BY DESIGN** |
| Failing task | `:app:packageReleaseResources` |
| Reason | `android/keystore.properties` not found |
| APK filename | **none** |
| Size / sha-256 | **none — no artifact exists** |
| Signing status | **NOT SIGNED — no release APK was produced** |
| Publication status | **NOT PUBLISHED** |

`android/keystore.properties` is gitignored and absent from this machine's
checkout. `build.gradle` refuses every task matching
`^(assemble|bundle|package)Release.*` when it is missing, deliberately, so that
no unsigned or debug-signed release APK is ever written — and none was: the
`app/build/outputs/apk/release/` directory does not exist. **The signing
architecture is unchanged and was proven to refuse.** No keystore or credential
was created, rotated or inspected.

Producing the Android RC artifact requires the release keystore and its three
secrets, which is a signing-material decision, not a packaging step.

### Windows — RC ARTIFACT NOT PRODUCED (workflow not invoked)

| Field | Value |
|---|---|
| Source SHA | `96b25b8f32da57e49e37220fefe0e59267173f24` (pushed to `origin/release/v1.3.0-rc`) |
| Version | `1.3.0` (`windows-shell/package.json`) |
| Workflow | `.github/workflows/windows-app.yml` — "Windows app" |
| Run ID | **none — not dispatched** |
| Installer type / arch | NSIS, x64 (config-verified) |
| Expected filename | `POS-Canvas-Windows-v1.3.0.exe` (from `artifactName: POS-Canvas-Windows-v${version}.${ext}`) |
| Size / sha-256 | **none — no installer exists** |
| Packaging status | **CONFIG-VERIFIED ONLY — not built** |
| Signing status | unsigned by design (the job is named "Build unsigned Windows installer") |
| Publication status | **NOT PUBLISHED** |

The installer requires the Windows runner; electron-builder NSIS cannot be
produced from macOS, and the workflow's own header says so. The workflow was
**not** dispatched because no GitHub CLI or usable API credential is available
in this environment, and none was requested.

**Workflow safety was audited before any attempt**, and it is safe to invoke:
`workflow_dispatch` only (no tag or push trigger, deliberately deferred);
`permissions: contents: read`, so it *cannot* create a tag or a Release; no
release, publish or deploy step; `electron-builder --win --x64 --publish never`;
output goes only to `actions/upload-artifact` with 30-day retention; and the
cash-drawer step verifies the native module is *packaged* without running it.

**Packaging configuration verified from source** (not a substitute for a build):

| Check | Result |
|---|---|
| Target / arch | `nsis`, `x64` |
| `--publish never` | present in `build:windows` |
| Cash Drawer 1C modules in `files` | all six: `main.mjs`, `preload.js`, `cashDrawerProfiles.mjs`, `cashDrawerRaw.mjs`, `cashDrawerIpc.mjs`, `win32Spooler.mjs` |
| `runtime/**/*` in `files` | present, and the runtime now exists |
| koffi pin | `koffi@3.3.2` exact, `@koromix/koffi-win32-x64@3.3.2` in the lockfile |
| `asarUnpack` | `node_modules/koffi/**` and `node_modules/@koromix/koffi-win32-x64/**` — the `.node` binary lands outside `app.asar` |
| Electron security | unchanged; `windowsShellSecurity`, `windowsShell` and `windowsInstaller` guards pass |

**Packaging a drawer bridge is not drawer validation.** Cash Drawer physical
end-to-end validation remains **NOT YET COMPLETED** — see the Cash Drawer
section above. No hardware was contacted during RC-2.

### Known test-harness debt found by RC-2

Running the Android packaging pipeline locally surfaced a third instance of the
artifact-isolation problem RC-0B corrected. `lib/cashDrawer.guards.test.ts`
walks `android-shell`, and `npm run android:release:sync` writes the shared
device bundle to `android-shell/www/` — gitignored, untracked, and legitimately
containing drawer code. RC-0B's `GENERATED_NOT_AUTHORED` set covers only
`windows-shell/runtime`, so this path is still scanned.

Proven to be artifact coupling, not a source defect, on identical source: with
`android-shell/www` present the guard reports 1 failed / 27 passed; with it
absent, 28 passed. `windows-shell/runtime` was present in both runs, so RC-0B's
correction is holding. **Not fixed in RC-2** — a test change is outside RC-2's
authorized scope.

## Before v1.3.0 may be called released

1. The 14 production migrations applied and verified —
   `PRODUCTION_MIGRATION_RUNBOOK_v1.3.0.md`.
2. v1.3 web app deployed.
3. Android and Windows artifacts built, published, downloaded **from their
   public URLs** and checksum-verified.
4. Release pointers moved, and the temporary lag allowance in
   `lib/releaseVersion.guards.test.ts` restored to strict equality.
5. Cash Drawer exposure decided: either checkpoint 1E passes, or Control Room
   separately approves and validates a safe exposure strategy. Until one of
   those happens, Cash Drawer stays unexposed as physically validated.

Until every one of those is done, this document is the authority on what v1.3.0
is: **a release candidate.**
