# POS Canvas — MVP Release Checklist

> ## Release 1.1.0 — COMPLETE and live (2026-08-31)
>
> | | |
> |---|---|
> | Final release commit | `d82b32d` — *feat: point downloads at 1.1.0, and stop hiding that Windows is unsigned* |
> | Android | `versionName 1.1.0`, `versionCode 2` — tag **`v1.1.0`**, published `2026-08-31T18:03:31Z` |
> | Android asset | `POS-Canvas-v1.1.0.apk` — `00763a36d8ddcba676ec0f0afec477a2784579c0d9968b28eaaea91510af1df1`, 4,121,584 bytes |
> | Android signer | `7e32ec72c659dfacdab880d7fbe68991cf6104d11434f15d0c516bb9c6525b1b` — unchanged since 1.0.0, so 1.1.0 installs in place |
> | Windows | `1.1.0` — tag **`windows-v1.1.0`**, published `2026-08-31T18:12:54Z`, `prerelease=false` |
> | Windows asset | `POS-Canvas-Windows-v1.1.0.exe` — `c8f1fa82c2e95bdaa06adc3360275c58b57dd8737b2a98f287990f0193b827fe`, 100,260,898 bytes, **unsigned** |
> | Production migrations | `20260823120000_device_voluntary_unpair.sql` and `20260823130000_device_sales_history.sql` — **both applied and verified** |
> | Production web | **deployed**; publish worker verified; Sales History verified against production |
> | Final smoke | **PASS** |
> | P0-1 Windows CI runtime generation | **CLOSED** |
> | P0-2 stale published Windows v1.0.0 | **CLOSED** |
> | P0-3 publish reported a stale snapshot | **CLOSED** |
>
> Both checksums were verified against the bytes GitHub actually **serves**, not
> local copies. Everything below this banner is the standing process; the
> per-item history is preserved as written.


**Shipped release: 1.1.0** (web, Android, Windows) — see the banner above.
**Baseline commit when this document was written: `ee29ce1`.**
**Final release commit: `d82b32d`.**

This document is the gate for a production release. It is written against the
architecture as it actually is today, not as it was designed. Where something is
known to be broken or deferred, it says so rather than omitting it.

Two rules govern every step below:

1. **Nothing is verified until the real thing has run.** A source-string
   assertion tells you a file says what its author believed, never that the
   behaviour is correct. This project has been bitten by that twice — the
   singular `registerSchemeAsPrivileged` and the PostgREST classifier — and both
   times the answer was to boot the real binary.
2. **Migrations lead the client that depends on them.** A UI that reaches for an
   RPC production does not have yet is a broken till, not a degraded one.

---

## 0. Release version target

| Surface | In tree | Published | Ordering key |
|---|---|---|---|
| Web (Vercel) | continuous | continuous | n/a |
| Android | **`versionName 1.1.0`, `versionCode 2`** | 1.0.0 / 1 | `versionCode` **must strictly increase** |
| Windows | **`1.1.0`** | 1.0.0 | `version` in `windows-shell/package.json` |

**The bump is done in the tree (25.7 step 1); nothing is built or published.**
The two columns differ on purpose and must keep differing until step 8.

Every file that carries a release version, and what it is for:

| File | Field | 1.0.0 → 1.1.0 |
|---|---|---|
| `android/app/build.gradle` | `versionCode` **2**, `versionName` **"1.1.0"** | **DONE** — the canonical Android version |
| `windows-shell/package.json` | `"version": "1.1.0"` | **DONE** — drives `POS-Canvas-Windows-v${version}.exe` |
| `.github/workflows/windows-app.yml` | `name: pos-canvas-windows-v1.1.0` | **DONE** — hardcoded, and it does not follow the version |
| `windows-shell/README.md` | artifact/asset names in the release runbook | **DONE** — documentation only |
| `DEPLOYMENT.md` | the Android release-history table | **DONE** — 1.1.0 / code 2 recorded as not-yet-built |
| **`package.json` (root)** | `"version": "0.1.0"` | **No.** `private: true`, deploys continuously, and `build.gradle` states the Android version is *"deliberately not derived from package.json"* so a web release cannot force version churn. It has never been bumped for a release. |
| `lib/androidRelease.ts` | `CURRENT_ANDROID_RELEASE` | **Not yet** — step 8 of §10, after the artifact is published and verified |
| `lib/windowsRelease.ts` | `CURRENT_WINDOWS_RELEASE` | **Not yet** — same, and this is what closes P0-2 |

