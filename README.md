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
| Build jobs + artifact download | Working, but a build only completes when the worker is run manually (see below) |
| Android shell | Proves the **owner** website runs in a WebView. It is a packaging proof, not a till |
| Paired-device pairing — database and server layer | Complete and hardened |
| Paired-device **product UI** | **Not built.** Planned as Feature 16.4 |

### Current limitations

These are known and intentional at this stage:

- **No owner pairing-management UI** — the server actions exist
  (`lib/devicePairing.actions.ts`), but no screen calls them.
- **No device pairing-code entry UI** — nothing in the app calls
  `signInAnonymously` or `redeem_device_pairing_token`.
- **No dedicated paired-device route** — `/runtime/[id]` is owner-only; a paired
  device has no page to load.
- **No continuous build worker** — one shot per invocation, run by hand.
- **No APK artifact generation** — builds produce a `json_config` file, not an
  installable app.
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
| `npm run worker:once -- --target android` | One build-worker pass (see DEPLOYMENT.md) |
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
  service-role key and never runs inside the web app.
