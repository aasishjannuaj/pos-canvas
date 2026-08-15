# Deployment

How to host POS Canvas. For local setup see [README.md](./README.md).

The system is **three separately-hosted pieces**, and they cannot be collapsed
into one deployment:

| Component | Where it runs |
|---|---|
| Web app (owner site + POS runtime) | Vercel |
| Backend — Postgres, Auth, Storage | Supabase (hosted) |
| Build worker | GitHub Actions, dispatched on demand by the web app — **not** Vercel |

The Android shell is not hosted; it is an app that points at the web app's URL.

---

## 1. Web app on Vercel

### Import

Import the GitHub repository at <https://vercel.com/new>. Next.js is detected
automatically.

**Use the default install and build commands.** Do not override them:

| Setting | Value |
|---|---|
| Framework preset | Next.js |
| Install command | `npm install` (default) |
| Build command | `next build` (default) |
| Output directory | default |
| Root directory | repository root |

`next.config.ts` sets no custom output mode, so the standard Vercel Next.js
pipeline applies. The app uses Server Actions and a `proxy.ts` (middleware) but
has no API routes, no filesystem writes, no `child_process`, and no background
work — nothing that conflicts with serverless hosting.

### Environment variables

Set all four in **Project Settings → Environment Variables** for the
Production environment (and Preview, if you want auth to work on preview
deployments).

| Variable | Environments | Exposure |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Production (+ Preview) | Public — inlined into the browser bundle |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Production (+ Preview) | Public — inlined into the browser bundle |
| `SUPABASE_SERVICE_ROLE_KEY` | Production (+ Preview) | **Secret — server-only** |
| `GITHUB_BUILD_WORKER_TOKEN` | Production (Preview optional) | **Secret — server-only** (see §3a) |

Two rules that cause real outages if missed:

- **`SUPABASE_SERVICE_ROLE_KEY` must stay server-only.** It bypasses Row Level
  Security completely. Never rename it with a `NEXT_PUBLIC_` prefix and never
  reference it from a Client Component. Without it, every Server Action that
  builds an admin client fails with
  `createAdminClient: required Supabase server configuration is missing.` —
  which breaks the Build button, artifact download and all pairing actions.
- **`NEXT_PUBLIC_*` values are baked in at build time.** Editing either one in
  the Vercel dashboard changes nothing until you **redeploy**. There is no
  runtime pickup.
- **`GITHUB_BUILD_WORKER_TOKEN` must stay server-only too.** It is what starts
  the build worker. Without it, builds still queue safely but never start on
  their own; §3a covers creating it, its exact permissions, and the symptom when
  it is missing.

`POS_CANVAS_ANDROID_SERVER_URL` is **not** a Vercel variable. It is used only
when building the Android app locally.

---

## 2. Supabase configuration

Most of the backend is already defined in `supabase/migrations/` and needs no
dashboard work: all tables, RLS policies, RPCs and their grants, the privilege
matrix, the immutability triggers, and the private `build-artifacts` storage
bucket (created by `20260729190422_build_artifact_storage.sql`, with no
anon/authenticated object policies by design — downloads go through short-lived
signed URLs generated server-side).

Apply the migrations before the first deploy if the project does not already
have them.

### What must be set by hand in the dashboard

**Authentication → URL Configuration**

These are exact values, not examples. Password recovery does not work without
them.

| Setting | Value |
|---|---|
| **Site URL** | `https://pos-canvas.vercel.app` |
| **Redirect URLs** | `https://pos-canvas.vercel.app/auth/callback`<br>`http://localhost:3000/auth/callback` |

- **Site URL is the canonical production origin.** It is the fallback any auth
  email uses when no explicit redirect is supplied, so it must be the real
  production host — never a preview deployment and never `localhost`.
- **`http://localhost:3000/auth/callback` is an allow-list entry only.** It lets
  a developer exercise recovery against `npm run dev`. It must never be the Site
  URL, or production emails would point at a machine nobody else can reach.