> `DEPLOYMENT.md`'s table shows Minor = `1.1.0` / code `3`. That is an
> illustration of how codes advance, not a mandate. Only one release has
> shipped (code 1), so the next code is **2**. The rule is that it strictly
> increases, nothing more.

`versionCode` is what Android actually orders releases by; `versionName` is only
a label. Windows has no equivalent, which is why the NSIS installer relies on
`appId` + version alone.

The four in-tree locations are kept in lockstep by
`lib/releaseVersion.guards.test.ts`, which also fails if a release pointer is
moved before its artifact exists. The CI artifact name is the one that needs a
guard most: it is a literal and derives from nothing.

**Do not update the release pointers until every artifact is built, downloadable
and checksum-verified — step 8 of §10.**

---

## 1. Pre-release gates

- [ ] `main` == `origin/main`, no tracked working-tree changes
- [ ] Only `supabase/config.toml` remains untracked (see §9 — it must never be committed or pushed)
- [ ] 19 migrations on disk == 19 tracked
- [ ] Production and staging migration state known and recorded (§10)
- [ ] Release freeze declared: no feature work, only P0 fixes

---

## 2. Automated gate

Run from a clean tree. All five must pass:

```bash
npm test && npm run lint && npx tsc --noEmit && npm run build && git diff --check
```

Expected at `ee29ce1`: **108 test files, 3331 passed, 1 skipped, 0 failed.**

The one skip is `windowsStartup.smoke.test.ts > reports why the Electron smoke
test did not run` — it is skipped *because* the smoke test ran. If that test
starts **passing**, the Electron smoke test did not execute and the Windows
evidence below is void.

Suites that must be green individually, because each one guards a defect that
actually shipped:

| Suite | Guards |
|---|---|
| `windowsStartup.smoke.test.ts` | Electron really boots; the scheme API exists under its real name |
| `receiptPrinting.guards.test.ts` | One receipt per print job; no name is ellipsised |
| `salesHistoryUi.guards.test.ts` | Cart survives history; history never re-prices from today's menu |
| `deviceUnpair.guards.test.ts` | Unpair lifecycle; settings reachable and covering |
| `deviceStartupError.guards.test.ts` | A refused start is never reported as "No connection" |
| `deviceColdStart.test.ts` | Offline cold start over real IndexedDB — lease, digest, identity |
| `offlineCheckout.guards.test.ts` / `offlineQueue.guards.test.ts` / `offlineTorture.test.ts` | Queue durability, idempotency, transport classification |
| `androidDeviceRuntime.guards.test.ts` | No service-role key can reach an APK |
| `windowsShellSecurity.guards.test.ts` / `windowsInstaller.guards.test.ts` | Navigation policy, protocol privileges, installer posture |

---

## 3. Web QA (owner flow)

Run against **staging**. Do not mutate production.

- [ ] Sign in
- [ ] Create a project, and open an existing one
- [ ] Edit business profile, menu, modifiers, receipt settings
- [ ] **Save** — reload the editor and confirm the values persisted
- [ ] **Publish configuration**
- [ ] Stepper advances **Preparing → Queued → Publishing → Published**
- [ ] Each stage carries a shape *and* a word, not colour alone
- [ ] **No percentage and no progress bar.** The animation may only say "working"
- [ ] A failed publish shows a truthful failure state and does not silently retry
- [ ] The published `json_config` exists and is immutable
- [ ] Reopening the editor still shows the saved project correctly

**Known behaviour, not a bug:** a job stuck in `queued` polls for as long as the
editor is open. It never fabricates progress. See §12 (P1).

**Verify the snapshot, not the stepper.** *Published* means a new snapshot
exists; it does not mean the tills are using it. After any publish QA, confirm in
the database that the newest build's `config_snapshot` actually contains the
change before drawing conclusions from a till. This is what 25.6 regression
missed, and it cost a full debugging cycle. A paired till will still not show the
change until it is re-paired — see §12 item 2c.

---

## 4. Device pairing / lifecycle QA

