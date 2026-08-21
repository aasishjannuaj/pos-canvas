# Offline architecture — design (Feature 24.4)

## Implementation status

| Phase | Contents | Status |
|---|---|---|
| **24.5A** | IndexedDB foundation, cached pairing assertion, cached immutable config, integrity validation, 7-day lease, read-only offline startup, **offline checkout disabled** | **IMPLEMENTED** |
| **24.5B** | Server contract — `occurred_at`, `source`, offline stock policy, revocation window, `complete_sale_v4` | **IMPLEMENTED** |
| **24.5C** | Durable sale queue + persisted idempotency key, IndexedDB v2 | **IMPLEMENTED** |
| **24.5D** | Sync engine — FIFO drain, single-flight, persisted backoff | **IMPLEMENTED** |
| **24.5E** | Offline checkout, provisional receipts, startup/reconnect sync wiring, reconciliation, unpair block, cashier status | **IMPLEMENTED** (owner Devices UI deferred) |
| **24.5F** | Cross-platform failure/torture QA; DEF-01 mid-session offline fallback; DEF-02 scheduled backoff retry | **IN PROGRESS** — code fixes landed, hardware QA not started |

**A paired till with a valid cache can now complete a sale offline.** 24.5E
opened the fence 24.5A put up. What changed is narrow and stated exactly in
§24.5E below: the sale is validated locally, written to the durable queue, and
handed to the customer as a provisional receipt. Nothing about pricing authority
moved — the server still prices every sale from the pinned build snapshot when
it syncs, and the client still sends no amount.

**Online checkout is unchanged.** An online device sale still goes to
`complete_sale_v3` and still returns the server's authoritative receipt.
`complete_sale_v4` remains reachable from exactly one adapter,
`lib/offlineSaleRpc.ts`, called only by the sync engine — never from checkout.

**Still deferred to a later phase:** the owner-facing per-device sync panel
(§17), any remediation console for `needs_attention`, and an explicit "discard N
unsynced sales" confirmation. See §24.5E's *What 24.5E deliberately did not do*.

### What 24.5E actually shipped

| Concern | Module |
|---|---|
| Eligibility, sale identity, enqueue payload (pure) | `lib/offlineCheckout.ts` |
| Storage glue: validate, persist, reconstruct, count | `lib/offlineCheckoutSession.ts` |
| Provisional receipt + reconciliation model (pure) | `lib/provisionalReceipt.ts` |
| Cashier counts + reset safety (pure) | `lib/offlineSaleStatus.ts` |
| The printed/on-screen offline receipt | `components/runtime/OfflineReceipt.tsx` |
| Cashier status strip + "Sync now" | `components/device/DeviceSyncStatus.tsx` |
| Checkout branch, receipt display, print | `components/runtime/PosRuntime.tsx` |
| Wiring: eligibility, sale handler, sync lifecycle, reset block | `components/device/DeviceApp.tsx` |

#### Offline checkout eligibility

Offline checkout is permitted only on an **explicit positive answer**. An
undecided device is not an eligible one: while the check is still running the
till shows `OFFLINE_CHECKOUT_PREPARING_MESSAGE` and cannot complete a sale.

`decideOfflineCheckoutSession` (pure) requires **all** of:

1. the runtime is in offline mode — `getDeviceRuntimeMode(state) === "offline"`,
   which is set by the cold-start branch that actually opened the POS and is
   never inferred from `navigator.onLine`;
2. no locally known revocation (`pairing.revokedAt === null`);
3. a cached pairing assertion that parses and belongs to **this** anonymous auth
   user;
4. a valid 7-day lease, evaluated against the current clock, refusing a
   `lastVerifiedAt` in the future;
5. a cached pinned configuration that parses under the same validator a fresh
   server response must clear;
6. its SHA-256 integrity digest **recomputed** and matching;
7. the cached project / build / auth-user identity matching, **and** the cached
   device / project / build matching the pairing the app is actually running;
8. the durable IndexedDB queue openable and listable.

Checks 3–6 are `decideOfflineFallback`, reused unchanged: **the bar for selling
from a cache is never lower than the bar for opening from one**, and sharing the
function is the only way to guarantee that. Check 7's second half is the one
thing a cached *start* cannot do, because at start there is no running pairing
to compare against.

`decideOfflineSaleEligibility` then checks the sale itself: the lease **again**
(a till can sit open past midnight on the seventh day), a non-empty cart, and a
payment method of `cash` or `card`.

Every failure produces one of `OFFLINE_CHECKOUT_BLOCKED_MESSAGES`, so no refusal
can reach an operator unexplained. **There is no silent fallback to an in-memory
sale anywhere on this path.**

**Local stock is deliberately not a condition.** An offline sale is never
refused because the cached snapshot looks short — §9's approved rule. The server
floors tracked stock at zero and records the shortfall at sync.

#### The durable-success-before-UI-success rule

```
cashier confirms
  → re-validate the offline session FROM DISK   (integrity recomputed, lease re-checked)
  → check this sale                             (cart, payment method, lease)
  → mint ONE saleRequestId + ONE occurredAt     (frozen in a draft)
  → await enqueueSale                           (an IndexedDB transaction)
  → ONLY THEN: clear cart, show success, show receipt
```

`PosRuntime.completeSale` awaits the host's `queueOfflineSale` and returns early
on failure — the cart survives, no success is displayed, and no receipt is
produced. `lib/offlineCheckout.guards.test.ts` asserts this ordering
structurally, and the guard was verified to fail when the clear is moved ahead
of the check.

**A failed write is loud and blocking** (§18 case 15): the operator is told the
sale did not complete and that the items are still in the cart, *before* they
hand anything over.

**A duplicate is a success only when it is the SAME sale.** The unique index on
`saleRequestId` refuses a second record claiming one sale. Usually that means a
previous attempt committed and its answer was lost, and returning the stored
record is the truthful answer — reporting failure there is how one sale becomes
two.

But "something already holds this id" and "this sale is already saved" are
different statements, and only the second justifies telling a cashier the sale
is done. `isEquivalentOfflineSale` therefore compares the stored record against
the attempted one field by field before that claim is made:
`saleRequestId`, `queueRecordId`, `deviceAuthUserId`, `deviceId`, `projectId`,
`buildJobId`, `paymentMethod`, `tipAmount`, `source`, `occurredAt`, and the
items **canonically** — option ids sorted within a group, groups within a line,
lines within the order, matching the shape the server hashes.

A non-equivalent record is a **hard local conflict**: `conflicting_local_record`,
a distinct operator message asking for the till to be checked, the cart left
intact, no receipt, and both records left on disk. Retrying cannot resolve it —
the same key would collide again — and `complete_sale_v4` would reject whichever
request reached it second as a hash conflict.

#### `sale_request_id` and `occurred_at`

Both are minted **once**, together, in `resolveOfflineSaleDraft`, before
anything is written, and neither ever changes. `occurredAt` is taken from the
clock reading captured when the handler was entered — the moment the cashier
confirmed — not when validation finished and not when the transaction committed.

A retry of the **same cart within the same attempt** resolves to the same draft,
because the draft is keyed on `createSaleFingerprint` — the same fingerprint the
online path uses, covering `projectId | paymentMethod | tipAmount |
sorted(lineKey=quantity)`, which is exactly what `complete_sale_v4` hashes. A
changed payment method, quantity, item or modifier selection is a materially
different request and mints a new identity; a cosmetic reordering does not.

**The draft is scoped to ONE checkout attempt, in both directions.** This is the
distinction that matters, and it needs two rules, not one:

| Event | Draft |
|---|---|
| enqueue fails | **kept** — a retry must be one sale, not two |
| enqueue succeeds durably | **consumed** — the next sale mints its own |
| checkout closes (cancelled, or done) | **discarded** — the attempt is over |

Without the third rule, a cashier who failed to save a sale, cancelled, and
later rang up a cart that happened to hash identically would inherit the
abandoned sale's identity — recording a new customer's money at an old
customer's `occurred_at`. The runtime knows when an attempt ends and the host
does not, so `PosRuntime.closeCheckout` calls the host's
`discardOfflineSaleDraft`. **A cart fingerprint identifies a retry candidate; it
is never a permanent identity for every future identical sale.**

A separate `queueRecordId` is minted alongside, so this device's local handle on
a row stays distinct from the server's identity for the sale.

#### Provisional receipt

Owner-approved wording (§8, §22 decision 6), reproduced exactly in
`lib/provisionalReceipt.ts` and imported by the component rather than retyped:

```
OFFLINE RECEIPT
Ref: OFF-7Q4K-2XN9

... business name, items, modifiers, quantities, subtotal, tax, total,
    payment method, sale time ...

This sale is saved on this device
and will sync when internet is restored.
A final receipt number will be created after sync.
```

`ProvisionalReceipt` carries **no server field at all** — not even a nullable
`orderNumber`, because a nullable server field is the shape that eventually gets
filled in with something invented. The server identity lives only in
`SaleReconciliation`.

**Printing reuses the existing mechanism.** The same `.receipt-print-area`
region and the same Print Receipt button; no second printing stack. The printed
document carries the banner and no order number.

#### Offline reference

`toOfflineReference(saleRequestId)` folds the whole request id to 40 bits and
renders eight Crockford Base32 characters as `OFF-XXXX-XXXX`.

- **Derived, not generated** — a pure function of a value already persisted, so
  there is no second identifier to keep in step and nothing extra to store.
- **Stable across restart** by construction: same id in, same reference out.
- **Visibly not an order number.** `OFF-` prefixed, and not the
  prefix-plus-digits shape a real one has.
- **Folded rather than truncated**, so it does not assume where the entropy in
  an id happens to sit.
- Not a security token: a short digest of a random id, used to look a sale up on
  the device that already holds it. Nothing keys on it.

#### Receipt arithmetic — the concrete audit

For a line of **quantity 2** of a 6.49 item with **+1.50** and **+0.75**
modifiers, under the config's **6.35%** added tax:

| Displayed | Value |
|---|---|
| unit price | `8.74` = 6.49 + 1.50 + 0.75 |
| line total | `17.48` = 8.74 × 2 |
| subtotal | `17.48` |
| tax | `1.11` |
| total | `18.59` |

The `+1.50` / `+0.75` rows rendered under the line are a **per-unit breakdown**,
not addends — the line total above them already contains them, exactly as
`AuthoritativeReceipt` renders the server's own snapshot. Tests pin that the
subtotal equals the line total alone (not 19.73, and not 21.98), that the line
total equals unit × quantity, and that every figure equals what
`calculateCartSummary` returns for the same cart — the check that would catch the
receipt ever growing its own arithmetic.

#### Pricing and tax source

Provisional totals come from the **cached pinned `GeneratedPosConfig`**, through
the existing POS arithmetic — `createCartItem` for a line's unit price,
`buildModifierSnapshot` for the modifier names and adjustments, and
`calculateCartSummary` for subtotal, tax and total. There is no second pricing
implementation, and nothing in `lib/provisionalReceipt.ts` computes tax itself.

**The server remains the pricing authority.** `complete_sale_v4` prices from the
same immutable build snapshot at sync, and the client still sends no amount
(§7). The displayed totals are what the customer was shown, not an input.

#### Restart / reconstruction

The receipt is built from **(durable record + pinned config)** — never from the
cart, and never from React state. That pair is exactly what a restarted app has,
so `reconstructProvisionalReceipt` produces a byte-identical receipt after a
process kill, carrying the same reference and the same `occurredAt`.

The cart is never written to storage, so a completed queued sale can never
resurrect as a cart on the next launch.

#### Startup sync wiring

`triggerStartupSaleSyncOnce()` is called from **exactly one place**: an effect in
`DeviceApp`, gated on the anonymous session existing. It is gated on the session
rather than on mount because the drain submits under the device's own paired
session — starting it earlier would turn a queue of good sales into a queue of
authentication failures.

The latch lives at **module scope in the engine**, not in the component: React
can mount a component twice (StrictMode, an error boundary, a route change), and
a second "startup" would un-claim a submission still on the wire.

It is **keyed on the device auth session, not a bare boolean** — "once per
logical device session", not "once per JS process". A process can outlive a
pairing: unpair and re-pair happen without a reload, and the new pairing is a
new anonymous auth user with its own queue lifetime. Under a process-wide
boolean that second session would silently never receive its startup pass. The
effect keys on the same value, so every rerender, remount and StrictMode
double-invoke within one session presents an identical key and collapses to one
run, while a genuinely new session correctly gets its own.

Startup is the only trigger that runs `recoverInterruptedSyncs`; a reconnect or
a manual press drains without reclaiming.

#### Reconnect wiring

One `subscribeToReconnect` call, in one effect, whose teardown is the returned
unsubscribe. Repeated `online` events are absorbed by the engine's single-flight
— five events produce one drain and one shared report.

The `online` event is a **hint**. Nothing about correctness rests on it: offline
checkout is gated on the validated cache and the lease, never on
`navigator.onLine`, and every submission still has to succeed on its own.

#### Reconciliation