- **Password recovery depends on the callback URL being allow-listed.** The
  reset email is sent with `redirectTo` pointing at `/auth/callback`; Supabase
  refuses to redirect anywhere its own list does not contain, so a missing entry
  makes every reset link fail. The app enforces the same two origins
  independently in `lib/siteOrigin.ts` — two lists, both of which must permit
  the value.
- Adding a preview-deployment origin here would let production reset emails be
  aimed at a preview build. Treat any addition as a security decision.

**Authentication → Providers → Email**

**Current MVP decision: "Confirm email" is OFF.**

With it off, `signUp()` returns a live session and the owner lands on the
dashboard immediately — the normal production path. The signup page still checks
for that session and, if one is ever unexpectedly absent (for example because
this setting was switched on), shows "Check your email to finish creating your
account" rather than navigating to a page the owner has no session for. That is
a defensive branch, not the expected flow.

If you turn confirmation on, re-read that behaviour first:

- **On** — closer to production, but requires the Site URL to be correct first.
- **Off** — simplest for an initial hosted test; sign-in works immediately. This
  is a reversible choice, so it is a reasonable starting point.

**Authentication → Providers → Anonymous sign-ins**

**Must remain enabled.** `redeem_device_pairing_token` accepts anonymous callers
only and fails closed when the `is_anonymous` JWT claim is missing. Disabling
this permanently breaks device pairing, which is now a shipped, user-facing
feature rather than a future one.

Not used by this project: Edge Functions, cron jobs, Realtime, and any bucket
other than `build-artifacts`.

---

## 3. Build worker

The worker **does not run on Vercel** and cannot: it is a standalone Node
process, not a route, and Vercel offers no always-on process to host it.

It runs on **GitHub Actions** instead — `.github/workflows/build-worker.yml`.

| Property | Value |
|---|---|
| Triggers | `workflow_dispatch` **only** — no `schedule`, no `push` |
| Started by | POS Canvas, via the GitHub REST API, when a build is queued |
| Target | **Android only** for the MVP |
| Batch | Up to 5 one-shot worker invocations per run, never a polling loop |
| Permissions | `contents: read` — the workflow never writes to the repository |
| Concurrency | Serialized, `cancel-in-progress: false` |

### How a run starts (Feature 17.2)

There is **no schedule**. The chain is:

1. An owner clicks **Build** in the Builder.
2. `requestBuildJob` (a Server Action) inserts the `build_jobs` row. This is the
   only thing that decides whether the build exists.
3. Only after that row is committed, the server calls
   `POST /repos/aasishjannuaj/pos-canvas/actions/workflows/build-worker.yml/dispatches`
   with `{"ref":"main"}`, authenticated by `GITHUB_BUILD_WORKER_TOKEN`.
4. GitHub starts a run; the worker claims the job and processes it.

The dispatch is content-free — no project id, owner id, or configuration is sent
to GitHub. The worker discovers its work by claiming from Postgres.

**If the dispatch fails, the queued build is left completely alone.** It is not
deleted, not failed, not modified. The Builder says *"Your build is queued, but
automatic processing could not be started"* and offers **Retry processing**,
which re-dispatches for that same build id and never creates a second one.

### Timing, honestly

A run is requested the moment a build is queued, so the wait is GitHub's
runner-startup time (typically well under a minute) plus `npm ci`, not a polling
interval. Nothing in the product UI promises a start time, because a successful
dispatch means GitHub *accepted* a run — not that a runner was available.

Expect to see **cancelled** runs in the Actions tab and expect them to be fine: a
concurrency group holds at most one running plus one pending run, so a burst of
Build clicks collapses to the in-flight run plus one behind it. The cancelled
entries never claimed a job.

### Stale-job recovery now rides on demand

Reclaiming a build whose worker died, and force-failing one that has exhausted
its three attempts, both happen inside `claim_next_build_job`, and nothing else
performs that recovery. With no schedule, that recovery only runs when the
workflow is dispatched.