- [ ] Fresh pairing from a code → POS opens
- [ ] Paired device shows as **Active** in the owner dashboard
- [ ] Device settings reachable from the ⋯ operator menu
- [ ] **Voluntary unpair** → device returns to the pairing screen
- [ ] Re-pair creates a **new** `paired_devices` row
- [ ] The old row remains, shown as **Unpaired** (not Revoked, not deleted)
- [ ] Owner-side **revoke** → device shows the revoked screen
- [ ] Unpaired crash recovery: kill the app mid-unpair, relaunch, device recovers
- [ ] **Unresolved financial evidence blocks unpair** — a queued or
      needs-attention sale must prevent it, with a truthful explanation
- [ ] A server rejection never grants offline cache access

The full 25.1 torture suite does **not** need re-running unless one of the above
fails; it is covered by `deviceUnpair.guards.test.ts` and `offlineTorture.test.ts`.

---

## 5. Sales / offline QA

Automated evidence is sufficient for most of this. Hardware checks are marked **[HW]**.

- [ ] Cash sale — totals match the POS **[HW]**
- [ ] Card-recorded sale — payment method persists as `card` **[HW]**
- [ ] Tax and tip totals computed **server-side** (never trusted from the client)
- [ ] Inventory decrements for tracked items; untracked items unaffected
- [ ] Offline sale queues durably in IndexedDB **[HW]**
- [ ] Provisional **OFF-** receipt shows, with no order number **[HW]**
- [ ] Reconnect drains the queue without a restart **[HW]**
- [ ] **OFF → ORD** reconciliation: the provisional receipt resolves to the real order
- [ ] Idempotency: a replayed `sale_request_id` returns the *same* order id and
      number and creates no second audit row
- [ ] `needs_attention` surfaces Review/Discard and withholds Retry where correct
- [ ] Post-revocation sale is refused and retained, never silently dropped
- [ ] Stock shortfall behaves per the offline policy
- [ ] 7-day lease: opens on day 6, refuses on day 8 with `reconnect_required`
- [ ] **No false network messaging** — a refused start says "Unable to start this
      device", never "No connection" (Feature 25.4)

---

## 6. Sales History / receipts QA

- [ ] One ⋯ operator menu; no second standalone settings pill
- [ ] Menu offers exactly **Sales history** and **Device settings**
- [ ] History list loads; empty, offline, error and not-paired states each read plainly
- [ ] Pagination appends and never resets; **Load more** failure keeps rows on screen
- [ ] No duplicate rows across pages (dedupe is on `orderId`, never order number —
      order numbers are unique only *within* a project)
- [ ] Historical receipt shows **stored** prices and totals, never today's menu
- [ ] **Cart survives** opening and closing history mid-order **[HW]**
- [ ] Windows historical reprint prints correctly **[HW]**
- [ ] **Checkout receipt left open + historical reprint prints ONLY the
      historical receipt** **[HW]** — the 25.5 blocker case
- [ ] Long item and modifier names **wrap**, never ellipsised **[HW]**
- [ ] Android: Reprint disabled with a visible explanation, no print dialog reachable **[HW]**
- [ ] No Delete / Void / Refund / Edit action anywhere in history

---

## 7. Printing QA (Windows)

- [ ] Print from checkout — preview contains the completed sale, not the cart
- [ ] Totals on paper match the POS
- [ ] Cancel the dialog → app continues normally, no error, no "Printed" message
- [ ] Print the same receipt twice → identical output
- [ ] **Nothing ever claims a print succeeded.** `window.print()` reports no
      outcome, and no code may invent one
- [ ] 80mm thermal: the 320px column fits without clipping either margin **[HW, if available]**
- [ ] Microsoft Print to PDF / Letter: renders acceptably; keep the PDF as evidence

Note: there is **no `@page` rule**, so physical paper size and margins are the
driver's decision. Wrapped names make receipts taller, so a very large order on
Letter/A4 may cross a page boundary mid-item. See §12 (P2).

---

## 8. Security checklist

- [ ] Staging: 9 public product tables, **all RLS enabled**
- [ ] Staging: **no `staging_*` leftover relations or functions**
- [ ] Staging: **no ERROR-level Security Advisor lint**
- [ ] Production: 9 public product tables, all RLS enabled, no `staging_*` objects
- [ ] Anonymous device auth **enabled intentionally** on both — it *is* the device identity
- [ ] No `service_role` key in any client artifact (APK, EXE, web bundle)
- [ ] No JWT literal in tracked source
- [ ] Only `.env.example` is tracked; no real `.env*` committed

**Never run `supabase config push` from this checkout.** `supabase/config.toml`
is an untracked CLI scaffold carrying `enable_anonymous_sign_ins = false`.
Pushing it would disable anonymous sign-in and overwrite every other auth setting
with scaffold defaults — tills would stop pairing with no obvious cause.

