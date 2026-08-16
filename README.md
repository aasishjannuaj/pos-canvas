# POS Canvas

A point-of-sale builder. An owner designs a POS in the browser — menu, pricing,
tax, branding, receipt settings — and runs it as a live till backed by
server-authoritative checkout, inventory and reporting.

Built with Next.js 16 (App Router) and Supabase (Postgres, Auth, Storage).

For hosting, environment variables and Supabase dashboard setup, see
[DEPLOYMENT.md](./DEPLOYMENT.md).

## What exists today

| Area | State |
|---|---|
| Owner web app — sign-up, projects, editor, live preview | Working |
| Owner POS runtime — cash/card sales, receipts, inventory | Working |
| Server-authoritative checkout (`complete_sale_v2`) | Working — prices, totals and order numbers are computed in the database, never trusted from the browser |
| Dashboard, sales / product / inventory reports | Working |
| Build jobs + artifact download | Working — requesting a build starts a GitHub Actions worker on demand (Android target) |
| Android shell | Proves the **owner** website runs in a WebView. It is a packaging proof, not a till |
| Paired-device pairing — database and server layer | Complete and hardened |
| Paired-device **product UI** | Working — owner Devices section creates pairing codes; `/device` runs the paired till |

### Current limitations

These are known and intentional at this stage:

- **No device rename or last-seen tracking** — a paired device is recorded once
  as "POS Device" with its platform, and those fields are immutable by design.
- **No APK artifact generation** — builds produce a `json_config` file, not an
  installable app. The Android app is a single universal shell that pairs to a
  build; it is not generated per project.
- **Build processing starts on demand.** Requesting a build queues it in the
  database and then asks GitHub Actions to start a worker run immediately; there
  is no polling schedule. The build row is the source of truth, so if GitHub
  cannot be reached the build stays safely queued and the Builder offers "Retry
  processing" rather than losing it.
- **No offline mode** — the Android shell shows an honest failure screen when the
  network is unavailable.
- **No native printing** — printing uses the browser print path.

## Local development

Requires Node.js 20+ (developed on 24) and npm. There is no local database —
the app talks to a hosted Supabase project.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill in `.env.local` before starting. From your Supabase project's
**Project Settings → API**:

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL | Sent to the browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` / public key | Sent to the browser; RLS constrains it |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` key | **Server-only secret.** Never prefix with `NEXT_PUBLIC_` |

Then open <http://localhost:3000>.

The Supabase project must already have this repository's migrations applied
(`supabase/migrations/`). Sign-up, projects, checkout and reporting all depend
on them; the app has no local fallback.

`POS_CANVAS_ANDROID_SERVER_URL` is **not** needed for web development — only for
`npm run android:sync`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server on <http://localhost:3000> |
| `npm run build` | Production build |
| `npm start` | Serve a production build |
| `npm test` | Full test suite (Vitest) |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | Standalone type check |
| `npm run worker:once -- --target android` | One build-worker pass locally, using `.env.local` |
| `npm run worker:run -- --target android` | Same worker, ambient environment only (used by CI) |
| `npm run android:sync` | Regenerate the Android shell assets and sync Capacitor |

## Testing

```bash
npm test
```

The suite is pure and offline — no database, no network, no fixtures against a
live project. Alongside the application tests, `supabase/migrations/*.test.ts`
are **static guards** over the migration SQL: they assert the text and structure
of each migration (grants, policies, guard clauses, function posture) and parse
every migration with the real PostgreSQL parser (`libpg-query`). They verify that
migrations *say* what they must; they do not execute them.

## Brand and app identity (Feature 24.1)

One declaration, in `lib/brand.ts`, that both app shells and the website are
checked against. Before this the same strings were typed into five unrelated
files that nothing connected.

| | |
|---|---|
| Product name | **POS Canvas** |
| Short name | **POS Canvas** |
| Company display name | **POS Canvas** |
| Application id | **com.poscanvas.app** |
| Legal company name | **Not yet defined — deferred** |
| Support email / marketing URL | None exist; `null` rather than invented |

**There is no approved legal entity.** `legalCompanyName` is `null` on purpose:
a display name in a legal position would be a false claim about who is
responsible for the software, and it is the field a code-signing certificate
subject, a privacy policy and terms of service would all have to agree with.
Anything needing it must state the requirement and stop.

### Platform branding is not customer branding

| | |
|---|---|
| **Platform** (`lib/brand.ts`) | The POS Canvas product: website, Android launcher, Windows app, splash, About. One identity for everyone. |
| **Customer** (`ProjectConfig.branding`) | A business's own accent colour and logo, frozen into a published `GeneratedPosConfig` and shown inside their till. Different per project. |

Guards in `lib/brand.guards.test.ts` assert both directions: the published
configuration gains no platform-brand field, and the customer logo pipeline
never imports the brand module.

### Status

- **24.1 — complete.** Identity centralised; website metadata fixed (it was
  still `Create Next App`); About panel added to the editor's Settings section;
  asset contract documented in `assets/brand/README.md`.
- **Final artwork is not chosen.** Android, Windows and the favicon all still
  carry their toolchains' default marks.
- **24.2** will implement the Android icon, adaptive icon and splash.
- **24.3** will implement the Windows icon, splash and installer branding.

The owner must supply and approve the master assets listed in
`assets/brand/README.md` before either can start. Nothing was generated,
downloaded or improvised in their place.

## Architecture notes

- **Authorization is enforced in the database.** Every table has Row Level
  Security, and `proxy.ts` only handles redirects — each server data path also
  re-checks the session and ownership independently.
- **Money is computed server-side.** The browser sends item ids and quantities;
  names, prices, tax, totals and order numbers come back from the database.
  Amounts cross the wire as fixed two-decimal strings, never floats.
- **Checkout is idempotent.** Each attempt carries a client-generated request id;
  a retry returns the original receipt instead of double-selling.
- **The build worker is a separate process**, not a route. It uses the
  service-role key, never runs inside the web app, and runs on GitHub Actions —
  dispatched by the web app when a build is queued, never on a schedule.
