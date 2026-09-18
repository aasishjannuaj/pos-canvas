// v1.3 Feature 1B-RUNTIME — offline historical attribution, end to end through
// the durable queue and the sync adapter.
//
// THE BACKWARD-COMPATIBILITY PROOF LIVES HERE. The Control Room allowed the two
// claim fields to be added WITHOUT an envelope-version bump only if old records
// still deserialize, still sync, and are never discarded for lacking them.
// Every one of those is asserted below against the real reader and the real
// adapter.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SALE_QUEUE_SCHEMA_VERSION,
  SALE_REQUEST_PAYLOAD_VERSION,
  readQueuedSale,
} from "@/lib/saleQueue";
import type { QueuedSale } from "@/lib/saleQueue";
import { buildOfflineEnqueueInput } from "@/lib/offlineCheckout";
import { isEquivalentOfflineSale } from "@/lib/offlineCheckout";
import { submitQueuedSale } from "@/lib/offlineSaleRpc";

const repoRoot = join(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(join(repoRoot, relative), "utf-8");

/** A queue record exactly as a pre-Feature-1B till would have written it. */
const LEGACY_RECORD = {
  queueSchemaVersion: SALE_QUEUE_SCHEMA_VERSION,
  requestPayloadVersion: SALE_REQUEST_PAYLOAD_VERSION,
  queueRecordId: "queue-1",
  saleRequestId: "11111111-1111-4111-8111-111111111111",
  deviceAuthUserId: "auth-1",
  deviceId: "device-1",
  projectId: "project-1",
  buildJobId: "build-1",
  paymentMethod: "cash",
  tipAmount: 0,
  items: [{ itemId: "item-1", quantity: 2, modifiers: [] }],
  occurredAt: "2026-09-18T02:00:00.000Z",
  source: "offline_queued",
  state: "pending",
  queuedAt: "2026-09-18T02:00:00.000Z",
  updatedAt: "2026-09-18T02:00:00.000Z",
  attemptCount: 0,
  lastAttemptAt: null,
  nextAttemptAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  serverOrderId: null,
  serverOrderNumber: null,
  serverCreatedAt: null,
  // NOTE: no employeePosSessionId, no registerSessionId. That is the point.
} as const;

describe("old queue records survive the claim fields", () => {
  it("1. a record written before Feature 1B still deserializes", () => {
    const result = readQueuedSale(LEGACY_RECORD);

    expect(result.ok).toBe(true);
  });

  it("2. its missing claims read back as null, not undefined", () => {
    const result = readQueuedSale(LEGACY_RECORD);

    expect(result.ok === true && result.record.employeePosSessionId).toBeNull();
    expect(result.ok === true && result.record.registerSessionId).toBeNull();
  });

  it("3+4. it is not discarded, and keeps every financial field", () => {
    const result = readQueuedSale(LEGACY_RECORD);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.record.state).toBe("pending");
      expect(result.record.occurredAt).toBe(LEGACY_RECORD.occurredAt);
      expect(result.record.items).toEqual(LEGACY_RECORD.items);
      expect(result.record.tipAmount).toBe(0);
    }
  });

  it("5. its sale_request_id is untouched", () => {
    const result = readQueuedSale(LEGACY_RECORD);

    expect(result.ok === true && result.record.saleRequestId).toBe(LEGACY_RECORD.saleRequestId);
  });

  it("the envelope version did NOT move, which is why the record is still readable", () => {
    expect(SALE_QUEUE_SCHEMA_VERSION).toBe(1);
    expect(SALE_REQUEST_PAYLOAD_VERSION).toBe(4);
    expect(readQueuedSale({ ...LEGACY_RECORD, queueSchemaVersion: 2 }).ok).toBe(false);
  });

  it("a garbage claim is read as absent rather than trusted", () => {
    const result = readQueuedSale({ ...LEGACY_RECORD, employeePosSessionId: 42, registerSessionId: "" });

    expect(result.ok === true && result.record.employeePosSessionId).toBeNull();
    expect(result.ok === true && result.record.registerSessionId).toBeNull();
  });
});