POS Canvas therefore dispatches for a job in `building` as well as one in
`queued` (`needsBuildProcessing` in `lib/buildJobs.ts`). A job stuck `building`
after a dead worker also occupies its project's active-job index, so every later
Build click resolves to that job — and each of those clicks is what brings a
worker back to reclaim it.

**Known limitation:** if a build gets stuck and *nobody ever requests another
build*, nothing reclaims it on its own. The recovery paths are the owner's
**Retry processing** button and, for an operator, **Run workflow** in the Actions
tab. This is the accepted trade for removing ~96 empty runs a day.

One thing this change removes for free: GitHub disables scheduled workflows on
public repositories after 60 days of inactivity. With no schedule, there is
nothing left to be disabled.

### Secrets

Add these in **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Your `service_role` key |

These are still required and unchanged — they are what the *worker* uses. The
GitHub token that *starts* the workflow is a Vercel variable, not a GitHub
secret; see §3a.

Both are stored as secrets. The URL is not sensitive, but keeping both in one
place avoids a mixed secrets/variables setup for two values that are always
configured together, and secret masking on a non-secret value costs nothing.

The workflow injects them as step environment variables and never interpolates
them into command text. It has no `pull_request` or `pull_request_target`
trigger, so no pull request — least of all from a fork — can execute with this
credential.

### What it still does not do

- **It produces `json_config` artifacts, not APK files.** No signed or
  installable artifact is generated by any part of this system.
- The universal Android app is **separate** from the build artifact: a device
  gets its configuration by pairing, not by downloading a build.

For local development the worker still runs by hand against `.env.local`:

```bash
npm run worker:once -- --target android
```

`npm run worker:run` is the same worker reading ambient environment only, which
is what CI invokes.

---

## 3a. `GITHUB_BUILD_WORKER_TOKEN` (Vercel)

The credential POS Canvas uses to start the workflow. It lives **only in Vercel**
— never in this repository, never in `.env.local` committed anywhere, and never
in a GitHub secret.

### Creating the token

**Settings → Developer settings → Personal access tokens → Fine-grained tokens**

| Field | Value |
|---|---|
| Resource owner | `aasishjannuaj` |
| Repository access | **Only select repositories** → `aasishjannuaj/pos-canvas` |
| Repository permission → **Actions** | **Read and write** |
| Repository permission → Metadata | Read-only (mandatory; GitHub enables it automatically) |
| Every other permission | **No access** |
| Expiration | Set one, and calendar the rotation |

**Actions: Read and write is the only permission that needs granting.** It is
what `workflow_dispatch` requires. In particular **Contents write is NOT
required** — the workflow triggers a run, it does not push anything, and the
workflow itself still declares `permissions: contents: read`. If a dispatch ever
returns 403, the cause is a missing *Actions* write permission or a token whose
repository access does not include this repository; it is never a Contents
permission.

A classic (non-fine-grained) PAT would work but needs the whole `repo` scope,
which grants code write access to every repository the account can reach. Use a
fine-grained token.

### Adding it to Vercel

**Project → Settings → Environment Variables**

| Field | Value |
|---|---|
| Name | `GITHUB_BUILD_WORKER_TOKEN` |
| Value | the fine-grained PAT |
| Environments | Production (add Preview only if you want preview deploys to start real builds) |
| Type | Sensitive / encrypted |

Then **redeploy** — Vercel only picks up new environment variables on a new
deployment.

**Never prefix it with `NEXT_PUBLIC_`.** That prefix inlines a value into the
browser bundle, which would publish the token to every visitor.
`lib/githubBuildWorker.guards.test.ts` fails the test suite if the variable is
named in any file other than `lib/githubBuildWorker.server.ts`, if any client
component imports that module, or if the token is ever logged or returned.

### If it is missing

Build requests still work — the row is queued and nothing is lost — but every
one of them reports *"automatic processing could not be started"*, and the Vercel
function log carries `GITHUB_BUILD_WORKER_TOKEN is not configured`. Use **Run
workflow** in the Actions tab to drain the queue until the variable is set.

---

## 4. Android shell

