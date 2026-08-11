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

| Setting | Value |
|---|---|
| Site URL | your production URL, e.g. `https://your-app.vercel.app` |
| Redirect URLs | the production URL, plus `http://localhost:3000` for local work, plus a preview pattern if you use preview deployments |

This matters because `signUp()` does not pass an `emailRedirectTo` — confirmation
links fall back to the Site URL. Left at `localhost:3000`, every production
sign-up emails a dead link.

**Authentication → Providers → Email**

Decide whether **"Confirm email"** is on:

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

**What it proves today:** that the **owner** website runs correctly inside a
WebView on Android, signed in with the owner's own web session. Pointing it at
`/device` (below) is what turns it into a paired till.

### The server URL is build-time, not runtime

`POS_CANVAS_ANDROID_SERVER_URL` is read during `npm run android:sync` and
written into `android/app/src/main/assets/capacitor.config.json`, which ships
**inside the APK**. There is no settings screen and no runtime switching.

To point the app at a hosted deployment:

```bash
POS_CANVAS_ANDROID_SERVER_URL=https://your-app.vercel.app npm run android:sync
```

Then rebuild and reinstall the APK from Android Studio (or
`./gradlew assembleDebug` in `android/`).

**Changing the URL always requires both a re-sync and an APK rebuild.** A
deployed APK cannot be re-pointed from the server side.

An `https://` URL needs no native changes: cleartext is disabled by default and
is narrowly allowed only for `10.0.2.2` (emulator) and `localhost` (via
`adb reverse`) for local development.

### The paired-device flow

Device pairing is implemented end to end. An owner creates a one-time code in
the editor's **Devices** section; a device opens `/device`, enters the code, and
runs the menu and prices from the build it was pinned to. Revoking a device from
the Devices section stops it selling on its next request.

The Android app currently still points at the site root, so it runs the **owner**
site in a WebView. Re-syncing it to `/device` turns it into a dedicated till —
see the command above.

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
