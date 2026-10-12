// v1.3 CP-2B item C — the wiring guards.
//
// Independent review's finding was that the authorization existed only in pure
// logic nothing called. These assert the opposite at the source level: the gate
// is consulted at the ACTION, before anything is written, and the screen cannot
// offer a control it has not been authorised for.
//
// This repository has no DOM environment and no React Testing Library, so
// component wiring is asserted here exactly as PosRuntime.layout.test.ts and
// modifierUx.guards.test.ts already do.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf-8");
const code = (src: string) =>
  src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const app = code(read("components/device/DeviceApp.tsx"));
const screen = code(read("components/device/RejectedSaleReview.tsx"));
const session = code(read("lib/saleQueueSession.ts"));
const rejected = code(read("lib/rejectedSaleSession.ts"));
const queue = code(read("lib/saleQueue.ts"));
const classifier = code(read("lib/saleSyncClassifier.ts"));

describe("authorization is enforced where the action happens", () => {
  it("opening the review screen resolves identity by itself (FIX 1)", () => {
    // THE DEADLOCK. Identity used to be refreshed only inside the two actions,
    // and the screen hides those while identity is unknown -- so an owner could
    // never reach the thing that would recognise them. Opening now asks.
    const body = app.slice(
      app.indexOf("async function openBlockedSaleReview("),
      app.indexOf("function closeBlockedSaleReview(")
    );

    expect(body).not.toBe("");

    const mint = body.indexOf("reviewerRequestRef.current = request;");
    const checking = body.indexOf('setReviewerGate({ status: "checking", request });');
    const read = body.indexOf("await readReviewerDecision()");
    const settle = body.indexOf("settleReviewerGate(previous, request, decision)");

    // Mint the request, show "checking", read, then settle against that request.
    expect(mint).toBeGreaterThan(-1);
    expect(checking).toBeGreaterThan(mint);
    expect(read).toBeGreaterThan(checking);
    expect(settle).toBeGreaterThan(read);
  });

  it("BOTH render paths open through that handler", () => {
    // Ready and revoked. A revoked till is exactly where blocked sales pile up.
    expect(app.match(/\(\) => void openBlockedSaleReview\(\)/g)).toHaveLength(2);

    // The screen is opened in exactly ONE place, and that place is the handler
    // that also asks who is signed in. A second `setReviewing(true)` anywhere
    // else would reintroduce a path that opens without resolving identity.
    expect(app.match(/setReviewing\(true\)/g)).toHaveLength(1);

    const handler = app.slice(
      app.indexOf("async function openBlockedSaleReview("),
      app.indexOf("function closeBlockedSaleReview(")
    );

    expect(handler).toContain("setReviewing(true);");
  });

  it("closing clears the permission and invalidates a read in flight", () => {
    const body = app.slice(
      app.indexOf("function closeBlockedSaleReview("),
      app.indexOf("async function handleReviewDecision(")
    );

    expect(body).not.toBe("");
    expect(body).toContain("reviewerRequestRef.current += 1;");
    expect(body).toContain("closeReviewerGate(previous)");
    expect(body).toContain("setReviewing(false)");
    expect(app.match(/onClose=\{closeBlockedSaleReview\}/g)).toHaveLength(2);
  });

  it("the gate starts idle, which authorises nothing", () => {
    expect(app).toContain("useState<ReviewerGate>(IDLE_REVIEWER_GATE)");
  });

  it("discard reads the live session and hands it to the mutation boundary", () => {
    const body = app.slice(
      app.indexOf("async function handleDiscard("),
      app.indexOf("async function handleRetry(") > app.indexOf("async function handleDiscard(")
        ? app.indexOf("async function handleRetry(")
        : app.length
    );

    const read = body.indexOf("await readReviewerDecision()");
    const act = body.indexOf("await discardRejectedSale(queueRecordId, reviewer)");

    expect(read).toBeGreaterThan(-1);
    expect(act).toBeGreaterThan(read);
  });

  it("there is NO pre-check deciding whether authorization applies (the race)", () => {
    // THE CORRECTED DEFECT. Asking first and discarding second let the stored
    // reason change in between, so the gate was applied on the strength of a
    // read that no longer described the record being written.
    expect(app).not.toContain("isRegisterBlockedSale");
    expect(app).not.toContain("registerBlocked");

    const body = app.slice(
      app.indexOf("async function handleDiscard("),
      app.indexOf("async function handleRetry(") > app.indexOf("async function handleDiscard(")
        ? app.indexOf("async function handleRetry(")
        : app.length
    );

    // The host does not branch on the reason at all any more.
    expect(body).not.toContain("lastErrorCode");
    expect(body).not.toContain("REGISTER_BLOCKED");
    expect(body).not.toContain("if (reviewer.allowed)");
  });

  it("the gate is applied inside the transaction that writes the record", () => {
    const body = rejected.slice(
      rejected.indexOf("export async function discardRejectedSale("),
      rejected.indexOf("export async function listRejectedSaleReviews(")
    );

    expect(body).not.toBe("");

    // One transaction: read, decide, write.
    expect(body).toContain("withQueueRecordMutation<DiscardRejectedSaleResult>(");

    const gate = body.indexOf(
      "record.lastErrorCode === REGISTER_BLOCKED_ERROR_CODE && reviewer?.allowed !== true"
    );
    const safety = body.indexOf("decideRejectedSaleDiscardSafety({ record, uncertain: evidence })");
    const commit = body.indexOf("commit: true");

    expect(gate).toBeGreaterThan(-1);
    expect(safety).toBeGreaterThan(gate);
    expect(commit).toBeGreaterThan(safety);
    expect(body).toContain('refuse("reviewer_not_permitted")');
  });

  it("the role is consulted ONLY for a register-blocked record (FIX 2 preserved)", () => {
    const body = rejected.slice(
      rejected.indexOf("export async function discardRejectedSale("),
      rejected.indexOf("export async function listRejectedSaleReviews(")
    );

    // The reviewer appears in exactly one condition, and that condition is
    // guarded by the stored reason.
    expect(body.match(/reviewer\?\.allowed/g)).toHaveLength(1);
    expect(body).toContain("record.lastErrorCode === REGISTER_BLOCKED_ERROR_CODE && reviewer?.allowed !== true");
  });

  it("the decision callback is synchronous, or the transaction would close", () => {
    const store = code(read("lib/deviceOfflineStore.ts"));
    const fn = store.slice(
      store.indexOf("export function withQueueRecordMutation<T>("),
      store.indexOf("function withStore<T>(")
    );

    expect(fn).not.toBe("");
    // An await inside the decision would let the transaction auto-commit and
    // reopen the very window this closes.
    expect(fn).not.toContain("await ");
    expect(fn).toContain('db.transaction([SALE_QUEUE_STORE, CACHE_STORE], "readwrite")');
    // The write is issued on the same transaction object that did the read.
    expect(fn).toContain("queueStore.put(outcome.record)");
  });

  it("the host still never touches a queue record", () => {
    expect(app).not.toContain("QueuedSale");
    expect(app).not.toContain("getQueuedSale");
  });

  it("recording a decision re-checks the live session first", () => {
    const body = app.slice(
      app.indexOf("async function handleReviewDecision("),
      app.indexOf("const recoverDailyContext")
    );

    expect(body).not.toBe("");
    expect(body.indexOf("await readReviewerDecision()")).toBeGreaterThan(-1);
    expect(body.indexOf("if (!decision.allowed) return decision.message;"))
      .toBeGreaterThan(body.indexOf("await readReviewerDecision()"));
    expect(body.indexOf("await recordBlockedSaleReview("))
      .toBeGreaterThan(body.indexOf("if (!decision.allowed)"));
  });

  it("identity is read from the existing session and fails closed", () => {
    const body = app.slice(
      app.indexOf("async function readReviewerDecision("),
      app.indexOf("async function openBlockedSaleReview(")
    );

    expect(body).toContain("await readEmployeeSession()");
    expect(body).toContain("decideBlockedSaleReviewer(");
    expect(body).toContain("read.ok ? read.session : null");
  });

  it("the host never touches a queue record to answer this", () => {
    // lib/offlineReadOnly.guards.test.ts holds this line; asserted here too so
    // a future edit sees the reason next to the code that respects it.
    expect(app).not.toContain("QueuedSale");
    expect(app).not.toContain("getQueuedSale");
  });

  it("both review screens receive the gate and the action", () => {
    expect(app.match(/reviewerGate=\{reviewerGate\}/g)).toHaveLength(2);
    expect(app.match(/onReviewDecision=\{handleReviewDecision\}/g)).toHaveLength(2);
    expect(app.match(/<RejectedSaleReview/g)).toHaveLength(2);
  });
});