On success `markSynced` writes the state change and the server identity
together, so a record can never be `synced` without the order number that proves
it. `reconcileQueuedSale` then exposes:

| Provisional | Final, after sync |
|---|---|
| `offlineReference` | `serverOrderId` |
| `occurredAt` | `serverOrderNumber` |
| provisional totals | `serverCreatedAt` |
| `state: pending` | `state: synced` |

`describeSyncedAs` renders **"Synced as ORD1042"**, and returns `null` when
there is nothing truthful to say.

- **`occurred_at` is never overwritten with the server's `created_at`.** Both
  are kept side by side (§6.1): one answers "when did the customer pay", the
  other "when did this enter the books".
- **`synced` is derived from the STATE**, not from the presence of an order
  number, so a `needs_attention` sale can never present itself as recorded.
- **A synced record is not deleted.** The reference-to-order mapping has to
  exist somewhere for the operator holding a paper slip.

#### Unpair / reset block

`handleReset` reads the queue and calls `decideDeviceResetSafety` **before**
anything is cleared or signed out, and returns on refusal — a reset that got
halfway would be the same data loss it exists to prevent. The refusal names the
count, per §15.

Blocked by: `pending`, `syncing`, `needs_attention`, `permanent_failure`, and
any record that no longer parses. **Not** blocked by synced records alone: those
are a copy rather than the only copy, and they carry their reconciliation data.

The storage layer backs this independently: `clearOfflineCache` clears the
config store only, and there is no bulk delete of the sale queue anywhere in the
repository. The one delete that exists refuses any record that is not `synced`.

#### `needs_attention` — cashier status

`DeviceSyncStatus` renders at most two lines, and nothing at all when the queue
is empty:

```
3 sales waiting to sync     ·     1 sale needs attention     [Sync now]
```

Counts, never percentages. No database vocabulary — no "queue", "record",
"state" or error code reaches an operator. A record that failed to parse counts
as needing attention rather than disappearing. "Sync now" is offered only while
the device believes it is online; during an outage it is hidden, because a
button that visibly does nothing teaches operators to distrust the UI.

#### What 24.5E deliberately did not do

- **No database change.** No migration was added or edited; the 17 existing
  migrations are untouched.
- **No owner-facing UI.** The per-device sync column in the owner's Devices
  panel (§17, decision 7) is not built.
- **No remediation console.** A `needs_attention` sale is surfaced as a count,
  not as a per-sale screen with retry.
- **No "discard N unsynced sales" path.** Reset only ever refuses.
- **No change to online checkout**, to `complete_sale_v3`, or to the online
  `sale_request_id` semantics.

---

### What 24.5D actually shipped

| Concern | Module |
|---|---|
| Error classification + backoff | `lib/saleSyncClassifier.ts` (pure) |
| The **only** `complete_sale_v4` call | `lib/offlineSaleRpc.ts` |
| Drain loop, single-flight, hooks | `lib/saleSyncEngine.ts` |

**Sync lifecycle.** `recoverInterruptedSyncs` → list due (FIFO) → for each:
`pending → syncing` → submit → `synced` | `pending` (backoff) |
`needs_attention`. The state moves to `syncing` and the attempt is counted
*before* the request leaves, so a process death mid-flight is recoverable by the
same rule that recovered it at startup.

**FIFO and one at a time.** Sales are submitted strictly oldest-first and
strictly sequentially — a burst of concurrent financial writes buys nothing on a
till with a handful of sales and makes failure attribution much harder. **The
loop never breaks early**: a sale that needs attention must not strand the sales
behind it.

**Single-flight, scoped to an engine.** `createSaleSyncEngine()` holds its own
in-flight promise; a second `run` on the SAME engine awaits the first and
receives the same report, so "sync now" pressed five times is one pass. A shared
singleton backs the module-level helpers, because there is one IndexedDB queue
per origin.

Two independent engines do not block each other, and cannot double-submit
either: claiming a record is a `pending → syncing` transition read from storage,
so whichever engine arrives second finds the transition illegal and skips. The
queue is the arbiter; single-flight stops them competing in the first place.

**Recovery runs on the STARTUP trigger only, never inside a drain.** Reclaiming
a `syncing` record cannot distinguish "a dead process left this behind" from
"another engine is submitting it right now", so doing it per-drain would
un-claim work still on the wire. Startup is the one moment where that ambiguity
does not exist. A reconnect or a manual press drains without reclaiming.

**Backoff.** `5s → 15s → 45s → 2m15s → 6m45s`, capped at **15 minutes**
(base 5s, ×3, max 15m). `nextAttemptAt` is persisted, so a restart resumes the
schedule rather than resetting it, and a record still inside its window is
skipped without losing its place. **No jitter** — deterministic tests matter more
here than a thundering herd that one till cannot form. After
**10 attempts** a record stops retrying and asks for a person.

**Error classification.** Transport first: if nothing answered, message text is
meaningless. Only a demonstrated server reply is treated as evidence.

| Condition | Outcome |
|---|---|
| Transport failure — nothing answered | **retry** (→ `needs_attention` at the cap) |
| Unknown outcome — lost response, timeout | **retry** (→ `needs_attention` at the cap) |
| Known server message (24 catalogued) | **needs_attention**, with a stable code |
| Server answered, message not catalogued | **needs_attention** *immediately* |
| Locally unreadable record | **permanent_failure** |

The last two rows are the distinction worth being precise about. An **unknown
outcome** means we cannot tell whether the request landed, so retrying is right
and free. An **uncatalogued server rejection** means PostgreSQL definitely
answered and its answer is deterministic — resubmitting the identical request
would produce the identical rejection, so it stops at once and waits for a
person.

**No server answer maps to `permanent_failure`.** "Retry and review cannot help"
is a claim the server never actually makes — even a hash conflict is resolvable
by someone confirming the original order exists. `permanent_failure` is reserved
for a record that no longer parses: there is no request to make, and no review
turns unreadable bytes back into a sale. It is still never deleted.

**Unknown retries here, and fails closed in 24.5A** — deliberately opposite
defaults. There, an unknown asked "may this device open a cached POS?" and
guessing yes would let a revoked till trade. Here it asks "did that submission
land?", and retrying is free because of the durable idempotency key. The
expensive mistake is the other one: abandoning a sale that was never recorded.

**Lost-response recovery.** The persisted `saleRequestId` is passed straight
through on every retry. `complete_sale_v4` resolves it before allocating an
order number, mutating inventory or writing an audit row, so a retry after a
lost response returns the order already created. Tested end to end: two
submissions, one server order, queue ends `synced`.

**Success.** `serverOrderId`, `serverOrderNumber` and `serverCreatedAt` are
written in the same operation as the `synced` transition, so a record can never
be synced without the order number that proves it. Records are **kept** after
sync — 24.5E reconciles a provisional receipt against the real order number.

**Known limitation — message-text errors.** `complete_sale_v4` raises business
errors as message strings rather than stable SQLSTATEs, so
`KNOWN_SERVER_ERRORS` matches 24 messages **by equality**, never by substring.
Several v4 messages interpolate a `%` placeholder and cannot be matched at all;
those fall through to `needs_attention`, which is the safe direction. A stable
server error-code contract would replace that table entirely and is the right
fix when one exists.

**Nothing ran it yet — as of 24.5D.** No caller invoked `runSaleSync`, nothing
called `enqueueSale`, and offline checkout was still fenced. The startup /
reconnect / manual hooks were exported for 24.5E to attach.

> **Superseded by 24.5E**, which attached them: one latched startup trigger and
> one reconnect subscription in `DeviceApp`, and one enqueue caller in
> `lib/offlineCheckoutSession.ts`. Online checkout still calls
> `complete_sale_v3`, and `complete_sale_v4` is still reachable only from
> `lib/offlineSaleRpc.ts`.

### What 24.5C actually shipped

| Concern | Module |
|---|---|
| Record shape, state machine, validation, recovery rule | `lib/saleQueue.ts` (pure) |
| Queue API — enqueue, read, transition, recover, summarize | `lib/saleQueueSession.ts` |
| IndexedDB **v2** and the `sale-queue` store | `lib/deviceOfflineStore.ts` |

**IndexedDB version 2.** The upgrade is purely additive: `device-cache` is not
dropped, recreated or migrated, so a till already running 24.5A keeps its pinned
config and pairing assertion. The new `sale-queue` store is keyed by
`queueRecordId`, with three indexes — `saleRequestId` (**unique**), `state`, and
`queuedAt`.

The unique index is the load-bearing one: **two records can never claim the same
sale**, and that is enforced by the storage engine rather than by a
read-then-write in application code that a crash could interleave.

**Queue record.** Everything `complete_sale_v4` needs and nothing else:
identity (`deviceAuthUserId`, `deviceId`, `projectId`, `buildJobId`), the request
(`paymentMethod`, `tipAmount` fixed at 0, `items`, `occurredAt`,
`source: "offline_queued"`), and sync state (`state`, `queuedAt`, `updatedAt`,
`attemptCount`, `lastAttemptAt`, `nextAttemptAt`, `lastErrorCode`,
`lastErrorMessage`). Two envelope versions are carried: `queueSchemaVersion` for
the storage shape and `requestPayloadVersion` for the server contract.

**No prices are stored.** Not unit price, not line total, not order total.
`complete_sale_v4` prices from the pinned build snapshot and ignores anything a
client sends, so a stored amount would look authoritative, never be used, and
eventually be believed. 24.5E's provisional receipt recomputes from the cached
pinned config — the same single source of truth the server uses.

**Transition table** (`QUEUE_TRANSITIONS`):

| From | To |
|---|---|
| `pending` | `syncing` |
| `syncing` | `pending`, `synced`, `needs_attention`, `permanent_failure` |
| `needs_attention` | `pending`, `permanent_failure` |
| `synced` | — terminal |
| `permanent_failure` | — terminal |

`synced → pending` is refused: the server owns that sale, and re-queueing it
would invite a second submission of money already recorded. A transition to the
*same* state is refused too, so a caller that believes it is advancing the
machine always learns when it is not.

**Interrupted-sync recovery.** On initialization, any record stranded in
`syncing` returns to `pending`, preserving attempt metadata. Safe because of
server-side idempotency, not optimism: the interrupted submission carried that
record's `saleRequestId`, and `complete_sale_v4` resolves that key *before*
allocating an order number, mutating inventory or writing an audit row. Retrying
therefore either creates the sale or returns the one already created. Attempt
history is kept deliberately — erasing it would let a record that keeps dying
mid-sync retry forever without reaching a cap.

**Corrupt records are quarantined, never dropped.** A row that fails validation
is reported by `listQueuedSales` as `quarantined` and left on disk. It is money
someone took; the honest response is "there is a row here I cannot understand",
which 24.5D turns into a `needs_attention` item.

**Nothing submitted — as of 24.5C.** No client called `enqueueSale` and offline
checkout was still fenced in `PosRuntime.completeSale`. 24.5C built the durable
floor; 24.5D stood on it.

> **Superseded by 24.5E**, which fills the queue from a real checkout. The
> record shape, the state machine and the quarantine rule are unchanged.

### What 24.5A actually shipped

| Concern | Module |
|---|---|
| Rules — canonicalization, SHA-256 integrity, identity binding, lease | `lib/deviceOfflineCache.ts` (pure) |
| The only IndexedDB in the repository | `lib/deviceOfflineStore.ts` |
| Glue between the two | `lib/deviceOfflineSession.ts` |
| Transport-failure vs server-rejection | `lib/deviceConnectivity.ts` (pure) |
| Cold-start fallback decision | `decideOfflineFallback` in `lib/deviceSession.ts` (pure) |
| Operator banner | `components/device/DeviceOfflineBanner.tsx` |

### What 24.5B shipped

`supabase/migrations/20260819120000_offline_sale_contract_and_complete_sale_v4.sql`
— additive only, wrapped in an explicit transaction, with `complete_sale_v3`
left byte-for-byte untouched and still callable.

| Change | Detail |
|---|---|
| `orders.occurred_at timestamptz NOT NULL` | backfilled from `created_at`; `created_at` itself unchanged |
| `orders.source text NOT NULL DEFAULT 'online'` | checked against `('online','offline_queued')`; historical rows backfill to `online` |
| `orders.has_inventory_shortfall boolean` | order-level flag, partial index for reconciliation |
| `order_items.inventory_shortfall integer` | per line, `0 <= shortfall <= quantity` |
| `complete_sale_v4(...)` | v3's body plus `p_occurred_at` and `p_source`, both defaulted |

**Exact `occurred_at` semantics.** Validated only for a NEW sale; a replay
returns before the parameter is read, and `occurred_at` is deliberately **not**
part of the canonical hash so a retry whose clock drifted is still the same sale.

| Case | Server behaviour |
|---|---|
| `source = 'online'` with a non-null `p_occurred_at` | **reject** — `An online sale cannot declare its own sale time` |
| `source = 'online'` | `occurred_at := now()` |
| `source = 'offline_queued'` with null `p_occurred_at` | **reject** — `An offline sale must declare when it happened` |
| later than `now() + 5 minutes` | **reject** — `Offline sale time is in the future` |
| earlier than `paired_devices.created_at - 5 minutes` | **reject** — `Offline sale time predates this device` |
| earlier than `now() - 7 days - 5 minutes` | **reject** — `Offline sale time is older than the offline limit` |
| otherwise | `occurred_at := p_occurred_at` |

