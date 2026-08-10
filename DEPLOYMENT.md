# Deployment

How to host POS Canvas. For local setup see [README.md](./README.md).

The system is **three separately-hosted pieces**, and they cannot be collapsed
into one deployment:

| Component | Where it runs |
|---|---|
| Web app (owner site + POS runtime) | Vercel |
| Backend — Postgres, Auth, Storage | Supabase (hosted) |
| Build worker | GitHub Actions (scheduled) — **not** Vercel |

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

Set all three in **Project Settings → Environment Variables** for the
Production environment (and Preview, if you want auth to work on preview
deployments).

| Variable | Environments | Exposure |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Production (+ Preview) | Public — inlined into the browser bundle |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Production (+ Preview) | Public — inlined into the browser bundle |
| `SUPABASE_SERVICE_ROLE_KEY` | Production (+ Preview) | **Secret — server-only** |

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
| Triggers | `schedule` (every 15 minutes) and `workflow_dispatch` (manual) |
| Target | **Android only** for the MVP |
| Batch | Up to 5 one-shot worker invocations per run, never a polling loop |
| Permissions | `contents: read` — the workflow never writes to the repository |
| Concurrency | Serialized, `cancel-in-progress: false` |

### Timing, honestly

A queued build is normally picked up within **0–15 minutes**. GitHub schedules
are **best-effort and can be delayed** under platform load, so no exact time is
promised anywhere in the product UI. The build itself takes about a second —
essentially all of the wait is scheduling latency. Use **Run workflow** in the
Actions tab for immediate processing.

The cadence is 15 minutes rather than GitHub's 5-minute minimum because on a
private repository each run bills GitHub-hosted minutes and partial job minutes
round up. Four runs an hour keeps a mostly-empty polling worker inexpensive;
manual dispatch covers anyone who needs a build right away.

### This schedule is also the recovery mechanism

Reclaiming a build whose worker died, and force-failing one that has exhausted
its three attempts, both happen inside `claim_next_build_job`. Nothing else
performs that recovery, so the workflow must keep running even when the queue
is normally empty. **On a public repository, GitHub disables scheduled
workflows after 60 days without repository activity** — if that happens, builds
*and* stale-job recovery both stop silently.

### Secrets

Add these in **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Your `service_role` key |

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
3. Add the three environment variables **before** the first build — two of them
   are inlined at build time.
4. Set the Supabase Site URL, Redirect URLs, anonymous sign-ins and the
   email-confirmation choice.
5. Deploy, then smoke-test in the browser: sign up, create a project, edit the
   menu, open the runtime, complete a cash sale and a card sale, check the order
   number and receipt, confirm inventory moved, and press Pay twice on an
   unchanged cart to confirm the retry returns the same order rather than
   selling twice.
6. Request a build and confirm the scheduled worker moves it to `succeeded`
   and the artifact downloads. Use **Run workflow** to avoid waiting.
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
  as they did before this workflow existed. Rotate the service-role key if the
  workflow is removed for a security reason.
- **Bad Android URL** — the previously installed APK still points at the old
  origin. Re-sync with the correct URL, rebuild, reinstall. No server-side change
  can fix an already-deployed APK.

Never roll back by dropping migration columns, functions or triggers. They hold
committed order history and protect live money paths; roll back code, not schema.