describe("the screen cannot offer what it is not authorised for", () => {
  it("gates both decision controls on the gate's answer", () => {
    const block = screen.slice(
      screen.indexOf("data-blocked-review"),
      screen.indexOf("review.retry.allowed")
    );

    expect(block).not.toBe("");
    expect(block).toContain("checking ? (");
    expect(block).toContain("data-review-checking");
    expect(block).toContain(") : allowed ? (");
    expect(block).toContain("data-acknowledge");
    expect(block).toContain("data-escalate");
    // The refusal is shown instead of the controls, not beside them.
    expect(block).toContain("data-review-denied");
    expect(block).toContain("{refusal}");
  });

  it("offers the decision only for a register-blocked sale", () => {
    expect(screen).toContain("record.lastErrorCode === REGISTER_BLOCKED_ERROR_CODE");
  });

  it("never reports a save that did not happen", () => {
    // `return (` appears inside the runner's own helpers, so the slice is
    // bounded by the component's JSX return, which is the LAST one.
    const runner = screen.slice(
      screen.indexOf("async function run("),
      screen.lastIndexOf("return (")
    );

    expect(runner).not.toBe("");
    // Only a null message counts as recorded.
    expect(runner).toContain("setDecisionSaved(message === null ? queueRecordId : null);");
    expect(runner).toContain("setDecisionError(message);");
  });

  it("states that a recorded decision does not resolve the sale", () => {
    expect(screen).toContain("Decision recorded. This sale is still unresolved.");
    expect(screen).toContain("Recording a decision does not record the sale.");
  });
});