In one line, a new offline sale must satisfy all three:

```
occurred_at >= paired_devices.created_at - 5 minutes
occurred_at >= now() - 7 days - 5 minutes
occurred_at <= now() + 5 minutes
```

**The 7-day server bound is the same number as the client lease.**
`c_offline_max_age` in the migration and `OFFLINE_DEVICE_LEASE_MS` in
`lib/deviceOfflineCache.ts` are both seven days, and a test pins them together.
The client refuses to *open* offline past the lease; without the same bound on
the server, a device could still *submit* a sale claiming to be from outside it,
and the two halves of one owner-approved policy would disagree.

**Why the pairing floor alone was not enough** (found in review of the first
24.5B draft, and fixed): a till paired months ago satisfies
`occurred_at >= paired_at` for *any* date since. Without an age ceiling, a
submission created today could be backdated months — and slid in front of a
`revoked_at` set last week. Because the revocation window below compares against
`occurred_at`, an unbounded past was an unbounded bypass of revocation. With the
7-day ceiling, anything old enough to precede a revocation older than a week is
already refused, so backdating cannot reach it.

The 5-minute skew allowance matches `OFFLINE_CLOCK_TOLERANCE_MS` in
`lib/deviceOfflineCache.ts`, so client and server agree on "close enough". The
pairing floor uses `paired_devices.created_at`, a **server** timestamp the
device cannot move.

**Nothing is clamped.** An excessively old timestamp is rejected, never quietly
moved to the boundary — clamping would write a sale time nobody reported into
the books to make a validation pass. The sale stays in the device queue.

**All of this applies to a NEW sale only.** The idempotency lookup returns
before any temporal check runs, so an already-committed sale replays
successfully even when it is now older than seven days, the device has since
been revoked, or the clock has moved far beyond the original sale. A replay
allocates no order number, mutates no inventory and writes no audit row.

**A change from §6.1, recorded rather than buried.** 24.4 proposed storing a
null `occurred_at` and flagging the order when the clock could not be validated.
24.5B **rejects the call instead**, per the owner's later direction not to write
unverifiable financial history. The sale is not lost: a rejection leaves it in
the device queue for 24.5D to surface as `needs_attention`. `occurred_at` is
therefore `NOT NULL`. **24.5C/D must not discard a queued sale on these errors.**

**Exact revocation semantics.** `complete_sale_v4` does **not** call
`resolve_sale_owner` for a device, because that function filters
`revoked_at is null` and would refuse a revoked device before the idempotency
lookup could run. v4 resolves the pairing row itself, without that filter, and
decides per case:

| Case | Behaviour |
|---|---|
| no pairing row for this project | **reject** — `Project not found or access denied` (unchanged, non-probing) |
| replay of an existing order, device now revoked | **succeeds** — allocates nothing, mutates nothing |
| new sale, revoked, `source = 'online'` | **reject** |
| new sale, revoked, `occurred_at < revoked_at` | **recorded** |
| new sale, revoked, `occurred_at >= revoked_at` | **reject** — `Offline sale occurred after this device was revoked` |

**Inventory.** Online is unchanged and still hard-rejects. An offline queued
sale floors tracked stock at 0 and records the shortfall per line — the money is
real and the record must survive. The `inventory_transactions` audit row records
`stock_before - stock_after`, the **actual** decrement, because that table
carries its own `quantity_after = quantity_before + quantity_change` check that
the requested quantity would violate once stock can floor.

The safety property that matters most: **a server that ANSWERED is never
overridden by cache.** `permitsOfflineFallback` admits only a classified
`transport` failure, so a revoked or unpaired device — which is a server answer
— can never fall back to a cached POS, and a confirmed revocation clears the
cache outright.

Scope: the two universal shells — Android (Capacitor WebView) and Windows
(Electron) — both of which load the same hosted `/device` runtime over the
network. Everything below is derived from the code as it exists at Feature 24.3,
and every claim about current behaviour cites the file that establishes it.

---

### 24.5G — the native shells needed the runtime, and the runtime needed a fix

**Hardware QA, Android, PASS** (real phone, airplane mode, 2026-08-20). A
previously paired till cold-starts with zero network and opens the real POS:
cached pairing, config, identity, lease and integrity all validate; an offline
sale is taken and durably queued; the queue survives close/reopen; reconnect
drains it to `waiting 0 · attention 0 · synced 1`.

Getting there took three defects, and the order matters because each hid the
next:

1. **The app was not on the device.** The shells loaded `/device` from a hosted
   URL, so with no network nothing from this repository ever executed — see the
   §16 correction above. Fixed by packaging the runtime locally.
2. **The cold-start gate had no cache fallback.** With the runtime finally
   running, `resolveDeviceState` still returned a terminal "This device is
   offline" whenever a session could not be established, without ever calling
   `loadOfflineFallback`. supabase-js will not return a session once the access
   token has expired and it cannot reach the server to refresh it, so this fired
   on every morning start. Fixed by recovering the persisted device auth user id
   locally — an ownership selector for evidence the device already holds, never
   a credential — and routing through the same `openOfflineOrFail` the
   pairing-state path uses.
3. **A real offline RPC was classified as a server rejection.** This is the one
   worth remembering. `hasServerResponseEvidence` accepted `typeof
   error.details === "string" || typeof error.hint === "string"` as proof a
   server had replied. `@supabase/postgrest-js` SYNTHESIZES an error object when
   `fetch` itself rejects and always populates both — including `hint: ""`,
   which still satisfies a `typeof` check. Every offline device RPC therefore
   classified as `server_rejected`, the one kind `permitsOfflineFallback`
   refuses, so a valid cache was unreachable.

**Why automation never caught (3):** every test constructed its own error
object — `{ message: "Failed to fetch" }` — while the library produced something
quite different. The fixtures and the library disagreed and the fixtures won.
`lib/deviceConnectivity.test.ts` now pins the shapes transcribed from executing
real failing calls, so library drift cannot silently reintroduce it.

**The evidence rule now** is only what a client cannot manufacture without an
answer: a positive HTTP status (`status: 0` is explicitly not evidence), or a
non-empty Postgres/PostgREST error code. `details` and `hint` inform humans and
decide nothing. OS socket codes (`ENOTFOUND`, `ECONNREFUSED`, …) are positive
evidence of transport rather than merely "not a database answer". Device RPCs
now pass the HTTP status through, which the `PostgrestError` object does not
carry on its own.

**The security gate was never the problem and was not touched.** An answered
rejection still refuses the cache: `P0001`, 401, 403 and 503 are all
`server_rejected`, and an unrecognisable answer falls to `unknown`, which also
refuses. Offline authorization remains the integrity-checked assertion plus the
7-day lease.

**One race fixed alongside:** `persistDeviceCache` was fire-and-forget, so a
till closed promptly after pairing could be killed mid-write and come back with
no cache. It is awaited; a failed write shows an amber "Offline use unavailable"
notice rather than silently claiming offline readiness.

**Windows is unchanged and still has defect (1).** Its approved origin remains
`app://poscanvas`; design only.

---

### What 24.5F changed

24.5F is a QA phase, and the two changes it made were both defects that QA
design surfaced before any hardware was switched on.

**DEF-01 — mid-session connectivity loss now falls back to cache.** Runtime mode
is still never inferred from `navigator.onLine`; what changed is that a
CLASSIFIED transport failure from an online `complete_sale_v3` attempt is now a
reason to try the cached start. `completeDeviceSaleV3` returns the
`DeviceFailureKind` it already computed, `PosRuntime` records a one-episode
"the wire died" window, and `DeviceApp.enterOfflineFromTransportFailure` runs
the SAME `loadOfflineFallback` a cold offline boot runs. It deliberately does
not call `resolveDeviceState`, which would set `checking`, unmount the runtime
and destroy the cashier's cart.

**The duplicate-sale defence is the identity, not the transition.** A v3 attempt
that died on the wire may already have created an order. The continued offline
sale therefore carries **that attempt's own `sale_request_id`**, so its eventual
`complete_sale_v4` submission is a REPLAY:

| Fact | Consequence |
|---|---|
| v3 and v4 build a byte-identical canonical preimage (`posc.sale.v2\nproject=…\npayment=…\ntip=…\nitems=…`) | the hash matches, so v4 does not raise a hash conflict |
| v4's idempotency lookup is `where project_id = … and sale_request_id = …`, with no filter on `source` | an order created by v3 IS found by v4 |
| the lookup runs **before** counter allocation, order insert, inventory mutation and audit rows | a replay has no side effects |
| §6b `occurred_at` validation is in the `else` branch — new sales only | a replay never reads `occurred_at`, which is also why it is not in the preimage |

So the second press yields exactly one order: the one v3 created, or a new one
if v3 never landed. Inheritance is gated on the cart still hashing the same and
on the transport window being open, and the identity is released the moment a
durable record owns it.

**The failed online attempt is never auto-queued.** The cashier presses Pay
again; the device does not silently convert an unknown-outcome request into a
queued sale behind their back.

#### The unknown-outcome lock

A second 24.5F review found the hole this leaves. Inheriting the key protects a
retry of the SAME cart — but nothing stopped the cashier changing the cart or
the payment method first, and a changed request hashes differently, so
`resolveSaleRequest` would mint a **second** idempotency key. A second key
cannot replay anything. That is a duplicate order, which the 24.5F failure rule
classifies as a release blocker.

A dispatched-but-unanswered request is therefore recorded explicitly as an
`UncertainSale` — its `saleRequestId`, project, payment method, tip, the items
as submitted, and the fingerprint as submitted — and every subsequent press is
gated on it:

| Next press | Outcome |
|---|---|
| same request (fingerprint matches) | **resume** under the original key — v3 replays it, or v4 does from the queue |
| anything hash-significant changed | **locked**: nothing is sent, no identity is minted, the cart is untouched |

One comparison covers payment method, tip, product, quantity and modifiers,
because `createSaleFingerprint` is the same preimage the server hashes and a
line identity already folds in the canonical modifier selection. A `locked`
decision has **nowhere to put a request id**, so a caller cannot accidentally
send one.

**The lock is not a dead end.** Restoring the order restores the fingerprint and
the sale resumes — a real recovery, and a tested one.