The Android app is a Capacitor WebView that loads the hosted site over the
network. It bundles no POS runtime, no configuration and no credentials.

Since Feature 20 it is a **production-signable app**: a single universal APK
that any customer installs and then pairs to their own project. The APK is
byte-identical for every customer — a till becomes a specific business's till
through **pairing at runtime**, never through the binary.

| | |
|---|---|
| applicationId | `com.poscanvas.app` |
| Display name | POS Canvas |
| Release URL | `https://pos-canvas.vercel.app/device` (pinned in tracked code) |
| Distribution | Signed APK, hosted on GitHub Releases |

### The server URL is build-time, not runtime

The URL is written into `android/app/src/main/assets/capacitor.config.json`
during `npm run android:sync`, and that file ships **inside the APK**. There is
no settings screen and no runtime switching, so **a deployed APK can never be
re-pointed from the server side** — changing the URL always requires a re-sync
and a rebuild.

There are two modes, and the distinction is a safety boundary:

**Development** — `POS_CANVAS_ANDROID_SERVER_URL` supplies the URL:

```bash
POS_CANVAS_ANDROID_SERVER_URL=http://10.0.2.2:3000 npm run android:sync
```

**Release** — `npm run android:release:sync` sets `POS_CANVAS_ANDROID_RELEASE=1`,
which makes the resolver **ignore `POS_CANVAS_ANDROID_SERVER_URL` entirely** and
use the constant `PRODUCTION_ANDROID_SERVER_URL` in
`android-shell/serverUrl.mjs`. It also forces `webContentsDebuggingEnabled` off.

That flag exists because of a specific hazard: without it, syncing for the
emulator and then assembling a release would ship an APK pointed at
`http://10.0.2.2:3000`. It would install, launch, and show the offline screen
forever on a customer's till, unfixable from the server.

Cleartext is disabled by default. The `10.0.2.2` and `localhost` exceptions live
inside `<debug-overrides>` in `network_security_config.xml`, which Android
honours **only for a debuggable build** — so a release APK has no cleartext
exception at all, by construction.

### The paired-device flow

Device pairing is implemented end to end. An owner creates a one-time code in
the editor's **Devices** section; a device opens `/device`, enters the code, and
runs the menu and prices from the build it was pinned to. Revoking a device from
the Devices section stops it selling on its next request.

A release build always loads `/device` — the constant is asserted to end in that
path, because the site root is the **owner** application and must never be what
a customer's till loads.

### 4a. Android release build

Everything below is manual and run on the developer's Mac. Signing secrets are
never placed in CI for the MVP.

**One-time setup — creating the keystore.**

The keystore is **not** in this repository and must never be. Create it once,
outside the repo:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
mkdir -p ~/pos-canvas-signing
"$JAVA_HOME/bin/keytool" -genkeypair -v \
  -keystore ~/pos-canvas-signing/pos-canvas-release.jks \
  -alias <your-alias> \
  -keyalg RSA -keysize 4096 -validity 10000
```

Then create `android/keystore.properties` (gitignored — verify with
`git check-ignore android/keystore.properties`). **Placeholders only below; put
your real values in the file, never in the repo, a commit, a screenshot or a
chat:**

```properties
storeFile=/absolute/path/to/pos-canvas-release.jks
storePassword=<secret>
keyAlias=<secret>
keyPassword=<secret>
```

> **The keystore is irreplaceable.** An Android app is identified by its
> applicationId **plus** its signing certificate. Lose the key and you can never
> update the app: every customer must uninstall (losing their pairing) and
> install a differently-identified app. There is no reset, no appeal, and Google
> cannot help. Back it up **before** distributing anything:
>
> 1. Primary copy outside the repo (above).
> 2. Encrypted cloud — password manager file attachment, plus a secure note with
>    the store password, key password and alias.
> 3. Offline — encrypted USB or a printed copy of the credentials.
> 4. Record the SHA-256 certificate fingerprint (`keytool -list -v`) so a
>    recovered keystore can be proven correct.
> 5. Verify the backup actually restores before trusting it.

**Building a release.**

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"

npm ci
npm run android:release:sync      # pins the production URL, disables WebView debugging

cd android
./gradlew clean assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

No `npm run build` is needed — the runtime is hosted on Vercel and the APK
bundles no web assets beyond the offline page. **Deploy the web app first**: the
shell is useless against a stale deployment.

Without `android/keystore.properties`, `assembleRelease` fails with an explicit
message rather than producing an unsigned or debug-signed APK.

**Verifying the artifact.**

```bash
BT="$HOME/Library/Android/sdk/build-tools/36.0.0"
APK=android/app/build/outputs/apk/release/app-release.apk