describe("what the reviewer is shown", () => {
  it("shows the original sale id and the CLAIMED register", () => {
    expect(screen).toContain('label="Sale ID" value={record.saleRequestId}');
    expect(screen).toContain('label="Claimed register"');
    expect(screen).toContain('record.registerSessionId ?? "None recorded"');
  });

  it("describes the payment honestly and never as verified cash", () => {
    // Independent review: an inferred flag must not read as confirmed cash.
    expect(screen).toContain('"Recorded as cash"');
    expect(screen).toContain("POS Canvas cannot confirm whether");
    expect(screen).not.toContain("cashCollected");
    expect(screen).not.toContain("Cash collected");
  });

  it("the inferred flag is named for what it is, everywhere", () => {
    for (const source of [queue, code(read("lib/blockedSaleReview.ts"))]) {
      expect(source).toContain("recordedAsCashPayment");
      expect(source).not.toContain("cashCollected");
    }
  });
});

describe("the persistence boundary verifies its own target", () => {
  it("checks sale identity, state and reason before appending", () => {
    const body = session.slice(
      session.indexOf("export async function recordBlockedSaleReview("),
      session.indexOf("export async function markAttempt(")
    );

    expect(body).not.toBe("");

    const mismatch = body.indexOf('reason: "sale_mismatch"');
    const blocked = body.indexOf('reason: "not_blocked"');
    const reason = body.indexOf('reason: "not_register_blocked"');
    const append = body.indexOf("appendBlockedSaleReview(");

    for (const index of [mismatch, blocked, reason]) {
      expect(index).toBeGreaterThan(-1);
      expect(append).toBeGreaterThan(index);
    }

    expect(body).toContain("parsed.record.saleRequestId !== entry.saleRequestId");
    expect(body).toContain('parsed.record.state !== "needs_attention"');
    expect(body).toContain("parsed.record.lastErrorCode !== REGISTER_BLOCKED_ERROR_CODE");
  });

  it("never writes, and never reports success, when the append refused", () => {
    const body = session.slice(
      session.indexOf("export async function recordBlockedSaleReview("),
      session.indexOf("export async function markAttempt(")
    );

    const refusal = body.indexOf("if (!annotated.ok) return { ok: false, reason: annotated.reason };");
    const write = body.indexOf("await putQueuedSale(");

    expect(refusal).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(refusal);
  });

  it("the cap refuses instead of dropping an entry", () => {
    const fn = queue.slice(
      queue.indexOf("export function appendBlockedSaleReview("),
      queue.length
    );

    expect(fn).toContain('return { ok: false, reason: "history_full" };');
    // The silent-drop shape is gone.
    expect(fn).not.toContain("slice(0, BLOCKED_SALE_REVIEW_TRAIL_LIMIT)");
    expect(fn).toContain("[...existing, entry]");
  });

  it("it is not a state transition: the sale stays where it was", () => {
    const body = session.slice(
      session.indexOf("export async function recordBlockedSaleReview("),
      session.indexOf("export async function markAttempt(")
    );

    for (const banned of [
      "transitionQueuedSale", "updateQueueState", "deleteQueuedSaleRecord",
      "markSynced", "serverOrderId", "registerSessionId =",
    ]) {
      expect(body).not.toContain(banned);
    }
  });

  it("the blocked-sale code agrees with the sync classifier", () => {
    // The queue layer restates the code rather than importing the classifier.
    // If they ever disagree, this fails instead of the feature silently
    // refusing every real blocked sale.
    expect(session).toContain('export const REGISTER_BLOCKED_ERROR_CODE = "register_unverified";');
    expect(classifier).toContain(
      '"A register session is required for an offline sale": "register_unverified",'
    );
  });
});