describe("claims are captured but stay outside the financial payload", () => {
  const draft = {
    saleRequestId: "22222222-2222-4222-8222-222222222222",
    queueRecordId: "queue-2",
    occurredAt: "2026-09-18T02:10:00.000Z",
    cartSignature: "sig",
    fingerprint: "fingerprint-1",
  };
  const session = {
    deviceAuthUserId: "auth-1",
    deviceId: "device-1",
    projectId: "project-1",
    buildJobId: "build-1",
    lastVerifiedAt: "2026-09-18T01:00:00.000Z",
    leaseExpiresAt: "2026-09-25T01:00:00.000Z",
  };
  // CartItem's own field names: buildSaleRequestItems reads itemId, quantity
  // and modifier selections, and nothing else may cross the wire.
  const cart = [
    { itemId: "item-1", name: "Coffee", unitPrice: 3.5, quantity: 2, modifiers: [] },
  ] as never;

  it("the enqueue input carries both claims", () => {
    const input = buildOfflineEnqueueInput({
      draft,
      session,
      cart,
      paymentMethod: "cash",
      now: 1,
      claims: { employeePosSessionId: "sess-ada", registerSessionId: "reg-1" },
    });

    expect(input.employeePosSessionId).toBe("sess-ada");
    expect(input.registerSessionId).toBe("reg-1");
  });

  it("a till with nothing established claims nothing", () => {
    const input = buildOfflineEnqueueInput({ draft, session, cart, paymentMethod: "cash", now: 1 });

    expect(input.employeePosSessionId).toBeNull();
    expect(input.registerSessionId).toBeNull();
  });

  it("claims take no part in financial equivalence", () => {
    // The same cart, rung by two different operators, is the same sale. If
    // claims entered equivalence, a retry after a switch would look like a
    // DIFFERENT sale holding the same idempotency key — the one thing that
    // turns a crash-and-retry into a double charge.
    const attempted = buildOfflineEnqueueInput({
      draft,
      session,
      cart,
      paymentMethod: "cash",
      now: 1,
      claims: { employeePosSessionId: "sess-ada", registerSessionId: "reg-1" },
    });

    // The SAME sale already on disk, claimed by somebody else entirely.
    const stored = readQueuedSale({
      ...LEGACY_RECORD,
      queueRecordId: attempted.queueRecordId,
      saleRequestId: attempted.saleRequestId,
      occurredAt: attempted.occurredAt,
      deviceAuthUserId: attempted.deviceAuthUserId,
      deviceId: attempted.deviceId,
      projectId: attempted.projectId,
      buildJobId: attempted.buildJobId,
      paymentMethod: attempted.paymentMethod,
      items: attempted.items,
      employeePosSessionId: "sess-bo",
      registerSessionId: "reg-9",
    });

    expect(stored.ok).toBe(true);
    expect(stored.ok === true && isEquivalentOfflineSale(stored.record, attempted)).toBe(true);
  });
});

describe("the sync adapter submits complete_sale_v5", () => {
  const record = {
    ...LEGACY_RECORD,
    items: LEGACY_RECORD.items.map((item) => ({ ...item, modifiers: [...item.modifiers] })),
    employeePosSessionId: "sess-ada",
    registerSessionId: "reg-1",
  } as unknown as QueuedSale;

  async function captureArgs(target: QueuedSale) {
    const rpc = vi.fn().mockResolvedValue({
      data: { orderId: "order-1", orderNumber: "A-1", total: "7.70", items: [] },
      error: null,
    });

    await submitQueuedSale(target, { rpc });

    return rpc.mock.calls[0][0] as Record<string, unknown>;
  }

  it("sends NO p_project_id — the server derives the project from the device", async () => {
    const args = await captureArgs(record);

    expect(args).not.toHaveProperty("p_project_id");
  });

  it("sends the claims as claims", async () => {
    const args = await captureArgs(record);

    expect(args.p_employee_pos_session_id).toBe("sess-ada");
    expect(args.p_register_session_id).toBe("reg-1");
  });

  it("sends nulls for a record that claimed nothing, and still submits it", async () => {
    const legacy = readQueuedSale(LEGACY_RECORD);

    expect(legacy.ok).toBe(true);

    if (legacy.ok) {
      const args = await captureArgs(legacy.record);

      expect(args.p_employee_pos_session_id).toBeNull();
      expect(args.p_register_session_id).toBeNull();
      // 6. Financially unchanged, which is what keeps an old record syncable.
      expect(args.p_sale_request_id).toBe(LEGACY_RECORD.saleRequestId);
      expect(args.p_occurred_at).toBe(LEGACY_RECORD.occurredAt);
      expect(args.p_source).toBe("offline_queued");
      expect(args.p_tip_amount).toBe(0);
      expect(args.p_items).toEqual([{ itemId: "item-1", quantity: 2, modifiers: [] }]);
    }
  });

  it("7. a retry sends the SAME persisted key, so the server replays instead of double-selling", async () => {
    const first = await captureArgs(record);
    const second = await captureArgs({ ...record, attemptCount: 3 });

    expect(second.p_sale_request_id).toBe(first.p_sale_request_id);
    expect(second.p_sale_request_id).toBe(record.saleRequestId);
  });
});

describe("the adapter's own source keeps the financial contract", () => {
  const adapter = read("lib/offlineSaleRpc.ts");

  it("calls v5 and nothing else", () => {
    expect(adapter).toContain('rpc("complete_sale_v5"');
    expect(adapter).not.toContain('rpc("complete_sale_v4"');
  });

  it("passes no project id", () => {
    // Matched as an ARGUMENT KEY: the module's own comment explains why the key
    // is gone, and a prose mention must not read as a live argument.
    expect(adapter).not.toMatch(/p_project_id\s*:/);
  });

  it("reads the persisted key, occurred_at and source straight off the record", () => {
    expect(adapter).toContain("p_sale_request_id: record.saleRequestId");
    expect(adapter).toContain("p_occurred_at: record.occurredAt");
    expect(adapter).toContain("p_source: record.source");
  });
});