**Cancel does not clear it.** Closing a checkout abandons a local intention; it
cannot un-send a request that already left the device. The offline draft is
still discarded on close (24.5E's rule), which is safe because the identity
lives in the `UncertainSale` and is re-inherited on the next press.

**Only a POSITIVE resolution clears it** — a receipt from the server, or a
durable queue record that will obtain one. Not a rejection, and the tempting
argument for clearing on rejection is wrong: the idempotency lookup is *not*
the first thing `complete_sale_v4` does. Authorization and the project lock come
first (§6: "after authorization and the lock"), so a revoked device or an
expired session is refused **before** the key is ever looked up, and such an
answer says nothing about whether the original request committed. Rather than
sort rejections into pre-lookup and post-lookup — a classification that would
rot the next time the function is edited — the uncertainty simply survives.

#### The uncertainty is durable

A third 24.5F review closed the last hole: the record lived only in component
state, so a kill between dispatch and response lost the one key capable of
recognising an order the server may have committed — and the cashier's re-ring
created a second one.

It is now written to **IndexedDB, before the request is dispatched**, under the
key `uncertain-online-sale` in the existing `device-cache` store. No new
database, no new object store, no version bump.

**The ordering is the fix, and the obvious alternative is not sufficient.**
Writing the record when a failure is *observed* leaves the process free to die
between `await rpc(...)` starting and its rejection being handled — with the
request already on the wire. Arming first costs a row that is deleted the moment
a receipt arrives, and fails in the safe direction: a spurious record blocks a
changed sale until it resolves, whereas a missing one duplicates a real one.

If the write does not land, the till **refuses to dispatch** (`SALE_UNPROTECTED
_MESSAGE`) rather than take money it cannot protect — the same rule that already
refuses offline checkout when the queue is unavailable. Hosts that supply no arm
function (the owner runtime, the Builder preview) are unchanged.

**A rejection is handled differently on a first dispatch than on a replay**, and
conflating the two bricked the till. Keeping the arm after an ordinary
"Insufficient inventory" left the cart unchangeable, the same request
permanently refused, and reset permanently blocked — over a sale that never
existed.

| Event | First dispatch | Replay of an already-uncertain sale |
|---|---|---|
| pre-dispatch local refusal | never written | n/a |
| arm fails | never written; sale refused | n/a |
| receipt returned | **deleted** | **deleted** |
| transport / unknown | **kept** | **kept** |
| PostgreSQL raised (SQLSTATE) | **deleted** | **kept** |
| answered without a SQLSTATE (502/504) | **kept** | **kept** |
| durable offline enqueue of the same key | **deleted**; the queue owns it | **deleted** |

The distinction is modelled explicitly (`wasAlreadyUncertain`, taken from the
gate's own decision) and never inferred from message text.

**Why a first-dispatch SQLSTATE is safe to release.** `complete_sale_v3` and
`complete_sale_v4` contain no `COMMIT`, no `dblink`, no autonomous transaction
and no broad handler — every `exception when` in either function is a narrow
`invalid_text_representation` around a single cast. A business `raise exception`
therefore aborts the enclosing transaction, PostgREST runs each RPC in exactly
one transaction, and the order number comes from a transactional `UPDATE` rather
than a sequence (deliberately, so a rolled-back sale leaves no gap). This
invocation committed nothing, so its arm is protecting an order that does not
exist.

**Why the same answer does NOT release a replay.** The rejection may have been
raised *before* the idempotency lookup — §6 runs "after authorization and the
lock", so a revoked device or a lost session is refused without the key ever
being consulted. That says nothing about a *different, earlier* invocation. Only
a positive resolution proves what happened to that one.

**Why a status alone is not enough.** `isDatabaseRejection` requires a five-char
SQLSTATE. A proxy 502 or a gateway 504 answers without one and can arrive after
a commit, so it is treated as unknown and kept.

#### The queue handoff

An offline enqueue and the marker delete are two writes; a crash between them
leaves the sale durably queued and the marker stranded. That was never
duplicate-unsafe — the queue record carries the same key, so v4 still creates or
replays exactly one order — but the stale marker would keep blocking changed
sales and reset.

**Reconciled at startup on the exact `saleRequestId`, not made atomic.** One
IndexedDB transaction across both stores was available and is the wrong trade:
folding a cache delete into the enqueue's transaction means a failed DELETE
aborts the INSERT, converting a cosmetic problem into a lost sale. Reconciliation
releases a marker only when a queue record claims the very key it protects; an
unrelated queued sale proves nothing and an unreadable marker is left alone.

**Startup reads it before any new financial checkout**, and the durable copy
outranks anything the component remembers. After a restart the cashier rings the
same order again and presses Pay: the fingerprint matches, the original key goes
back out, and the server creates or replays exactly one order. Any *changed*
order is locked, as before.

**It is evidence, so nothing destroys it.** `clearDeviceCache` was changed from
`store.clear()` to targeted key deletes — a revocation or a re-pair clears the
menu and the pairing assertion but leaves the outstanding key alone, which
matters because revocation is not gated on the reset-safety check. Reset and
unpair are blocked while any record is present, readable or not. A record
belonging to a *different* pairing is neither applied to the new session nor
deleted: it cannot resolve anything for the new project, and it is still proof
of money that may have moved.

**Stored:** the key, project/device/build/auth identity, payment-method label,
tip, canonical items, the submitted fingerprint, `dispatchedAt`, schema version.
**Never stored:** any price, any card data, any token or credential.

**DEF-02 — a persisted backoff window now has something to fire it.** Previously
a sale that failed while the device was already online got a `nextAttemptAt` and
no future trigger: no further `online` event was coming, so it waited for a
restart or for someone to press Sync now. `readOfflineSaleStatus` now reports
`nextRetryAt` (the earliest persisted window, via the pure `earliestRetryAt`),
and the device schedules **one `setTimeout` aimed at that instant** — not a
polling interval, which would be a second, coarser schedule beside the real one.

`earliestRetryAt` considers only `pending` records that already carry a readable
`nextAttemptAt`. A freshly queued sale has none, and treating "no window" as
"due now" would wake the engine the instant a sale is taken — on a till that is
still offline, a guaranteed failed submission burning one of its ten attempts.
Fresh records are reached by the startup, reconnect and manual triggers instead.
A record in `syncing` is excluded too: a timer for one is a second submission.

Because the effect keys on the instant itself, a status refresh that does not
move it installs no new timer — the number of live timers is the number of
distinct due instants, which makes both leaks and retry storms structural rather
than merely unlikely. Across a restart the instant comes off disk, so a relaunch
inside the window schedules only the remainder and one after it clamps to zero.
`attemptCount` is never reset.

---

## 1. Current architecture — what actually happens today

### 1.1 Cold start

`components/device/DeviceApp.tsx` resolves device state in a fixed order:

```
getDeviceSession()            lib/device.rpc.ts:62   local read, then possible token refresh
  └─ if no session
     signInDeviceAnonymously() lib/device.rpc.ts:82   NETWORK — anonymous auth
fetchDevicePairingState()      lib/device.rpc.ts:128  NETWORK — rpc get_device_pairing_state
fetchDeviceConfig()            lib/device.rpc.ts:216  NETWORK — rpc get_device_config
  └─ returns build_jobs.config_snapshot (immutable, status='succeeded')
PosRuntime renders
```

The Supabase session is persisted by supabase-js into `localStorage` under
`pos-canvas-device-auth` with `persistSession: true`, `autoRefreshToken: true`
(`lib/supabase/deviceClient.ts`). That is the **only** thing currently surviving
a restart. Pairing state and configuration are re-fetched from the network on
every cold start and held in React state only.

### 1.2 Checkout

`complete_sale_v3(p_project_id, p_payment_method, p_tip_amount, p_items, p_sale_request_id)`
— `supabase/migrations/20260810120000_modifier_contract_and_complete_sale_v3.sql:765`.

The client sends **identifiers and quantities only**. It sends no prices. The
function, in order:

| § | Step | Notes |
|---|---|---|
| 2 | `resolve_sale_owner` | establishes the acting owner |
| 3 | `SELECT … FOR UPDATE` on `projects` | single serialization point per project |
| 3 | device branch | `paired_devices … revoked_at is null`, reads `build_job_id` |
| 4 | tip | devices may not tip; any non-zero tip is rejected |
| 5 | canonical preimage + `sha256` | header `posc.sale.v2`, keyed on item **and** modifier selection |
| 6 | **idempotency lookup** | by `(project_id, sale_request_id)`, before counter/insert/inventory |
| 7 | pricing source | owner → live `projects.config`; **device → `build_jobs.config_snapshot`** |
| 8 | per-line pricing from that source, **stock from the LIVE locked config** | |
| 10 | order number from `project_order_counters` | transactional, gap-free, prefix from the pinned source |
| 11 | atomic write | order, items, inventory, audit rows |
| 12 | one payload construction path | replay and new sale return identical shapes |

### 1.3 Facts that shape every decision below

1. **Idempotency already exists and is durable.** `orders.sale_request_id` +
   `orders.sale_request_hash`, with a partial unique index on
   `(project_id, sale_request_id) WHERE sale_request_id IS NOT NULL`
   (`20260803240000_order_counter_and_idempotency_scaffold.sql`). A replay with
   the same id **and** hash returns the stored order; the same id with a
   different hash raises `Sale request ID was already used for a different
   order`. The payload is rebuilt from the stored order, so a replay succeeds
   even if the item was since renamed, repriced, removed or sold out.

2. **A device is already priced from an immutable snapshot**, not from live
   config (§7 of the function). The owner publishing a new config does **not**
   change what a paired device charges. This is the pre-existing mechanism that
   makes offline pricing safe with no new server trust.

3. **The device has never known live stock.** `toDeviceDisplayConfig`
   (`lib/deviceSession.ts:248`) forces `trackInventory: false` and
   `stockQuantity: 0` on the display copy, and `DeviceApp` passes
   `refreshStock={null}` (`components/device/DeviceApp.tsx:258`). Inventory is
   enforced *only* inside the sale transaction and rejects hard with
   `Insufficient inventory for %`.

4. **Receipt numbers are server-allocated.** `project_order_counters` under the
   project row lock. The client has no way to produce one and never has.

5. **`orders.created_at` defaults to `now()`** — server time at insert. There is
   **no** `occurred_at` column (`20260729000000_capture_operational_schema.sql:123`).

6. **Revocation is checked on every call, including replays**, and deliberately
   *before* the idempotency lookup.

7. **Payment is a label, not a transaction.** `PaymentMethod = "cash" | "card"`
   (`lib/cart.ts:59`), constrained in SQL to the same two values. There is no
   gateway, no acquirer, no PAN, no CVV anywhere in the repository.

8. **The idempotency key is in-memory only.** `SaleRequestState`
   (`lib/saleRequest.ts`) lives in React state. `SALE_UNCONFIRMED_MESSAGE`
   already tells the operator to press Pay again — but a crash or reload between
   submit and response loses the key, and the retry then generates a *new* id.
   This is an existing duplicate-sale hole that offline work must close.

### 1.4 What currently requires the network

| Operation | Needs network | Why |
|---|---|---|
| Anonymous device sign-in | **Yes** | Supabase auth |
| Access-token refresh | **Yes** | ~1h JWT lifetime |
| `get_device_pairing_state` | **Yes** | authoritative pairing + revocation |
| `get_device_config` | **Yes** | pinned snapshot fetch |
| Rendering the menu | No, once config is in memory | pure render from the snapshot |
| Cart, modifiers, display totals | No | `lib/cart.ts`, `lib/modifiers.ts` are pure |
| **Completing a sale** | **Yes** | `complete_sale_v3` is the sole authority |
| Receipt number | **Yes** | server counter |
| Inventory decrement | **Yes** | server, live config |
| Pairing a new device | **Yes** | code redemption |
| Owner editing / publishing | **Yes** | owner surface, not the till |

Everything in the till that is *not* the sale itself is already offline-capable
in principle. The network dependency is concentrated in three places: **startup
resolution, the sale, and revocation.**

---

## 2. Offline capability matrix

Derived from §1, not assumed.

### SAFE OFFLINE

| Capability | Why it is safe |
|---|---|
| Reopen the POS from a cached pinned snapshot | the snapshot is immutable and already the pricing authority |
| Browse menu, categories, layouts | pure render |
| Add/remove items, choose modifiers | `lib/cart.ts` + `lib/modifiers.ts` are pure and already run client-side |
| Display subtotal / tax / total | computed from the pinned snapshot; the server recomputes identically from the same snapshot |
| Choose Cash or Card **as a label** | no authorization happens today, online or offline |
| Create a local sale intent with a durable idempotency key | key generation is `crypto.randomUUID()`, already client-side |
| Print a **provisional** receipt | see §9 — it must not carry a fake order number |

### ONLINE ONLY

| Capability | Why |
|---|---|
| Pairing a new device | redemption is a server transaction; there is nothing to cache |
| Unpair / re-pair | same |
| Adopting a newer published config | requires an authoritative fetch |
| Final receipt number | server counter, §9 |
| Authoritative inventory decrement | server, live config |
| Confirming a sale is recorded | by definition |
| Owner reports, dashboard, editor, publishing | owner surfaces, not the till |
| Confirming the device is still authorized | §14 |

### DISALLOWED WHILE OFFLINE

| Capability | Why |
|---|---|
| Tips on a device | already rejected server-side for devices (§4 of the function); allowing an offline tip would queue a sale guaranteed to fail |
| Refunds / voids / discounts | no server contract exists for any of them; offline is not the place to invent one |
| Any owner action | the till has no owner credentials, by design |
| Editing the cached config | it is a snapshot, not a document |
| A **first** sale on a device that has never successfully synced | there is no verified pairing to rely on |

---

## 3. Local config cache

### 3.1 What is cached

One record per paired device, written **only** after a successful authoritative
`get_device_config`:

```
PinnedConfigCache {
  cacheSchemaVersion   number     // this cache's own shape, independent of the config's
  configSchemaVersion  number     // from build_jobs.config_schema_version
  deviceAuthUserId     string     // binds the cache to the auth identity that fetched it
  projectId            string
  buildJobId           string     // the pinned build — the cache key that matters
  configSnapshot       object     // verbatim GeneratedPosConfig, never edited
  integrity            string     // SHA-256 of the canonical serialization of configSnapshot
  fetchedAt            string     // ISO, server-observed if available
  lastVerifiedAt       string     // last successful authoritative contact (§5)
}
```

### 3.2 Rules

- **Immutable.** Written whole, replaced whole. No field is ever edited in
  place. Any code path that mutates `configSnapshot` is a bug.
- **Integrity-checked on read.** Recompute the SHA-256 and compare. A mismatch
  discards the cache and forces online startup — a corrupted snapshot must never
  price a sale.
- **Bound to identity.** If `deviceAuthUserId` does not match the current
  Supabase user, or `projectId`/`buildJobId` disagree with the last known
  pairing, the cache is discarded. This is what prevents customer-to-customer
  leakage on a re-paired device.
- **Replaced only by an authoritative fetch**, never by anything local.
- **Cleared on unpair, on re-pair, and on confirmed revocation.** `resetDeviceSession()`
  (`lib/device.rpc.ts:107`) is the existing choke point and must clear it too.
- **Schema-versioned twice** — once for the cache envelope, once for the config
  contract. `GENERATED_POS_CONFIG_SCHEMA_VERSION` is already an exact-match
  check (`lib/generatedPosConfig.ts:426`); an unknown version discards the
  cache rather than guessing.

### 3.3 Storage technology

| Option | Verdict |
|---|---|
| `localStorage` | **No** for the queue. Synchronous, string-only, ~5 MB, and no transactions — a crash mid-write can leave a torn record. Already in use for the auth session; leave that alone. |
| **IndexedDB** | **Yes.** Transactional, structured, asynchronous, quota in the hundreds of MB, and the only web storage with atomic multi-record writes — which the queue requires. |
| Cache Storage | **No.** It is a keyed store of HTTP `Response` objects for asset caching. Modelling a sale queue in it means hand-rolling serialization with no transactions. |
| Platform-native (SQLite via a Capacitor plugin / Electron main-process file) | **No.** It would mean two implementations, a native bridge on each shell, and a break in the universal-binary invariant — the shells deliberately contain no product logic. |

**Decision: IndexedDB for both the config cache and the sale queue, in the
hosted web app, with no platform adapter.** See §17.

---

## 4. Offline device auth

### 4.1 The problem

Three separate things are conflated in "is this device allowed":

1. **Authentication** — a valid Supabase session. Stored in `localStorage`;
   supabase-js returns it offline even with an expired access token, but cannot
   refresh without network.
2. **Pairing** — a row in `paired_devices`. Only knowable from the server.
3. **Authorization to sell** — pairing *and* `revoked_at is null`. Only knowable
   from the server.

Offline, we can verify (1) locally and must rely on a cached assertion of (2)
and (3).

### 4.2 Design

Cache a **last known good pairing** record alongside the config cache, written
only on a successful `get_device_pairing_state`:

```
PairingAssertion {
  deviceAuthUserId, projectId, buildJobId,
  deviceName, platform,
  lastVerifiedAt     // the moment the server last said "paired, not revoked"
}
```

Cold start becomes:

```
session = getDeviceSession()            // local
if (!session)                  -> online-only path (unchanged)
try  authoritative resolve (network)    // unchanged happy path
catch network failure:
   assertion = readPairingAssertion()
   if (!assertion)                        -> existing offline error screen
   if (assertion.userId !== session.user) -> existing offline error screen
   if (leaseExpired(assertion))           -> "reconnect required" screen
   config = readConfigCache()             // integrity-checked
   if (!config)                           -> "reconnect required" screen
   open POS in OFFLINE mode
```

Note the guard order: **a device that has never successfully paired online can
never enter offline mode**, because no assertion exists.

### 4.3 The lease

An offline device cannot learn it was revoked. The only lever is a bound on how
long a cached assertion stays usable.

The tradeoff, stated honestly:

- **No lease:** a stolen or revoked till keeps taking cash indefinitely as long
  as it stays off the network. There is no upper bound on unrecorded takings.
- **Short lease (hours):** a real outage — a cut line, a rural shop with a flaky
  connection over a weekend — bricks the till during trading. This is a worse
  and far more likely failure than theft.

What bounds the damage regardless of the number: an offline till can only
*record* sales. It holds no owner credentials, can read nothing beyond its own
pinned menu, and every offline sale is reconciled against `revoked_at` at sync
(§14).

**APPROVED (owner, Feature 24.4 review): a 7-day lease from `lastVerifiedAt`,
refreshed on every successful authoritative contact.** Seven days covers a long
holiday weekend plus a slow repair, which is the realistic worst case for a shop
that wants to keep trading; it bounds a stolen device to one week of unrecorded
cash. The operator sees "Last verified {date}" whenever the device is offline, so
the lease never expires as a surprise.

24.5 must read this from **one named constant**, so revisiting the number later
is a one-line change rather than a redesign.

---

## 5. Sale identity and idempotency

**Reuse the existing contract unchanged.** No new idempotency mechanism is
needed, and inventing one would fragment a rule that is currently enforced in
exactly one place.

- The key is `sale_request_id`, a v4 UUID from `crypto.randomUUID()`
  (`lib/saleRequest.ts:createSaleRequestId`), already collision-resistant and
  already client-generated.
- The **only** change required is *when* and *where* it is persisted.

### 5.1 The rule

> A sale's `sale_request_id` is generated **once**, written to IndexedDB in the
> same transaction that enqueues the sale, and **never regenerated** — not on
> retry, not after a crash, not after a relaunch, not after a reload.

This closes the existing in-memory hole described in §1.3(8): today a crash
between submit and response loses the key and a retry creates a second order.

### 5.2 Why the server needs no change here

`complete_sale_v3` already:

- returns the stored order for a replay with the same id and hash;
- rejects the same id carrying *different* items with a clear error;
- performs the lookup **before** counter allocation, insert, inventory mutation
  and audit rows, so a replay has no side effects;
- rebuilds the payload from the stored order, so a replay succeeds even if the
  item has since been repriced or sold out.

An offline sale is, from the server's point of view, an ordinary `complete_sale_v3`
call that happens to arrive late. That is the whole point of designing it this
way.

### 5.3 Hash stability

The canonical preimage (§5 of the function) covers project, payment method, tip
and the sorted item/modifier lines. A queued sale must therefore be **frozen**:
once enqueued, its cart is immutable. Editing a queued sale is not "editing" —
it is voiding one sale and creating another, with a new id. The UI must not
offer an edit affordance on a queued sale.

---

## 6. Queued sale data model

```
QueuedSale {
  // identity — immutable after enqueue
  saleRequestId        string   // UUID v4, the idempotency key
  localId              string   // IndexedDB key; may equal saleRequestId
  enqueuedAt           string   // ISO, device clock — see the warning below

  // authorization context, so a stale queue cannot be replayed elsewhere
  deviceAuthUserId     string
  projectId            string
  buildJobId           string   // the pinned build the prices came from
  configSchemaVersion  number

  // the request, exactly as it will cross the wire
  paymentMethod        "cash" | "card"
  tipAmount            0        // devices may not tip; stored to keep the shape honest
  items: [{ itemId, quantity, modifiers: [{ groupId, optionIds[] }] }]

  // DISPLAY ONLY — never sent as authoritative, never used to price
  displayedSubtotal    string
  displayedTax         string
  displayedTotal       string
  displayedLines       [{ itemId, name, unitPrice, quantity, lineTotal, modifiers }]

  // provisional receipt
  provisionalRef       string   // see §9 — NOT an order number

  // sync state
  status               "pending" | "syncing" | "synced" | "needs_attention" | "permanent_failure"
  attemptCount         number
  lastAttemptAt        string | null
  nextAttemptAfter     string | null
  lastError            { code, message } | null

  // filled in on success
  serverOrderId        string | null
  serverOrderNumber    string | null
  serverCreatedAt      string | null
}
```

**The displayed totals are evidence, not input.** They exist so the operator and
the owner can see what the customer was actually shown, and so a mismatch
against the server's recomputation can be *detected and surfaced*. They are never
sent as prices. `complete_sale_v3` accepts identifiers and quantities only, and
that must not change — it is the property that makes a client-side queue safe to
trust at all.

### 6.1 Time — two timestamps, both preserved

**APPROVED (owner, Feature 24.4 review): keep BOTH times, always.**

| Field | Meaning | Source | Trust |
|---|---|---|---|
| `occurred_at` | when the device says the sale happened | device clock, **server-validated** | conditional |
| `created_at` | when the server actually recorded it | `now()` at insert | absolute |

Neither replaces the other, and neither is derivable from the other. `created_at`
answers "when did this enter the books" and is already correct today.
`occurred_at` answers "when did the customer pay", which is the question every
daily-takings, shift and reconciliation report is really asking — and which is
currently unanswerable for a sale that syncs hours late.

**A device clock is untrusted input.** `enqueuedAt` comes from an unsynchronized
clock and may be wrong by hours, or by years on a device whose battery died. The
server therefore validates rather than accepts:

| Device-reported time | Server behaviour |
|---|---|
| within a small skew allowance of `now()` | accept as `occurred_at` |
| earlier than `created_at` but after the device was paired | accept — this is the normal late-sync case |
| in the future beyond the skew allowance | **do not silently trust**; record the sale, leave `occurred_at` null, flag for reconciliation |
| before the device was paired | same — impossible by construction, so the clock is wrong |
| absent, unparseable, or non-finite | same |

**An unresolvable clock never destroys the sale.** The money is real regardless of
what the device thinks the time is. The sale is recorded with a null
`occurred_at`, marked `needs_attention` for the owner, and reported as "recorded,
sale time could not be verified" — which is the truthful statement. Rejecting it
would trade a real financial record for a metadata problem.

Ordering within one device's queue still uses `enqueuedAt`, because relative
order on a single device is reliable even when the absolute clock is not.

---

## 7. Price authority

### The scenario

1. Device pins build B and caches its snapshot.
2. Device goes offline; sells at build-B prices.
3. Owner publishes build C with new prices.
4. Device reconnects and syncs.

### Decision

**Price against the device's pinned build snapshot — which is what the server
already does, with no change.**

`complete_sale_v3` §7 resolves a device's pricing source as
`build_jobs.config_snapshot WHERE id = <the device's build_job_id> AND status='succeeded'`.
`build_jobs` rows are immutability-guarded
(`20260803260000_build_jobs_immutability_guard.sql`,
`20260803270000_artifact_and_device_immutability.sql`). So the snapshot that
priced the sale offline is byte-identical to the snapshot the server prices it
from at sync — **even if that sync happens weeks later and three configs have
been published since.**

This satisfies both halves of the requirement at once:

- **What the customer saw is what is recorded.** The device rendered build B and
  the server recomputes from build B.
- **Tampering is impossible.** The client never sends a price. Rewriting
  `displayedTotal` in IndexedDB with a hex editor changes what a *report* shows
  as the disputed display value; it changes nothing about what the customer is
  charged, because the server does not read it.

### Server validation still needed

The one thing the server cannot currently do is *notice* a disagreement. §13
proposes sending the displayed totals as an advisory field so the server can
record a mismatch flag. That is a reconciliation aid, never an input to pricing.

Note the pinning consequence, which is correct but must be stated: a device that
stays offline across a price rise sells at the old price. That is the same
behaviour as a device that stays *online* on an old pinned build, which is
existing, intended behaviour (§15).

---

## 8. Receipt numbering

### Current behaviour

Server-allocated from `project_order_counters` under the project `FOR UPDATE`
lock: `last_number + 1`, prefixed from the pinned source's `receipt.orderPrefix`.
Transactional rather than a sequence, deliberately, so a rolled-back sale leaves
no gap. **The client cannot allocate one.**

### Options

| Option | Assessment |
|---|---|
| **A. Provisional local number → final server number** | Two numbers for one sale. The customer walks out with a receipt whose number matches nothing in the owner's reports. Reconciling a dispute means a translation table. |
| **B. Preallocated blocks per device** | Requires a server allocation table, a block-exhaustion path, and permanent gaps when a device is lost mid-block. It also breaks the gap-free property the current design went out of its way to preserve. Real complexity for a real benefit — but not MVP complexity. |
| **C. Device-prefixed offline sequence** (`T2-014`) | No server change and unique across devices, but it creates a second *kind* of order number living permanently in the books, and every report, search and export has to understand both. |
| **D. No final receipt number until sync** | The receipt printed at the time of an offline sale is explicitly **provisional**, carrying a reference (not an order number). The order number is allocated exactly once, by the server, at sync. |

### Decision: **D**

Ratified by the owner's approved receipt copy (§22, decision 6), which states
"A final receipt number will be created after sync" — that sentence *is* option
D. The other three options are incompatible with it.

It is also the only option that changes nothing about the existing numbering
invariant — one allocator, gap-free, server-authoritative — and the only one
that cannot produce two numbers for one sale.

**APPROVED customer-facing copy (owner, Feature 24.4 review).** The receipt is
honest about its status without ever implying the sale was invalid or did not
happen — the customer paid, and the receipt must not suggest otherwise:

```
POS Canvas
OFFLINE RECEIPT

Ref: OFF-7Q4K-2XN9

... lines, totals ...

This sale is saved on this device
and will sync when internet is restored.
A final receipt number will be created after sync.
```

Note what this wording deliberately avoids: "NOT YET RECORDED", "provisional",
"unconfirmed" and "pending" all read to a customer as *"your payment may not have
gone through"*. The sale is real and complete; only its receipt number is still
to come. Any future edit to this copy must preserve that distinction.

`Ref` is a short, human-readable rendering of `saleRequestId` — enough for staff
to match a paper receipt to a queued sale, and visibly not of the same shape as
a real order number (`ORD1042`). Once synced, the device's own sale history shows
the reference **and** the real order number together, so a later dispute is a
lookup rather than a puzzle.

**Multiple simultaneous offline devices are safe under D**, because no device
allocates anything. Under C they would need coordinated prefixes; under B, a
block allocator.

---

## 9. Inventory

### The scenario in the brief

Device A (offline) shows 5 sandwiches; Device B (online) sells 4; Device A sells
3 offline.

### The important correction

**Device A never showed "5 sandwiches".** Devices display no stock at all —
`toDeviceDisplayConfig` strips `trackInventory`, and `refreshStock` is `null`
(§1.3.3). So there is no stale-count-on-screen problem to solve; there is only
the question of what happens to the queued sale at sync.

Equally, **this conflict already exists online.** Two online tills can both add
the last sandwich to a cart; whoever checks out second gets
`Insufficient inventory`. Offline changes only *when* the loser finds out: at the
counter (recoverable — the cashier tells the customer) versus at sync (the
customer left with the food an hour ago).

### Options

| Option | Assessment |
|---|---|
| Reject the queued sale | **Unacceptable.** The food is gone and the cash is in the drawer. Deleting the sale to protect a stock number destroys a real financial record. |
| Inventory reservation / per-device allocation | Genuine distributed inventory. Needs a reservation table, expiry, reclamation, and a policy for a device that never returns. Not MVP. |
| Allow stock to go negative and flag | Preserves the money, records the truth, and surfaces the discrepancy to the owner. |

### APPROVED (owner, Feature 24.4 review)

**An offline sale must never be destroyed because current stock changed.** Accept
the sale; let tracked stock floor at 0; record the shortfall; flag the order for
the owner.

Concretely, for offline-submitted sales only:

- the sale is **never** rejected for insufficient stock;
- `stockQuantity` decrements to a floor of 0 rather than going negative — the
  existing schema validates stock as a non-negative integer
  (`v_stock_num < 0 → 'Inventory configuration for % is invalid'`), so writing a
  negative would corrupt config the whole app reads;
- the shortfall (requested minus available) is recorded on the order and in the
  existing append-only inventory audit rows, so "we sold 3 we did not have" is
  visible rather than silently absorbed;
- the owner's order view shows an "inventory shortfall" flag.

Online sales keep the current hard rejection, unchanged. The asymmetry is
deliberate and defensible: online, the cashier can still act on the refusal;
offline, the transaction is already complete in the physical world and the books
must reflect it.

**Queued sales never disappear because stock changed.** That is the invariant.

---

## 10. Payment methods

POS Canvas **records** a payment method. It does not process, authorize,
capture, settle or refund anything. There is no gateway integration, no
acquirer, no card data of any kind in the repository (§1.3.7), and nothing in
this design adds one.

| Method | Offline | Reasoning |
|---|---|---|
| **Cash** | **Queue it.** | The money physically changed hands at the counter. The record is a bookkeeping entry that the server was not available to receive yet. Nothing about it is contingent on connectivity. |
| **Card** | **Queue it** — APPROVED (owner, 24.4 review), with the same honesty as online. | POS Canvas only records the payment-method *label*; it does not authorize or process the card, online or offline. The card was authorized — if it was — by a separate terminal the operator already uses. Recording "this sale was paid by card" offline is exactly as truthful as recording it online. |

The one thing that must not happen is UI copy implying POS Canvas approved a
card payment. It does not do that online and must not appear to do it offline.
Existing copy already says "Card" as a label; it should stay that way.

If a real gateway is integrated later, **card must be re-evaluated and will
probably become online-only**, because at that point the authorization genuinely
does depend on connectivity. Noted in §22.

---

## 11. Sync state machine

```
                   enqueue
                      │
                      ▼
                 ┌─────────┐   online + due
                 │ pending │──────────────────┐
                 └─────────┘                  ▼
                      ▲                  ┌─────────┐
     retriable error  │                  │ syncing │
     (backoff)        └──────────────────└─────────┘
                                              │
              ┌───────────────┬───────────────┼────────────────┐
              ▼               ▼               ▼                ▼
         ┌────────┐   ┌────────────────┐  ┌──────────────────┐ (transport
         │ synced │   │ needs_attention│  │permanent_failure │  failure →
         └────────┘   └────────────────┘  └──────────────────┘  pending)
        server said    server said        will never succeed:
        OK, or replay  something the      hash conflict, or
        returned the   owner must         local record proven
        stored order   resolve            corrupt
                       (e.g. revoked)
```

### Rules

- **Ordering:** strictly FIFO by `enqueuedAt`, then `localId`. One in flight at a
  time. Sales are financial records; a burst of parallel submissions buys
  nothing and makes failure attribution harder.
- **One bad sale must NOT block the rest.** A sale that reaches
  `needs_attention` or `permanent_failure` is *skipped*, not retried in place,
  and the queue continues. This is the single most important property here: a
  malformed sale from three days ago must never hold up this morning's takings.
- **Retry:** exponential backoff with jitter — 5s, 15s, 45s, 2m, 5m, 15m, capped
  at 15m. `nextAttemptAfter` is persisted, so a relaunch does not reset the
  schedule into a hot loop.
- **Attempt cap:** after ~10 attempts the sale moves to `needs_attention` and
  stops automatic retry. It never silently disappears and it is never
  auto-deleted.
- **Reconnect detection:** `navigator.onLine` + the `online` event as a *hint*
  only — both lie routinely (captive portals, "connected" with no route). The
  real signal is a successful lightweight authenticated call. A reconnect hint
  triggers an immediate attempt rather than being trusted.
- **Restart recovery:** on startup, any sale left in `syncing` is reset to
  `pending`. It is safe by construction: replaying is idempotent, and a sale that
  actually committed returns its stored order.
- **Partial failure:** each sale is its own transaction server-side. There is no
  batch, so there is no partial batch to unwind.
- **Manual retry:** the operator can force an attempt on `needs_attention`; the
  owner can see the same queue state. `permanent_failure` needs a human decision
  and offers no blind retry.
- **Unverifiable sale time is a reconciliation case, never a rejection.** If the
  server cannot validate the device-reported `occurred_at` (§6.1), the sale is
  still recorded — with a null `occurred_at` — and lands in `needs_attention` for
  the owner. A clock problem must never cost a real sale.

### Terminal-state meanings

| State | Means | Operator sees |
|---|---|---|
| `synced` | recorded server-side, order number known | ✓ with the order number |
| `needs_attention` | server refused for a reason a person must resolve — device revoked, build unusable | a clear reason, and it is *not* their fault |
| `permanent_failure` | replay is impossible or unsafe — `sale_request_id` reused with a different hash, or the local record failed integrity | escalate; never retried automatically |

---

## 12. Server contract for 24.5

**Preferred posture: reuse `complete_sale_v3` as-is wherever possible.** It
already handles idempotency, pinned pricing, revocation and atomicity. The
additions below are the minimum that offline genuinely cannot do without.

| # | Change | Necessity | Why |
|---|---|---|---|
| 1 | **`orders.occurred_at timestamptz` NULLABLE**, alongside an untouched `created_at` | **Required** | Both are kept (§6.1). `created_at` stays `now()` — when the server recorded it. `occurred_at` is when the device says the sale happened. A 14:05 sale synced at 18:30 currently records only as 18:30, which corrupts daily takings, shift reports and any time-based reconciliation. Nullable **on purpose**: an unverifiable device clock leaves it null rather than storing a lie. |
| 2 | **`p_occurred_at` parameter** on a new `complete_sale_v4` | **Required** | to carry (1). **Validated, not trusted**: future beyond a small skew allowance, earlier than the device's pairing, absent or unparseable → store null and flag for reconciliation. Never reject the sale over it. |
| 3 | **`orders.source`** (`'online' \| 'offline_queued'`) | **Required** | drives the inventory asymmetry in §9 and makes offline sales auditable as a class. |
| 4 | **Offline stock policy** in the pricing loop | **Required** | for §9: floor at 0 and record the shortfall instead of raising `Insufficient inventory`, for `source='offline_queued'` only. |
| 5 | **`orders.client_declared_total numeric(12,2)`** + a mismatch flag | Recommended | lets the server *detect and record* a disagreement between what the customer was shown and what the pinned config recomputes. Advisory only — never an input to pricing. |
| 6 | **Revocation-window decision** encoded in SQL | **Required** | §14 — the current unconditional rejection is a real data-loss path. |
| 7 | Sync metadata (`synced_at`, device attempt count) | Optional | useful for support; not needed for correctness. |

Everything else — auth, `resolve_sale_owner`, the project lock, canonicalization
and hashing, the idempotency lookup, counter allocation, the atomic write, money
bounds, tax modes, audit rows — is **unchanged**.

**Versioning:** this should be `complete_sale_v4`, following the established v2→v3
pattern, with v3 left callable so devices on older pinned builds keep working.
No migration is created in 24.4.

---

## 13. Revocation policy

### The problem

1. Device is valid. 2. Goes offline. 3. Owner revokes it. 4. Device cannot know.
5. Device keeps selling.

### What happens today if nothing changes

`complete_sale_v3` §3 rejects any device whose `paired_devices` row is missing or
has `revoked_at set`, **before** the idempotency lookup — so on reconnect,
**every queued sale is rejected and the takings are silently lost.** That is a
data-destruction path, not a security feature: the cash is in the drawer whether
or not the owner revoked the device afterwards.

### APPROVED (owner, Feature 24.4 review)

Split "may this device sell now?" from "should this already-completed sale be
recorded?".

- **Reopening after reconnect:** a **confirmed revoked device cannot reopen or
  re-enter the POS.** On reconnect it is refused immediately, clears its config
  cache and its pairing assertion, and returns to the pairing screen. It must not
  fall back into offline mode on the next launch — a cleared assertion is what
  makes that structurally impossible (§4.2 refuses any device without one).
- **Queued sales that occurred BEFORE `revoked_at`:** **accept and record**,
  flagged `source='offline_queued'` and `post_revocation=false`. The sale
  physically happened while the device was still authorized. Refusing it does not
  undo it; it only removes it from the books.
- **Queued sales that occurred AFTER `revoked_at`:** **reject**, and surface them
  to the owner as "N sales were attempted after this device was revoked" with
  their details. This is where the lease (§4.3) does its work: it bounds how many
  such sales can exist.
- **The comparison uses server-validated `occurred_at`** (change 2 in §12), not
  the raw device clock, or a device could backdate its way past revocation.

This is the honest position: **there is no way to stop an offline device from
taking cash.** What the system can do is refuse to *record* post-revocation sales
as legitimate, tell the owner exactly what happened, and bound the window.

The operator-facing UX must warn plainly when a device has been offline a long
time — "Not verified since Tuesday. Reconnect to confirm this till is still
authorized."

---

## 14. Config update policy

**No change to existing pinning semantics.** A paired device stays on its pinned
build until something explicitly re-points it, and offline changes nothing about
that.

- Reconnecting does **not** silently adopt a newer published config. A till's
  prices changing mid-shift because someone saved the editor is exactly the
  surprise the immutable-build architecture exists to prevent.
- The config cache is refreshed from `get_device_config` on every successful
  online start, but that call returns **the snapshot for the pinned build**, so a
  refresh normally returns identical bytes. `buildJobId` changing is the *only*
  legitimate reason for the cached snapshot to change.
- If `buildJobId` changes, the cache is replaced wholesale, and any sales still
  queued keep their original `buildJobId` and are priced from it. This is exactly
  why `buildJobId` is stored per queued sale (§6).

Adopting a newer config remains an explicit action outside this design.

---

## 15. Local data security

### What is stored

| Data | Sensitivity | Notes |
|---|---|---|
| Supabase session (existing) | **High** | already in `localStorage`; the one real credential on the device |
| Pinned config snapshot | Low–medium | the shop's menu and prices — visible to any customer reading the till screen |
| Queued sales | Medium | line items, quantities, totals, `"cash" \| "card"`, timestamps |
| Provisional receipt refs | Low | derived from `saleRequestId` |

### What is NOT stored, ever

**No card number. No CVV. No expiry. No cardholder name. No track data.** POS
Canvas never receives them (§10), so there is nothing to store, and nothing in
24.5 may introduce them. This is worth a guard in 24.5.

### Encryption at rest — MVP position

**Do not add application-level encryption to IndexedDB for MVP, and do not claim
any.** Stated plainly, because the reasoning matters:

- The key would have to live on the same device, in the same storage, readable by
  the same code. Encrypting data with a key stored beside it protects against a
  casual browse of the database file and nothing more.
- The genuinely sensitive item — the auth session — is *already* in plain
  `localStorage` and is a far more valuable target than a list of sandwich sales.
  Encrypting the queue while leaving the session in the clear would be theatre.
- Real protection at this layer is OS-level: Windows BitLocker, Android
  full-disk encryption. That is a deployment recommendation, not an app feature.

**No "military grade", "bank grade" or "end-to-end encrypted" claims may appear
anywhere** in the product or its documentation. What can be said truthfully:
*"Sale data is stored locally on the device until it syncs. Card details are
never collected or stored."*

### Clearing

**APPROVED (owner, Feature 24.4 review): unpair is BLOCKED by default while the
queue is non-empty.**

- Queued sales are **never** silently deleted. This is the worst bug the feature
  could ship, and it is ruled out by policy rather than left to care.
- Unpair, re-pair and confirmed revocation clear the config cache and the pairing
  assertion — but the **queue is cleared only after it has drained**.
- Any future discard path must require **explicit confirmation showing the
  count** ("Discard 7 unsynced sales?"). A discard affordance that does not name
  the number is not an acceptable implementation of this decision.
- `resetDeviceSession()` (`lib/device.rpc.ts:107`) is the existing choke point and
  must gain this decision path, not an unconditional wipe.

---

## 16. Cross-platform storage decision

### The key insight

Both shells load **the same remote origin** — `https://pos-canvas.vercel.app/device`.
Android Capacitor points at it via `server.url`; Electron via `loadURL`. Neither
shell contains product logic, and both are byte-identical for every customer.

Therefore **the storage lives in the hosted web app, on one origin, and there is
exactly one implementation.** No Capacitor plugin, no Electron IPC, no native
adapter, no second code path to keep in sync.

| Environment | Engine | IndexedDB |
|---|---|---|
| Android WebView (Capacitor 8) | Android System WebView (Chromium) | Yes. Capacitor enables DOM storage explicitly (`Bridge.java:584`, `setDomStorageEnabled(true)`). |
| Windows Electron 43.4.0 | bundled Chromium | Yes. Default persistent session; no `fromPartition`, no ephemeral profile (asserted by existing guards). |

### Persistence risks — the real ones

- **Eviction.** Chromium may evict origin data under storage pressure. Mitigation:
  request `navigator.storage.persist()` once the device is paired, and record
  whether it was granted. If it is refused, that is worth surfacing.
- **Android WebView data clearing.** "Clear data" on the app, an OS storage
  sweep, or an uninstall removes everything. Unsynced sales are lost. This is
  inherent to browser-side storage and must be stated in the docs rather than
  hidden.
- **Windows `%APPDATA%\POS Canvas`.** Already validated as surviving upgrade and
  abrupt termination in Feature 23.5. The queue inherits that.
- **Quota.** A queued sale is on the order of 1–2 KB. Even a pathological
  10,000-sale backlog is ~20 MB, far inside any realistic quota. Quota
  exhaustion is therefore an error path to handle, not a design constraint.

**Decision: IndexedDB, one shared implementation, plus a
`navigator.storage.persist()` request. No platform-specific adapters.**

### CORRECTION (Feature 24.5G) — "one implementation" never meant "one hosted origin"

**The key insight above was half wrong, and real hardware QA proved it.** Both
shells did load the same remote origin — and that is precisely why neither could
start without a network. With no connection the WebView could not fetch
`/device`, so `DeviceApp` never executed, `openOfflineDb` was never called, and
every capability built in 24.5A–F sat behind a static "needs an internet
connection" page. The offline POS was only ever offline-*capable* once it had
already booted online.

| | Before 24.5G | After 24.5G (Android) |
|---|---|---|
| Entry point | `server.url` → hosted `/device` | bundled assets in the APK |
| Zero-network cold start | static error page | the real POS |
| Origin | `https://pos-canvas.vercel.app` | **`https://localhost`** |
| Runtime source | Vercel deployment | the installed binary |

**One implementation still holds — it is the same `DeviceApp`, the same
`PosRuntime`, the same `lib/` financial modules, built from the same source.**
What changed is that the native app carries that implementation instead of
fetching it. `android-shell/device/main.tsx` is a three-line mount, the local
equivalent of `app/device/page.tsx`; a guard asserts it contains no POS logic
and that nothing under `android-shell/` duplicates any.

**Android's permanent native origin is `https://localhost`** (Capacitor's
default `androidScheme`). It is permanent for two reasons, both load-bearing:

1. **Storage is origin-scoped.** IndexedDB *and* the localStorage auth session
   belong to the origin. Changing it later strands a till's pairing, its pinned
   config and its queued sales — and because a new origin also means a new
   anonymous auth user, even a perfect data copy would be refused by
   `readPairingAssertion`'s identity check.
2. **It must be a secure context.** `digestConfig` uses `crypto.subtle`, which
   is unavailable outside one; without it `buildPinnedConfigRecord` returns null
   and **no cache is ever written**, so offline mode would silently never arm
   while looking perfectly healthy online. `https://localhost` is
   potentially-trustworthy by specification. `file://` is not, which is why it
   was rejected along with `http://localhost` and `capacitor://`.

**Windows is implemented too, as of 24.5F.** It had the identical defect —
`loadURL(server.url)` with `loadFile(offline.html)` on failure — and now serves
the same packaged runtime from **`app://poscanvas`**, an Electron scheme
registered before app ready with exactly three privileges: `standard` (so the
origin is real and IndexedDB/localStorage have somewhere stable to live),
`secure` (so `crypto.subtle` exists for the config digest) and
`supportFetchAPI`. `bypassCSP`, `allowServiceWorkers`, `corsEnabled` and
`stream` are deliberately not granted.

#### One runtime, two local origins

| | Android | Windows |
|---|---|---|
| Origin | `https://localhost` | `app://poscanvas` |
| Served by | Capacitor's asset loader | Electron privileged scheme |
| Package dir | `android-shell/www` | `windows-shell/runtime` |
| Hardware QA | **PASS** (2026-08-20) | **pending** |

**Both are built from `native-device/` by the same Vite config**, differing only
in `POS_CANVAS_DEVICE_OUT_DIR`. The two builds emit byte-identical bundles — same
content hash — which is the concrete form of "one implementation". A guard
asserts neither `android-shell/` nor `windows-shell/` contains any POS or
financial logic of its own.

**"One implementation" has never meant "one origin".** It means one source for
`DeviceApp`, `PosRuntime`, the cache, the queue, the sync engine and every `lib/`
money rule. Each shell packages that source and serves it from its own stable
local origin.

#### The app:// origin trap, recorded because it is subtle

`app:` is not a "special" scheme to the WHATWG URL parser, so
`new URL("app://poscanvas/x").origin` is the string `"null"` — **and so is
`new URL("app://evil/x").origin`.** An origin allow-list would therefore match
nothing, and "fixing" that by adding `"null"` would admit every host on every
non-special scheme at once. Chromium reports a real origin inside the renderer
once the scheme is registered as `standard`, but the navigation policy runs in
the main process on Node's parser, which does not. `windows-shell/appProtocol.mjs`
and the navigation policy therefore compare **scheme and host explicitly** and
never touch `.origin`.

Path resolution has its own trap: the URL parser collapses a literal `/../` but
**not** a percent-encoded one, so `app://poscanvas/assets/..%2f..%2fsecret`
arrives intact and only reveals itself after decoding. The resolver decodes
first, resolves against the runtime root, and then requires the result to still
be inside it.

#### First Windows hardware run — three defects, all fixed

The first Windows QA build was **dead on arrival**, and the reason is worth
recording because a guard passed while it was broken.

`main.mjs` called `protocol.registerSchemeAsPrivileged` — **singular**, a
function Electron does not have. The real API is
`registerSchemesAsPrivileged`. It threw a `TypeError` during module evaluation,
before `app.whenReady()` and before any window existed, so the packaged
application could not start at all. A structural guard had asserted the exact
misspelling and passed: **a source-string assertion verifies that a file says
what its author believed, never that the API exists.** This is the same failure
shape as the PostgREST classifier bug in 24.5G — a fixture agreeing with the
code instead of with reality.

The answer in both cases is the same: run the real thing.
`lib/windowsStartup.smoke.test.ts` now boots Electron, checks the method name
against Electron's own export list, asserts the shell starts without a fatal
load exception, and drives an offscreen window that must report origin
`app://poscanvas`, `isSecureContext`, `crypto.subtle`, IndexedDB and a mounted
`DeviceApp`, with the document and both hashed assets each served 200.

Two smaller defects were fixed alongside:

- **The splash animation was invisible.** The splash was replaced the instant it
  finished loading, which was fine while the runtime was a network fetch taking
  seconds and useless once it became local and resolved in milliseconds. A
  minimum visible hold of one animation cycle (1400 ms) now runs *concurrently*
  with the splash load, so startup costs `max(load, hold)` rather than the sum.
- **Electron's stock File / Edit / View / Window menu was visible.** It had never
  been suppressed on either the old or the new architecture.
  `Menu.setApplicationMenu(null)` removes it — rather than hiding it, so Alt
  cannot summon one — with `autoHideMenuBar` as a second barrier. The window
  frame is untouched; `frame: false` is deliberately not used.

#### Windows hardware QA — PASS

Confirmed on a real Windows PC after the three fixes above:

| | |
|---|---|
| splash / logo | animation plays |
| application menu | File / Edit / View / Window gone; minimise, maximise, close intact |
| pairing field | Ctrl+V and normal editing work with no application menu |
| online | pairing and the real POS load |
| local runtime | `app://poscanvas` serves the packaged bundle |
| **zero-network cold start** | **the real POS opens**, with the amber offline banner |
| offline sale | completes; OFFLINE RECEIPT with an `OFF-` reference |
| durability | queue survives Task Manager kill **and** a full PC reboot while offline |
| reconnect | queue drains; no `needs_attention` afterwards |

**Both platforms are now hardware proven**: Android on `https://localhost`,
Windows on `app://poscanvas`, from one shared runtime built out of
`native-device/`.

#### A build-time hazard worth knowing about

`electron-builder` **rewrites package.json files after packaging** — reducing
them to `name`/`productName`/`version`/`private`/`description`/`main` and
dropping `scripts`, `devDependencies` and the entire `build` block. It damaged
BOTH `windows-shell/package.json` and, worse, the **repository root**
`package.json`, overwriting it with the shell's own minimal manifest. The root
then had no `test`, `build` or `lint` script at all.

The installer itself is produced correctly from the full manifest; it is the
source tree that is damaged, a few seconds after the build reports success.

**So the safe local protocol is: commit first, build the installer last, then**

```
git checkout -- package.json windows-shell/package.json
```

CI is unaffected — it packages from a fresh checkout and never commits. This was
caught only because the brand and installer guards failed on a tree that had
been green minutes earlier; `npm test` itself then stopped working, which is how
the root-level damage surfaced.

**Migration is not automatic and must never be pretended.** A device moving from
the hosted origin to a local one starts with empty storage and no session: it
must drain its queue to zero *before* the switch and re-pair after it. The
existing reset-safety gate already refuses to proceed while anything is unsynced,
and that is the protection to lean on.

**Update model is unchanged:** one universal binary per platform, business
configuration still server-driven and pinned per device. Runtime changes now ship
as ordinary app updates rather than as a Vercel deploy. No remote code download,
no OTA JavaScript bundle.

---

## 17. Offline UX

### Connection states

| State | Indicator | Rule |
|---|---|---|
| Online, queue empty | subtle "Online" or nothing at all | the normal case must not nag |
| Offline, queue empty | **Offline** — "Sales will be saved and synced when you reconnect." | calm and factual |
| Offline, queue non-empty | **Offline · 3 sales waiting** | a count, never a percentage |
| Reconnecting / syncing | **Syncing 3 sales…** | may show "2 of 3" because that is a real count |
| Sync error | **3 sales need attention** with a reason | never a bare red icon |
| Lease near expiry | **Not verified since Tuesday — reconnect soon** | before it bricks, not after |

### Requirements

- **No fake percentages, no fake progress bars.** A count of sales is a real
  quantity; a synthetic 0–100% is not.
- **Never block the cart.** Browsing and building an order must work identically
  online and offline. The only different moment is checkout.
- **The operator always knows whether a sale is recorded.** The sale-complete
  screen says either "Recorded — Order ORD1042" or "Saved on this device — will
  sync when you reconnect", never something ambiguous.
- **The queue is visible and inspectable** from the device: a list of pending
  sales with their reference, time, total and status.
- **Manual retry** available on `needs_attention`. Not on `pending` — the
  automatic schedule already handles it, and a "retry" button that does nothing
  visible teaches operators to distrust the UI.
- Copy stays inside the existing Feature 22 vocabulary and tone: say what
  happened, say what to do, promise nothing.

### Owner-facing (APPROVED, owner, 24.4 review)

The owner's **Devices** panel gains a **read-only** per-device sync column: the
device's queue depth, its sync state and when it was last verified. Read-only is
the whole point — the owner watches, and the device syncs. No owner-triggered
"force sync" button, which would imply a control the server does not have over a
device that is, by definition, not reachable.

### Receipts

The provisional receipt (§8) must state that the sale is saved on this device
and that a receipt number is still to come. Once synced, the device's own
history shows the real order number against the provisional reference. A reprint
after sync should print the **final** receipt with the real order number.

> **Clarified in 24.5E.** An earlier phrasing here said the receipt must state
> the sale is "not yet recorded". §8's approved copy is the authority and
> deliberately avoids that wording: to the customer holding the slip it reads as
> *your payment may not have gone through*, which is untrue. The sale is real
> and complete; only its number is pending.

---

## 18. Failure-scenario matrix

| # | Scenario | Expected behaviour |
|---|---|---|
| 1 | Internet drops before checkout | Cart unaffected. Checkout enqueues locally; provisional receipt; "Offline · 1 sale waiting". |
| 2 | Drops **while** submitting | Transport error. The sale is already in IndexedDB with its key. It moves to `pending` and retries. **No new key is generated.** |
| 3 | Server committed, client never got the response | Retry replays the same `sale_request_id`; `complete_sale_v3` §6 returns the stored order. Marked `synced` with the real order number. Exactly one order exists. |
| 4 | Crash after local enqueue | The sale survives — enqueue is a durable IndexedDB transaction that completes before the receipt is shown. |
| 5 | Crash during sync | On restart, `syncing` → `pending`. Replay is idempotent (see 3). |
| 6 | Device restarts offline | Cold start uses the cached assertion + config (§4.2). POS opens in offline mode with the queue intact. |
| 7 | Multiple queued sales | FIFO, one in flight, each its own server transaction. |
| 8 | One queued sale has invalid data | It goes to `needs_attention` or `permanent_failure` and is **skipped**. Later sales sync normally. |
| 9 | Device revoked while offline | Reopen refused on reconnect. Pre-revocation queued sales are recorded; post-revocation ones are rejected and reported to the owner (§13). |
| 10 | Config unavailable server-side (build deleted) | `This device is not linked to a usable build`. Queue → `needs_attention`; owner must re-pair. Sales are **not** deleted. |
| 11 | Owner publishes a newer config | Irrelevant to queued sales: they price from their own `buildJobId` (§7). The device stays pinned (§14). |
| 12 | Two devices sell the same low-stock item offline | Both are recorded. Stock floors at 0; the shortfall is flagged for the owner (§9). Neither sale is destroyed. |
| 13 | Operator hammers "Complete Sale" | The fingerprint/`resolveSaleRequest` logic already reuses one id for an unchanged cart. Offline, the enqueue is idempotent on that key: one queued sale, not five. |
| 14 | Connectivity flaps | Backoff plus "one in flight" prevents a thundering herd. A flap mid-submit degenerates to case 2 or 3, both safe. |
| 15 | Quota exceeded / storage corrupt | Enqueue failure must be **loud and blocking at checkout**: the operator is told the sale cannot be saved *before* they hand over the food. A queue whose integrity check fails goes to `needs_attention` and is never silently dropped. |
| 16 | Device clock is wrong (dead battery, wrong year, future-dated) | Sale is **recorded**. `created_at` is correct as always; `occurred_at` is left null rather than storing a lie; the order is flagged and lands in `needs_attention` for the owner (§6.1). The sale is never rejected over a clock. |
| 17 | Operator unpairs with a non-empty queue | **Blocked** (§15). The queue must drain first. Any future discard path names the count explicitly; nothing is deleted silently. |

---

## 19. Implementation sequence for 24.5

Ordered so every phase is independently shippable and independently revertible,
and so nothing can queue a sale before the server can accept it.

| Phase | Contents | Ships behind |
|---|---|---|
| **24.5A** | IndexedDB foundation + config cache + offline **read-only** startup. Device reopens offline and shows the menu. **Checkout is disabled while offline.** | a flag; no risk to money |
| **24.5B** | Server contract — `occurred_at`, `source`, offline stock policy, revocation window, `complete_sale_v4`. Deployed and tested **with no client using it yet.** | additive migration |
| **24.5C** | Durable sale queue + persisted idempotency key. Also fixes the existing in-memory key hole (§1.3.8) **for online sales**, which is a standalone win. | flag |
| **24.5D** | Sync engine + state machine + reconnect detection. | flag |
| **24.5E** | Offline checkout enabled, provisional receipts, inventory-shortfall reporting, owner-facing offline order views. | flag |
| **24.5F** | Android + Windows failure testing (§20), including abrupt termination and process kill on real hardware. | gate before enabling by default |

**24.5B precedes any client that can queue a sale.** Shipping the queue first
would create sales that the server would reject for lacking a contract — the
exact data-loss the design exists to avoid.

---

## 19A. Manual test plan — 24.5A (read-only offline startup)

Automated coverage stops at the browser boundary: vitest runs under Node, so the
real Android WebView and the real Electron window have to be driven by hand.
Run every row on **both** platforms. Nothing here involves a sale, because
24.5A cannot complete one.

### Precondition (both platforms)

1. Pair the device online with a real project.
2. Confirm the POS opens and the menu renders.
3. Close and reopen while still online — normal POS, no offline banner.

That third step matters: it proves the cache write on an authoritative start did
not break the ordinary path.

### Windows (Electron)

| # | Step | Expected |
|---|---|---|
| 1 | Close the app completely | — |
| 2 | Disable the network adapter / turn off Wi-Fi | — |
| 3 | Launch POS Canvas | Branded splash, then the POS opens from cache |
| 4 | Look at the top of the screen | Amber bar: **Offline · Using last verified configuration · Last verified: {date}** |
| 5 | Browse the menu, add items, choose modifiers | All work normally; totals calculate |
| 6 | Open checkout and pick a payment method | **Complete Sale is disabled**, with "Internet connection required to complete sales." |
| 7 | Restore the network | — |
| 8 | Relaunch (or press Retry) | Offline bar disappears; normal online POS; checkout enabled |

### Android (Capacitor WebView)

Identical sequence, using airplane mode — or, on an emulator,
`adb shell svc wifi disable && adb shell svc data disable` (restore with
`enable`). Step 3's splash is the Android cold-start splash from 24.2.

### Lease expiry

Cannot be waited out by hand. Verify by moving the **device** clock forward more
than 7 days while offline, then relaunching:

| Expected | |
|---|---|
| POS does **not** open | "Reconnect required — This till has been offline for more than 7 days." |

Moving the clock *backwards* instead must also refuse, with the clock message —
that is the anti-tamper path, and it is the one worth checking deliberately.

### Revocation must beat the cache

The most important manual test in this phase.

1. With the device online and a valid cache, have the owner **revoke** it.
2. Leave the device online and relaunch, or press Retry.
3. **Expected:** the revoked screen. The cached POS must **not** open, now or on
   any later launch — the confirmed revocation clears the cache.
4. Then disable the network and relaunch again.
5. **Expected:** still not the POS. With the cache cleared there is nothing to
   fall back to, and the device asks to be paired again.

If step 3 or step 5 ever shows a working POS, stop: the transport-versus-answer
classification has failed and 24.5A is not shippable.

### Re-pair isolation

1. Pair to Business A, confirm the menu, go offline once to see it cached.
2. Reset the device and pair to Business B.
3. Go offline and relaunch.
4. **Expected:** Business B's menu. Business A's must never appear.

---

## 19B. Evidence status for the offline server contract (24.5F correction)

**What `complete_sale_v4` has already been validated against real PostgreSQL.**
Feature 24.5B's staging validation executed the function, and the outcomes are
what `KNOWN_SERVER_ERRORS` in `lib/saleSyncClassifier.ts` was built from — every
message in that table was observed on a real server. That validation covered:

- the revocation window, in both directions;
- acceptance of an offline sale that occurred **before** `revoked_at`;
- rejection of one claiming to have occurred **after** it;
- backdating protection (both the pairing floor and the offline-age ceiling);
- inventory shortfall recording;
- tracked stock flooring at zero rather than going negative;
- the exact per-line shortfall figure;
- online sales still being hard-rejected for insufficient inventory.

**None of that should be described as unexecuted.** The migration suite beside
the function asserts SQL *text* and cannot run it, but that is a statement about
`20260819120000_…test.ts`, not about the contract's validation history.

**What remains genuinely unproven, and is what OF-14 and OF-15 are for:** the
END-TO-END path — a real device queueing a sale in IndexedDB, the sync engine
submitting it through `lib/offlineSaleRpc.ts`, `complete_sale_v4` accepting or
rejecting it, and the reconciliation model joining the offline reference to the
resulting order identity. The server half is validated; the client-to-server
join is not. Both scenarios therefore stay assigned to **staging** for 24.5F
end-to-end QA, and neither should be run against the shop's production till.

---

## 20. Test plan for 24.5

### Pure unit (no network, no browser)

- Idempotency key generated once and stable across serialize/deserialize.
- Sync state machine transitions, including every terminal state.
- Backoff schedule: monotonic, capped, jittered, restored from persistence.
- FIFO ordering with a mixture of statuses; a skipped sale does not block.
- Config-cache integrity: tampered snapshot rejected; wrong schema version
  rejected; wrong `deviceAuthUserId` rejected.
- Lease expiry arithmetic, including clock-skew and negative-elapsed cases.
- Provisional reference format: derived from `saleRequestId`, never
  order-number-shaped.
- Queued-sale serialization round-trip.

### Integration (fake IndexedDB + stubbed RPC)

- **Duplicate replay:** same key submitted 5× → one order, identical payload.
- Hash conflict: same key, different items → `permanent_failure`, no order.
- Crash simulation: kill between enqueue and submit; between submit and
  response; during sync.
- Queue drains in order; one poisoned sale is skipped.
- Corrupted queue record → `needs_attention`, never silent deletion.
- Revocation: pre- and post-`revoked_at` sales handled per §13.
- Stale build: `build_jobs` row unusable → `needs_attention`.
- Quota exhaustion at enqueue → checkout blocked with a clear message.

### Server (migration tests, matching the existing style)

- `complete_sale_v4` idempotent replay returns the stored order.
- `occurred_at` clamped: future beyond skew rejected; pre-pairing rejected.
- Offline stock policy floors at 0 and records the shortfall; online path still
  hard-rejects.
- Pinned-build pricing unchanged when a newer build exists.
- Revocation window enforced against server-validated `occurred_at`.
- v3 remains callable and unchanged.

### Manual / device

| Test | Platform |
|---|---|
| Airplane mode mid-shift, 10 sales, reconnect | Android + Windows |
| Browser reload with a full queue | both |
| **Abrupt termination** (Task Manager kill) with a full queue | Windows — reuses the 23.5 gate |
| **Process kill** from Android recents / `am force-stop` | Android |
| Device reboot offline, reopen, keep selling, reconnect | both |
| Two devices, same low-stock item, both offline | both |
| Revoke while offline, then reconnect | both |
| 72-hour offline soak, then reconnect | both |
| Receipt uniqueness across 3 devices syncing simultaneously | both |
| Provisional → final receipt reprint | both |

---

## 21. Explicitly deferred complexity

Out of scope for 24.5 unless a product decision pulls one in:

- Distributed inventory reservation or per-device stock allocation.
- Preallocated receipt-number blocks (§8 option B).
- Offline refunds, voids, discounts or price overrides — no server contract
  exists for any of them.
- Offline tips (already rejected for devices server-side).
- Multi-device local mesh / peer sync.
- Background sync while the app is closed (Service Worker `SyncManager`) — the
  Electron and WebView stories differ and the benefit is small.
- Encryption at rest (§15) and any hardware-backed key storage.
- Conflict resolution UI beyond "here is what happened".
- Offline analytics or reporting on the till.
- Card gateway integration, which would change §10's answer.

---

## 22. Approved product decisions

All seven questions raised by the 24.4 design were **decided by the owner at the
24.4 review**. None is outstanding. They are recorded here as the authority 24.5
implements against; each is also written into the section that acts on it.

| # | Decision | APPROVED outcome | Implemented by | Section |
|---|---|---|---|---|
| 1 | Offline authorization lease | **7 days** from `lastVerifiedAt`, refreshed on every authoritative contact. One named constant. | 24.5A | §4.3 |
| 2 | Revocation | Offline sales occurring **before** `revoked_at` are **accepted and recorded**. Sales occurring **after** are **rejected and reported** to the owner. A **confirmed revoked device cannot reopen or re-enter the POS** after reconnect. | 24.5B, 24.5E | §13 |
| 3 | Card payments offline | **Allowed.** POS Canvas records the payment-method *label* only and does not authorize or process the card — online or offline — so queuing a card sale is exactly as truthful as recording one online. | 24.5E | §10 |
| 4 | Inventory | An offline sale is **never destroyed because current stock changed.** Floor tracked stock at 0 and record/flag the shortfall. | 24.5B | §9 |
| 5 | Unpair with an unsynced queue | **Blocked by default.** Queued sales are never silently deleted. Any future discard path must require explicit confirmation **showing the count**. | 24.5C | §15 |
| 6 | Provisional receipt copy | Approved customer-facing wording (`OFFLINE RECEIPT` / `Ref:` / "saved on this device and will sync when internet is restored" / "A final receipt number will be created after sync"). Must **not** imply the sale is invalid or unreal. | 24.5E | §8 |
| 7 | Owner Devices UI | **Yes** — per-device queue/sync status and pending-sale count, **read-only**. | 24.5E | §17 |

### Architecture clarification approved with them

**Both timestamps are preserved.** `occurred_at` (the validated time the device
says the sale happened) and `created_at` (the server time the sync was actually
recorded) are kept side by side; neither replaces the other. Obviously invalid
device clocks are **not silently trusted** — an unverifiable time leaves
`occurred_at` null and becomes a reconciliation / `needs_attention` case, and
never a reason to reject a real sale. See §6.1.

## 23. What 24.4 deliberately did not do

No offline runtime, no IndexedDB code, no queue, no migration, no RPC change, no
receipt change, no inventory change, no pairing or revocation change, no schema
change. `lib/offlineDesign.guards.test.ts` asserts this boundary.