Accepted advisor warnings (by design, not defects):
`auth_allow_anonymous_sign_ins` ×8 (device identity),
`authenticated_security_definer_function_executable` ×16 and
`anon_security_definer_function_executable` ×3 (the device-facing RPC pattern),
`rls_enabled_no_policy` ×1 (`project_order_counters`, deliberate deny-all),
`auth_leaked_password_protection` ×1.

Validation harnesses must create **temporary** tables and functions. The
migrations already do this (`create temporary table d4b_…`). A persistent
harness table is how a publicly readable, publicly writable table and an
auth-context-forging RPC ended up on staging.

---

## 9. Production migration checklist

Two migrations are committed and applied to **staging only**:

| Migration | Adds | Production |
|---|---|---|
| `20260823120000_device_voluntary_unpair.sql` | `paired_devices.unpaired_at`, `unpair_own_device()` | **not applied** |
| `20260823130000_device_sales_history.sql` | `get_device_recent_orders()`, `orders_project_recent_idx` | **not applied** |

- [ ] Confirm production lacks both RPCs before applying
- [ ] Apply **in timestamp order**, `…120000` before `…130000`
- [ ] Re-confirm production object counts after each
- [ ] Do **not** deploy the Sales History UI before `…130000` lands

---

## 10. Release ordering

1. Apply `20260823120000_device_voluntary_unpair.sql` to production; verify
   `unpair_own_device` exists and `paired_devices.unpaired_at` is present,
   nullable and unbackfilled.
2. Apply `20260823130000_device_sales_history.sql`; verify
   `get_device_recent_orders` and `orders_project_recent_idx`. **Timestamp
   order matters.** Re-run the production Sales History check now — it is only
   after this step that a pass means anything (§12b).
3. **Verify the production publish worker before deploying anything that asks
   owners to publish** (§10b). A queued job with no worker looks exactly like
   the 25.6 defect from the owner's side.
4. Deploy web.
5. Build, verify and publish the **Android RC 1.1.0 / versionCode 2**.
6. Build, verify and publish the **Windows RC 1.1.0** via the *Windows app*
   workflow. Confirm `runtime ok:` in the log and a real runtime in `app.asar`.
7. **Verify both artifacts** — SHA256, size, signer continuity (Android must
   stay `7e32ec72…5b1b`), production ref present, staging ref and
   `service_role` absent.
8. Update `CURRENT_ANDROID_RELEASE` / `CURRENT_WINDOWS_RELEASE` **last**, only
   once the binaries are downloadable and their checksums verified against the
   served files. This closes P0-2.

Step 8 is deliberately last: the download page reads version, size, URL and
checksum straight from those constants, so updating them before the artifacts
exist advertises a download that 404s.

### 10b. The production publish worker

**`windows-app.yml` is NOT the publish worker.** It packages the desktop
installer and never touches a build job.

Publishing runs through a different chain, and every link must be configured in
production or an owner's *Publish Configuration* queues forever:

| Link | What it is | Must be set |
|---|---|---|
| Editor | Publishes with `target: "android"` (`EditorShell.tsx`) — the only target the UI creates | — |
| `dispatchBuildWorkerWorkflow` | POS Canvas calls the GitHub API to dispatch `build-worker.yml` | **`GITHUB_BUILD_WORKER_TOKEN`** in the production web environment |
| `build-worker.yml` | Runs `worker/once.ts --target android`, five one-shot attempts | Repository secrets **`NEXT_PUBLIC_SUPABASE_URL`** and **`SUPABASE_SERVICE_ROLE_KEY`** |

Two failure modes to check for explicitly, because both are silent:

- **No `GITHUB_BUILD_WORKER_TOKEN` in production** → no dispatch, the job sits
  `queued`, and the owner sees the stepper stall. There is no schedule to catch
  it: Feature 17.2 removed the 15-minute poll, so a dispatch is the only thing
  that starts a worker.
- **The repository secrets point at the wrong project** → the worker processes
  the other database's queue and production publishes are never picked up. The
  same workflow serves whichever project those secrets name, so confirm they
  are **production** before the first production publish.

Stale-job recovery also rides on dispatch rather than a clock, so a job stuck
`building` is only reclaimed when a later publish dispatches a worker.

---

## 11. Artifact verification