"$BT/apksigner" verify --verbose --print-certs "$APK"   # signed; record the SHA-256 fingerprint
"$BT/aapt2" dump badging "$APK" | head -5               # package, versionCode, versionName
"$BT/zipalign" -c -v 4 "$APK"                           # alignment
unzip -p "$APK" assets/capacitor.config.json            # URL + webContentsDebuggingEnabled
shasum -a 256 "$APK"                                    # checksum for release metadata
```

Expect: package `com.poscanvas.app`; the URL exactly
`https://pos-canvas.vercel.app/device`; `webContentsDebuggingEnabled: false`;
`INTERNET` as the only permission.

**Versioning.** The canonical version lives in `android/app/build.gradle`, not
`package.json`. `versionCode` must **strictly increase** on every APK that
leaves the machine — Android refuses to install a lower code over a higher one.
`versionName` is the user-facing label.

| Release | versionName | versionCode |
|---|---|---|
| First | `1.0.0` | 1 |
| Patch | `1.0.1` | 2 |
| Minor | `1.1.0` | 3 |

**Updates.** An in-place upgrade requires the **same applicationId** and the
**same signing key**, plus a higher `versionCode`. Install with
`adb install -r app-release.apk`. The device's paired session lives in WebView
`localStorage` inside the app's private data directory, which an in-place
upgrade preserves — so a paired till stays paired. Changing either the
applicationId or the key breaks this permanently.

### 4b. Distribution

The APK is hosted on **GitHub Releases** — versioned binaries, permanent URLs,
no repo bloat, and no coupling to Vercel deploys. It contains no secret.

> **The APK is not a build artifact.** The `json_config` files produced by the
> build worker are **per-project** configuration snapshots. The APK is
> **universal**: one binary for every customer, containing no project id, no
> configuration and no branding. Do not conflate the two.

Owner flow: sign in → **Dashboard** → *POS Canvas for Android* card → download the
universal APK → allow installation from the browser/files app → install → open →
pair with a code from the project's **Devices** section.

The download card lives on the **account dashboard**, not inside a project. That
placement is the invariant, not a layout preference: a card sitting beside a
project's `json_config` artifact would imply the binary was generated for that
project. `components/dashboard/androidDownload.guards.test.ts` asserts the card
takes no project id, reads no build artifact, and renders no project-specific
copy.

### Publishing a release

After building and verifying the APK (§4a):

1. **Create a GitHub Release** on `aasishjannuaj/pos-canvas` with a new tag.
2. **Upload the APK** as a release asset, named `POS-Canvas-v<version>.apk`.
3. **Record the four facts** — do not transcribe them from memory:
   ```bash
   # URL, size and timestamp, straight from the API
   curl -sS "https://api.github.com/repos/aasishjannuaj/pos-canvas/releases/tags/<tag>" \
     | grep -E '"browser_download_url"|"size"|"published_at"'

   # Checksum, from the actual published bytes
   curl -sSL -o /tmp/check.apk "<browser_download_url>"
   shasum -a 256 /tmp/check.apk
   ```
4. **Update `CURRENT_ANDROID_RELEASE`** in `lib/androidRelease.ts` with those
   verified values, and update the pinned assertions in
   `lib/androidRelease.test.ts`.
5. **Commit and deploy the web app.** The card reads a module constant, so the
   new version only appears to owners after a deploy.

