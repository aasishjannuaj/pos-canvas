# Deployment

How to host POS Canvas. For local setup see [README.md](./README.md).

The system is **three separately-hosted pieces**, and they cannot be collapsed
into one deployment:

| Component | Where it runs |
|---|---|
| Web app (owner site + POS runtime) | Vercel |
| Backend — Postgres, Auth, Storage | Supabase (hosted) |
| Build worker | A machine you control — **not** Vercel |

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
this permanently breaks device pairing. (The pairing product UI does not exist
yet — see Feature 16.4 below — but the setting is a prerequisite for it.)

Not used by this project: Edge Functions, cron jobs, Realtime, and any bucket
other than `build-artifacts`.

---

## 3. Build worker

The worker **does not run on Vercel** and cannot. It is a standalone Node
process, not a route: Vercel offers no always-on process to host it.

```bash
npm run worker:once -- --target android
```

`--target desktop` is also accepted.

What to know before relying on it:

- **It requires a local `.env.local`.** The npm script is literally
  `node --env-file=.env.local --import tsx worker/once.ts`, so it fails
  immediately on a machine without that file. It needs
  `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and the
  service-role key must be treated as a production secret wherever it lives.
- **One shot, then exit.** It makes a single claim attempt. There is no polling
  loop and no supervisor. If no job is queued it logs `no_job_available` and
  exits cleanly.
- **It produces `json_config` artifacts — not APK files.** No signed or
  installable artifact is generated by any part of this system today.
- **Nothing runs it automatically.** A build requested from the editor sits in
  `queued` until someone runs the command. Until that is automated, treat the
  Build button as a manual, operator-assisted flow.

For an initial hosted test, running it on your own machine on demand is
sufficient. The natural next step is a GitHub Actions `workflow_dispatch` job
with the service-role key stored as a repository secret.

---

## 4. Android shell

The Android app is a Capacitor WebView that loads the hosted site over the
network. It bundles no POS runtime, no configuration and no credentials.

**What it proves today:** that the **owner** website runs correctly inside a
WebView on Android. It signs in with the owner's own web session. It is a
packaging proof, not a till, and there is no paired-device flow in it.

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

### Feature 16.4 — the paired-device product flow

The database and server layer for device pairing are complete and hardened:
one-time codes, anonymous-only redemption, a device pinned to one approved
build, pricing frozen to that build's config snapshot, and owner-controlled
revocation.

**The product UI does not exist.** There is no pairing-code entry screen, no
owner pairing-management screen, and no device route. Feature 16.4 will add
them. Until then, do not describe the Android app as a paired device — it runs
the owner site with an owner session.

---

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
6. Request a build, then run the worker locally and confirm the job reaches
   `succeeded` and the artifact downloads.
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
- **Bad Android URL** — the previously installed APK still points at the old
  origin. Re-sync with the correct URL, rebuild, reinstall. No server-side change
  can fix an already-deployed APK.

Never roll back by dropping migration columns, functions or triggers. They hold
committed order history and protect live money paths; roll back code, not schema.