For **every** artifact that leaves this machine:

- [ ] SHA256 recorded and published alongside the file
- [ ] Byte size recorded
- [ ] Android: `applicationId com.poscanvas.app`, label `POS Canvas`
- [ ] Android: signer SHA-256 == `7e32ec72c659dfacdab880d7fbe68991cf6104d11434f15d0c516bb9c6525b1b`
      — **a different signer means Android treats it as a different app, with no
      upgrade path and no way to carry a paired session across**
- [ ] Windows: `appId com.poscanvas.app`, `productName POS Canvas`
- [ ] Windows: unsigned — SmartScreen warning expected, documented for users
- [ ] Packaged bundle contains the **production** ref `pkwlpstqdqscegfkjnel`
- [ ] Packaged bundle contains **no** staging ref and **no** `service_role`
- [ ] Packaged runtime is present and non-empty. CI now builds it and asserts it
      before packaging (Feature 25.6 P0-1); the run log must show `runtime ok:`
- [ ] Published checksum in `lib/androidRelease.ts` / `lib/windowsRelease.ts`
      matches the actual uploaded file, byte for byte

---

## 12. Known accepted limitations / deferred items

Carried from the 25.6 audit. P0 must be closed before release; P1 should be
closed before wider launch; P2 is accepted for MVP.

### P0-1 — Windows CI runtime generation — CLOSED

`.github/workflows/windows-app.yml` installs the root project, runs
`npm run windows:runtime`, and **fails closed** if
`windows-shell/runtime/index.html` is missing or the bundle does not target the
configured Supabase URL — all before electron-builder runs.

**First real CI run: FAILED, before packaging — which is the pipeline working.**

| | |
|---|---|
| Failed at | *Build the packaged device runtime* |
| Error | `'POS_CANVAS_DEVICE_OUT_DIR' is not recognized as an internal or external command` |
| Root cause | `windows:runtime` used POSIX inline env assignment (`NAME=value command`). npm runs scripts through `cmd.exe` on Windows, which has no such syntax and tries to execute the assignment as a program. |
| Second defect found | `readOutDir()` in `native-device/vite.config.mts` compared with a hardcoded `/` separator, so the containment check rejected a directory plainly inside the repository on Windows. Would have failed the next run. |
| **Not the cause** | The two repository variables. `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` were configured correctly with the production client values, and the failure happened before either was read. **No GitHub configuration change is required.** |

Both defects were fixed (`695ae03`, `716244c`), the rerun passed, and the
artifact was verified independently of the log:

| | |
|---|---|
| Installer SHA256 | `ba16200203c00d47d941c008a4a867c2c870dd1e8671603c89bbea0bb1d201f5` |
| Installer size | 100,260,930 bytes — matches the `.sha256` CI produced |
| `app.asar` SHA256 | `309425f63349a56283f24db8ffee860c0e4ee0c36d30d103525f671aaec82404` |
| Runtime inside | `runtime/index.html` + one JS bundle + one CSS bundle |
| Refs | production present, staging absent, no `service_role` |
| Bundle bytes | **byte-identical** to a local build (`cmp` clean) |