> **Verify the tag from the API; do not assume it.** The first publication of
> v1.0.0 was tagged `v.1.0.0` — with a stray dot — and the conventional URL
> returned 404 until it was re-tagged. It is now **`v1.0.0`**, serving a
> byte-identical APK (same sha-256, same signer certificate), and the old URL
> returns 404. Tags are `v<major>.<minor>.<patch>`, no dot after the `v`.
>
> A stale git tag named `v.1.0.0` may still exist in the repository's tag list
> even though its *release* is gone. Only the release and its asset URL matter
> for distribution; delete the leftover tag if you want the list tidy.

### Publishing an UPDATE

A new APK release requires all of the following:

| Requirement | Why |
|---|---|
| **Increment `versionCode`** | Android refuses to install a lower or equal code over an installed one. |
| **Update `versionName`** | The user-facing label; keep it semver `x.y.z`. |
| **Sign with the SAME key** | A different certificate is a different app — no in-place upgrade, and every till loses its pairing. |
| **New GitHub tag + asset** | Release assets are immutable; never replace the file on an existing tag. |
| **New checksum, size, timestamp, URL** | All four change; re-verify all four. |

`CURRENT_ANDROID_RELEASE` may be set back to `null` at any time — the card then
renders "Android release is not available yet." instead of a broken link. That
safe state is asserted by a guard and must be preserved.

There is deliberately **no auto-update mechanism**: owners re-download and
install over the existing app.

## 5. Deployment order

1. Apply migrations to the Supabase project (if not already applied).
2. Create the Vercel project from GitHub; keep default install/build commands.
3. Add the four environment variables **before** the first build — two of them
   are inlined at build time, and `GITHUB_BUILD_WORKER_TOKEN` is only picked up
   on a deployment (§3a).
4. Set the Supabase Site URL, Redirect URLs, anonymous sign-ins and the
   email-confirmation choice.
5. Deploy, then smoke-test in the browser: sign up, create a project, edit the
   menu, open the runtime, complete a cash sale and a card sale, check the order
   number and receipt, confirm inventory moved, and press Pay twice on an
   unchanged cart to confirm the retry returns the same order rather than
   selling twice.
6. Request a build and confirm a **Build worker** run appears in the Actions tab
   within seconds without anyone starting it, that the job reaches `succeeded`,
   and that the artifact downloads. If the Builder instead says processing could
   not be started, `GITHUB_BUILD_WORKER_TOKEN` is missing or under-permissioned
   (§3a) — the build itself is still safely queued.
7. Re-sync and rebuild the Android app against the hosted URL, and confirm the
   owner runtime loads over HTTPS in the shell.

## Rollback

- **Bad deployment** — promote the previous deployment in Vercel. The database
  schema is forward-compatible: the previous checkout function (`complete_sale`)
  is retained unchanged, so an older bundle keeps working.
- **Bad environment variable** — fix it and **redeploy** (the public ones only
  take effect at build time).
- **Bad auth redirect** — correct the Site URL / Redirect URLs in Supabase; this
  applies immediately with no redeploy and does not disturb existing sessions.
- **Build worker misbehaving** — disable the workflow in the Actions tab. No
  deploy and no schema change is involved; queued builds simply wait, exactly
  as they did before this workflow existed. Dispatches will then fail, so owners
  see "automatic processing could not be started" instead of a silent stall.
  Rotate the service-role key if the workflow is removed for a security reason.
- **GitHub token compromised or expiring** — revoke it on GitHub, issue a new
  fine-grained token (§3a), update the Vercel variable and redeploy. The token
  can only start runs of one workflow in one repository; it cannot read code,
  write contents, or reach Supabase. Builds queue normally throughout, and
  **Run workflow** drains them in the meantime.
- **Bad Android URL** — the previously installed APK still points at the old
  origin. Re-sync with the correct URL, rebuild, reinstall. No server-side change
  can fix an already-deployed APK.

Never roll back by dropping migration columns, functions or triggers. They hold
committed order history and protect live money paths; roll back code, not schema.