Requires two repository variables: `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (see `windows-shell/README.md`) — already set.

**Still unproven, and not blocking:** installing the artifact on Windows and
reaching the pairing screen rather than the offline page. The bytes are right;
running it is a separate confirmation.

### P0-2 — stale published Windows v1.0.0 — CLOSED

`CURRENT_WINDOWS_RELEASE` advertises a binary built **2026-08-16**, which
predates the local-runtime architecture (`ab38942`, 2026-08-21). Its checksum
matches no artifact this repository can currently produce.

**The stale v1.0.0 Windows download must not remain the advertised current
Windows release after 1.1.0 is published.** Closing this is step 6 of the rollout
order (§10): update `lib/windowsRelease.ts` only once the 1.1.0 installer is
downloadable and its checksum verified against the served file.

### 1.1.0 published artifacts — verified from their SERVED URLs

Both releases were downloaded from their **public GitHub URLs** — the bytes
GitHub actually serves, not a local copy — and verified before either pointer
moved.

| | Android | Windows |
|---|---|---|
| Tag | `v1.1.0` | `windows-v1.1.0` |
| Asset | `POS-Canvas-v1.1.0.apk` | `POS-Canvas-Windows-v1.1.0.exe` (+ `.sha256`) |
| SHA256 | `00763a36d8ddcba676ec0f0afec477a2784579c0d9968b28eaaea91510af1df1` | `c8f1fa82c2e95bdaa06adc3360275c58b57dd8737b2a98f287990f0193b827fe` |
| Size | 4,121,584 bytes | 100,260,898 bytes |
| Published | `2026-08-31T18:03:31Z` | `2026-08-31T18:12:54Z` |
| Prerelease | false | **false** |
| Served download | HTTP 200, hash + size match | HTTP 200, hash + size match |

The Windows `.sha256` names the correct asset and `shasum -a 256 -c` returns
**OK** against the served installer. The served APK was additionally re-read as
an APK: `com.poscanvas.app`, `versionCode 2`, `versionName 1.1.0`, signer
`7e32ec72…5b1b` — signer continuity intact, so it installs over 1.0.0.

**P0-2 is CLOSED.** `CURRENT_WINDOWS_RELEASE` advertises 1.1.0, the web deploy
shipped it, and the final production smoke passed. The 2026-08-16 binary is no
longer offered anywhere.

### Signing status is now independent of pre-release status

Publishing `windows-v1.1.0` as a full release exposed a coupling: one flag,
`isPrerelease`, carried two facts, and one badge said both — *"Pre-release ·
Unsigned build"*. Setting `isPrerelease: false` was correct (GitHub says
`prerelease=false`) and it removed the only warning that the installer is
unsigned. The installer had not changed.

`PlatformRelease` now carries **`isUnsigned?: boolean`** alongside
`isPrerelease?: boolean`. Both are optional and absent means the benign default,
so Android — signed, stable — declares neither and is unaffected. Windows 1.1.0
declares `isUnsigned: true`.

| Release | isPrerelease | isUnsigned | Badges shown |
|---|---|---|---|
| Android 1.1.0 | absent | absent | none |
| Windows 1.0.0 (historical) | true | true | Pre-release + Unsigned |
| **Windows 1.1.0 (current)** | **false** | **true** | **Unsigned only** |
| A future signed pre-release | true | false | Pre-release only |

Labels: `PRERELEASE_BADGE_LABEL` is now just `"Pre-release"`;
`UNSIGNED_BADGE_LABEL` is `"Unsigned · Windows may show a SmartScreen warning"` —
it names the consequence a user will actually meet.

Six regression guards replace the temporary KNOWN GAP assertion, including one
that fails if either flag's value is ever derived from the other, and one
asserting the release declares itself unsigned for as long as `windows-shell`
carries no signing configuration. **Code signing remains deferred, not
cancelled** — when it lands, `isUnsigned` comes out in the same change that
publishes the signed artifact.

### P0-3 — publish reported success for a stale snapshot — CLOSED

Found in 25.6 manual regression. An owner added a product, saved, pressed
Publish, and watched the stepper reach **Published** — for a build created 22
hours earlier whose snapshot did not contain the change. The paired till kept
showing the old menu and was right to.

`build_jobs_active_target_unique` permits one queued/building job per
(project, target), and `requestBuildJob` resolved that collision by returning
the existing job. Correct for a double-click, wrong for a second publish: the
snapshot is taken when a job is **created**, so "an active job exists" and
"this configuration is already publishing" are different facts and nothing
compared them.

Fixed by `decideExistingBuildJob`: a request-key match still reuses immediately,
an active job is settled against the submitted config hash, and a differing hash
is refused with a conflict. The stale job is left running, unmodified.

**Manually verified on staging:**

| | |
|---|---|
| Case A — conflict | Queued job `f77c4f37`, hash `9fd2a406c654`, 14-item snapshot. Saved a second change (15 items), pressed Publish → conflict message shown, **no** stepper advance, **no** Published. Active jobs stayed 1, total stayed 7, job id and hash unchanged, snapshot still 14 items. **No second active job; the stale snapshot was not rewritten.** |
| Case B — recovery | First job completed; the latest configuration then created its own new job, whose snapshot contained the later change; publish completed normally. |
| Case C — idempotency | Same-config publish reused the existing job with no conflict; rapid duplicate publish created no duplicate active jobs. |

No schema change was required — `config_hash` was already stored and indexed.

| # | Item | Class |
|---|---|---|
| 1 | Windows CI never builds `windows-shell/runtime` → installer with no POS | **P0 — CLOSED.** CI green; artifact verified to contain a real runtime |
| 2 | Published Windows v1.0.0 predates the local-runtime architecture | **P0 — CLOSED.** Pointers moved to 1.1.0 and deployed |
| 2b | Publish reported success for a stale snapshot | **P0 — CLOSED.** Manually verified on staging |
| 2c | A paired till does not receive a newly published config without re-pairing (Cause 2) | **P1 — OPEN.** Documented, intentional pin; not a silent failure |
| 3 | Windows installer unsigned (SmartScreen) — now **labelled** on every surface, but still unsigned | P1 |
| 4 | Stalled `queued` publish polls while the editor is open | P1 |
| 5 | Historical receipt currency symbol comes from current pinned config | P1 |
| 6 | Android native printing unavailable | P2 (documented) |
| 7 | No `@page` receipt control; tall receipts may split on Letter/A4 | P2 |
| 8 | No DOM test harness; React verified structurally | P2 |
| 9 | Clock-skew tolerance on `occurred_at` vs `revoked_at` | P2 |
| 10 | `android-shell/serverUrl.mjs` near-dead | P2 |
| 11 | `windows-shell/serverUrl.mjs` still imported by `main.mjs` | P2 |
| 12 | `supabase/config.toml` scaffold hazard | P2 (documented, §8) |
| 13 | Windows staging QA builds share `userData` with production | P2 (QA only) |
| 14 | `windows-shell` `start:production` still uses POSIX inline env (`POS_CANVAS_DESKTOP_RELEASE=1 electron .`) — breaks for a Windows developer; not in any release path | P2 |

---

## 12b. Feature 25.6 final manual regression — PASSED 2026-08-27

Run against the committed tree at `caa905d`.

| Area | Result |
|---|---|
| Windows production artifact installs and opens | PASS |
| Close / reopen | PASS |
| Production pairing | PASS |
| Cash sale | PASS |
| Card sale | PASS |
| Sales History (**staging**) | PASS |
| Historical receipt / detail | PASS |
| Historical reprint | PASS |
| Offline OFF sale | PASS |
| Reconnect OFF → ORD reconciliation | PASS |
| Voluntary unpair | PASS |
| Re-pair | PASS |
| Publish-conflict P0 (Cases A/B/C) | PASS |

**Sales History on PRODUCTION was NOT exercised and is NOT claimed to pass.**
The production Windows check showed *Try Again*, because production still
intentionally lacks `20260823130000_device_sales_history.sql`. That is an
expected schema mismatch at this stage, not a client regression — and it is
exactly the failure mode §9 predicts if the UI reaches production before its
migration. It becomes a real pass only after step 2 of the rollout order, when
the migration is applied and the check is repeated against production.

**Feature 25.6 is complete except for the publication-only gate P0-2.** No code
change remains; what is left is applying migrations, cutting 1.1.0 artifacts and
publishing them.

---

## 13. Rollback notes

- **Migrations are additive.** `unpaired_at` is nullable with no backfill and no
  default; `get_device_recent_orders` is a new function. Neither drops or
  rewrites data, so rolling *forward* is always preferable to rolling back.
- **Web** rolls back by redeploying the previous Vercel deployment.
- **Android cannot be rolled back in place.** `versionCode` must strictly
  increase, so a bad release is fixed by shipping a *higher* code, never by
  re-publishing a lower one.
- **Windows** rolls back by re-publishing the previous installer and reverting
  `CURRENT_WINDOWS_RELEASE`. Because `deleteAppDataOnUninstall: false`, a
  reinstall preserves the pairing, the pinned config and any queued sales.
- **Never change the Android signing key or the `app://poscanvas` origin.**
  Storage is origin-scoped: changing either strands every till's pairing,
  cached config and queued sales.
- The device `userData` name `POS Canvas` is permanent for the same reason.

---

## 14. Final smoke test

After everything is published, on real hardware, in this order:

1. Install the published Android RC over an existing 1.0.0 install — the pairing survives
2. Pair a fresh device — POS opens
3. One Cash sale — totals correct, order number allocated
4. Airplane mode → one offline sale → **OFF-** receipt → reconnect → drains to **ORD-**
5. Sales history → open an older order → stored prices shown
6. Windows: reprint that order — exactly one receipt on paper
7. Device settings → voluntary unpair → re-pair
8. Owner dashboard: the old device reads **Unpaired**, the new one **Active**
9. Download page shows the new version, and the checksum matches the file served

If any step fails, **stop and roll back the download metadata first** — that is
the only step users see immediately.
