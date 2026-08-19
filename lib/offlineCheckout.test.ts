// Feature 24.5E — the offline checkout decision, exhaustively.
//
// Pure, so every refusal is reachable here: a tampered digest, a clock in the
// future, a cache belonging to another business, a build the app is no longer
// pinned to. Several of these are close to impossible to produce on real
// hardware, which is exactly why they are worth a test.
import { describe, expect, it } from "vitest";
import {
  OFFLINE_CHECKOUT_BLOCKED_MESSAGES,
  OFFLINE_CHECKOUT_PREPARING_MESSAGE,
  buildOfflineEnqueueInput,
  decideOfflineCheckoutSession,
  decideOfflineSaleEligibility,
  resolveOfflineSaleDraft,
} from "@/lib/offlineCheckout";
import type {
  OfflineCheckoutBlockedReason,
  OfflineCheckoutSession,
  OfflineSaleDraft,
} from "@/lib/offlineCheckout";
import {
  OFFLINE_DEVICE_LEASE_MS,
  buildPairingAssertion,
  buildPinnedConfigRecord,
} from "@/lib/deviceOfflineCache";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import { cloneProjectConfig, defaultProjectConfig } from "@/lib/projectConfig";
import { createCartItem } from "@/lib/cart";
import type { CartItem } from "@/lib/cart";
import type { DevicePairing } from "@/lib/deviceSession";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUILD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_BUILD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DEVICE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const VERIFIED_AT = "2026-08-18T09:00:00.000Z";
const NOW = Date.parse("2026-08-18T12:00:00.000Z");

const project = cloneProjectConfig(defaultProjectConfig);
const config = createGeneratedPosConfig(
  { projectId: PROJECT, projectName: "Cafe A", templateId: "restaurant", config: project },
  { generatedAt: VERIFIED_AT }
);

const runtimePairing: DevicePairing = {
  deviceId: DEVICE,
  projectId: PROJECT,
  buildJobId: BUILD,
  deviceName: "POS Device",
  platform: "windows",
  createdAt: null,
  revokedAt: null,
};

function assertion(overrides: Record<string, unknown> = {}) {
  return {
    ...buildPairingAssertion({
      deviceAuthUserId: USER,
      deviceId: DEVICE,
      projectId: PROJECT,
      buildJobId: BUILD,
      deviceName: "POS Device",
      platform: "windows",
      verifiedAt: VERIFIED_AT,
    }),
    ...overrides,
  };
}

async function pinned(overrides: Record<string, unknown> = {}) {
  const record = await buildPinnedConfigRecord({
    deviceAuthUserId: USER,
    projectId: PROJECT,
    buildJobId: BUILD,
    config,
    verifiedAt: VERIFIED_AT,
  });

  return { ...record!, ...overrides };
}

async function decide(
  overrides: {
    assertionRecord?: unknown;
    configRecord?: unknown;
    runtime?: DevicePairing;
    sessionUserId?: string;
    now?: number;
    queueAvailable?: boolean;
  } = {}
) {
  return decideOfflineCheckoutSession({
    now: overrides.now ?? NOW,
    sessionUserId: overrides.sessionUserId ?? USER,
    runtime: overrides.runtime ?? runtimePairing,
    // `in` rather than ??, so an explicit null (the "no cache" case) is passed
    // through instead of silently falling back to a valid record.
    assertionRecord:
      "assertionRecord" in overrides ? overrides.assertionRecord : assertion(),
    configRecord: "configRecord" in overrides ? overrides.configRecord : await pinned(),
    queueAvailable: overrides.queueAvailable ?? true,
  });
}

async function expectBlocked(
  overrides: Parameters<typeof decide>[0],
  reason: OfflineCheckoutBlockedReason
) {
  const decision = await decide(overrides);

  expect(decision.ok).toBe(false);

  if (decision.ok) return;

  expect(decision.reason).toBe(reason);
  expect(OFFLINE_CHECKOUT_BLOCKED_MESSAGES[decision.reason]).toBeTruthy();
}

const session: OfflineCheckoutSession = {
  deviceAuthUserId: USER,
  deviceId: DEVICE,
  projectId: PROJECT,
  buildJobId: BUILD,
  lastVerifiedAt: VERIFIED_AT,
  leaseExpiresAt: new Date(Date.parse(VERIFIED_AT) + OFFLINE_DEVICE_LEASE_MS).toISOString(),
};

function cart(): CartItem[] {
  return [createCartItem(project.menuItems[0], [], 2)];
}

const MODIFIER_GROUPS = [
  {
    id: "g-extras",
    name: "Extras",
    selection: "multiple" as const,
    required: false,
    maxSelections: null,
    options: [{ id: "o-bacon", name: "Extra bacon", priceAdjustment: 1.5 }],
  },
];

// ---------------------------------------------------------------------------
// The session decision
// ---------------------------------------------------------------------------

describe("an eligible offline session may check out", () => {
  it("accepts a valid cache belonging to this device", async () => {
    const decision = await decide();

    expect(decision.ok).toBe(true);

    if (!decision.ok) return;

    expect(decision.session.projectId).toBe(PROJECT);
    expect(decision.session.buildJobId).toBe(BUILD);
    expect(decision.session.deviceId).toBe(DEVICE);
    expect(decision.session.deviceAuthUserId).toBe(USER);
    // The pinned snapshot comes back so the caller prices from it and nothing
    // else — the same bytes the server will price from at sync.
    expect(decision.config.project.projectId).toBe(PROJECT);
  });
});

describe("every requirement is genuinely enforced", () => {
  it("blocks when the 7-day lease has expired", async () => {
    await expectBlocked(
      { now: Date.parse(VERIFIED_AT) + OFFLINE_DEVICE_LEASE_MS + 60_000 },
      "lease_expired"
    );
  });

  it("blocks when the clock says the cache was verified in the future", async () => {
    await expectBlocked({ now: Date.parse(VERIFIED_AT) - 60 * 60 * 1000 }, "clock_invalid");
  });

  it("blocks when there is no cached pairing assertion at all", async () => {
    await expectBlocked({ assertionRecord: null }, "no_cache");
  });

  it("blocks when the cached configuration is missing", async () => {
    await expectBlocked({ configRecord: null }, "no_cache");
  });

  it("blocks when the cached configuration's integrity check fails", async () => {
    // A snapshot edited in place: the stored digest no longer describes it.
    const tampered = await pinned();

    tampered.configSnapshot = {
      ...tampered.configSnapshot,
      menuItems: tampered.configSnapshot.menuItems.map((item, index) =>
        index === 0 ? { ...item, price: 0.01 } : item
      ),
    };

    await expectBlocked({ configRecord: tampered }, "cache_corrupt");
  });

  it("blocks when the cache belongs to a different auth user", async () => {
    await expectBlocked({ sessionUserId: OTHER_USER }, "identity_mismatch");
  });

  it("blocks when the cache describes a different build than the app is running", async () => {
    await expectBlocked(
      { runtime: { ...runtimePairing, buildJobId: OTHER_BUILD } },
      "identity_mismatch"
    );
  });

  it("blocks when the cache describes a different device", async () => {
    await expectBlocked(
      { runtime: { ...runtimePairing, deviceId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } },
      "identity_mismatch"
    );
  });

  it("blocks a device this app already knows is revoked", async () => {
    await expectBlocked(
      { runtime: { ...runtimePairing, revokedAt: "2026-08-18T10:00:00.000Z" } },
      "device_revoked"
    );
  });

  it("blocks when the durable queue cannot be used", async () => {
    // No durable queue means no way to make a sale durable, and there is no
    // memory-only fallback anywhere beneath this.
    await expectBlocked({ queueAvailable: false }, "queue_unavailable");
  });
});

// ---------------------------------------------------------------------------
// The per-sale decision
// ---------------------------------------------------------------------------

describe("the per-sale checks", () => {
  it("accepts a normal cash sale", () => {
    expect(
      decideOfflineSaleEligibility({ session, cart: cart(), paymentMethod: "cash", now: NOW })
    ).toEqual({ ok: true });
  });

  it("accepts a card sale — POS Canvas records a label, not an authorization", () => {
    expect(
      decideOfflineSaleEligibility({ session, cart: cart(), paymentMethod: "card", now: NOW })
    ).toEqual({ ok: true });
  });

  it("refuses an empty cart", () => {
    const decision = decideOfflineSaleEligibility({
      session,
      cart: [],
      paymentMethod: "cash",
      now: NOW,
    });

    expect(decision).toEqual({ ok: false, reason: "empty_cart" });
  });

  it("refuses a payment method the server would not accept", () => {
    const decision = decideOfflineSaleEligibility({
      session,
      cart: cart(),
      paymentMethod: null,
      now: NOW,
    });

    expect(decision).toEqual({ ok: false, reason: "unsupported_payment_method" });
  });

  it("re-checks the lease at the moment of sale, not only at startup", () => {
    // A till left open past the seventh day.
    const decision = decideOfflineSaleEligibility({
      session,
      cart: cart(),
      paymentMethod: "cash",
      now: Date.parse(VERIFIED_AT) + OFFLINE_DEVICE_LEASE_MS + 1_000,
    });

    expect(decision).toEqual({ ok: false, reason: "lease_expired" });
  });

  it("never refuses a sale over local stock", () => {
    // The device's cached stock says 20; the cart asks for 500. The money is
    // already in the drawer, and destroying the record to protect a stock
    // number is the trade docs/OFFLINE_ARCHITECTURE.md §9 refuses to make.
    const oversized = [createCartItem(project.menuItems[0], [], 500)];

    expect(
      decideOfflineSaleEligibility({ session, cart: oversized, paymentMethod: "cash", now: NOW })
    ).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

describe("a sale's identity is minted once and frozen", () => {
  let seq = 0;
  const generate = () => {
    seq += 1;

    return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  };

  function draft(current: OfflineSaleDraft | null, items = cart(), now = NOW) {
    return resolveOfflineSaleDraft({
      current,
      projectId: PROJECT,
      paymentMethod: "cash",
      tipAmount: 0,
      cart: items,
      now,
      generate,
    });
  }

  it("creates exactly one request id and one sale time", () => {
    const first = draft(null);

    expect(first.ok).toBe(true);

    if (!first.ok) return;

    expect(first.draft.saleRequestId).not.toBe(first.draft.queueRecordId);
    expect(first.draft.occurredAt).toBe(new Date(NOW).toISOString());
  });

  it("reuses both on a retry of the SAME cart", () => {
    const first = draft(null);

    expect(first.ok).toBe(true);

    if (!first.ok) return;

    // A later clock, as a real retry would have.
    const retry = draft(first.draft, cart(), NOW + 90_000);

    expect(retry.ok).toBe(true);

    if (!retry.ok) return;

    expect(retry.draft).toEqual(first.draft);
    expect(retry.draft.occurredAt).toBe(first.draft.occurredAt);
  });

  it("mints a new identity when the cart changes", () => {
    const first = draft(null);

    expect(first.ok).toBe(true);

    if (!first.ok) return;

    const changed = draft(first.draft, [
      ...cart(),
      createCartItem(project.menuItems[1], [], 1),
    ]);

    expect(changed.ok).toBe(true);

    if (!changed.ok) return;

    expect(changed.draft.saleRequestId).not.toBe(first.draft.saleRequestId);
  });

  it("mints a new identity when the payment method changes", () => {
    // createSaleFingerprint covers projectId | paymentMethod | tipAmount |
    // sorted(lineKey=quantity), which is exactly what complete_sale_v4 hashes.
    // Switching cash -> card before the write is a materially different request
    // and must not inherit the previous idempotency key, or the server would
    // reject the survivor as a hash conflict.
    const first = draft(null);

    expect(first.ok).toBe(true);

    if (!first.ok) return;

    const asCard = resolveOfflineSaleDraft({
      current: first.draft,
      projectId: PROJECT,
      paymentMethod: "card",
      tipAmount: 0,
      cart: cart(),
      now: NOW + 10_000,
      generate,
    });

    expect(asCard.ok).toBe(true);

    if (!asCard.ok) return;

    expect(asCard.draft.saleRequestId).not.toBe(first.draft.saleRequestId);
    expect(asCard.draft.occurredAt).not.toBe(first.draft.occurredAt);
  });

  it("mints a new identity when the tip changes", () => {
    // Devices may not tip today — complete_sale_v4 rejects a non-zero device
    // tip and the queue refuses to store one — so this cannot fire in the
    // current product. It is asserted anyway because the tip IS part of the
    // server's canonical hash, and a surface that ever gains tip entry must
    // inherit correct retry semantics rather than discover them.
    const first = draft(null);

    expect(first.ok).toBe(true);

    if (!first.ok) return;

    const tipped = resolveOfflineSaleDraft({
      current: first.draft,
      projectId: PROJECT,
      paymentMethod: "cash",
      tipAmount: 1,
      cart: cart(),
      now: NOW,
      generate,
    });

    expect(tipped.ok).toBe(true);

    if (!tipped.ok) return;

    expect(tipped.draft.saleRequestId).not.toBe(first.draft.saleRequestId);
  });

  it("mints a new identity when a modifier selection changes", () => {
    const plain = draft(null);

    expect(plain.ok).toBe(true);

    if (!plain.ok) return;

    const withExtras = resolveOfflineSaleDraft({
      current: plain.draft,
      projectId: PROJECT,
      paymentMethod: "cash",
      tipAmount: 0,
      cart: [
        createCartItem(
          { ...project.menuItems[0], modifierGroups: MODIFIER_GROUPS },
          [
            {
              groupId: "g-extras",
              groupName: "Extras",
              options: [{ id: "o-bacon", name: "Extra bacon", priceAdjustment: 1.5 }],
            },
          ],
          2
        ),
      ],
      now: NOW,
      generate,
    });

    expect(withExtras.ok).toBe(true);

    if (!withExtras.ok) return;

    expect(withExtras.draft.saleRequestId).not.toBe(plain.draft.saleRequestId);
  });

  it("does NOT mint a new identity for a cosmetic reordering", () => {
    // lineKey is the canonical (product + selection) identity, so reordering
    // the cart is the same request and must keep one key — otherwise an
    // ordinary retry would be rejected by the server as a mismatch.
    const twoLines = [
      createCartItem(project.menuItems[0], [], 1),
      createCartItem(project.menuItems[1], [], 1),
    ];
    const first = draft(null, twoLines);

    expect(first.ok).toBe(true);

    if (!first.ok) return;

    const reordered = draft(first.ok ? first.draft : null, [twoLines[1], twoLines[0]]);

    expect(reordered.ok).toBe(true);

    if (!reordered.ok) return;

    expect(reordered.draft.saleRequestId).toBe(first.draft.saleRequestId);
  });

  it("refuses rather than falling back to a weak id generator", () => {
    const refused = resolveOfflineSaleDraft({
      current: null,
      projectId: PROJECT,
      paymentMethod: "cash",
      tipAmount: 0,
      cart: cart(),
      now: NOW,
      generate: () => {
        throw new Error("Secure checkout is unavailable in this browser.");
      },
    });

    expect(refused).toEqual({ ok: false, reason: "insecure_browser" });
  });
});

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

describe("what gets written carries no price and no client authority", () => {
  const draft: OfflineSaleDraft = {
    saleRequestId: "7a4b2c9d-1e3f-4a5b-8c6d-9e0f1a2b3c4d",
    queueRecordId: "local-1",
    occurredAt: "2026-08-18T11:59:00.000Z",
    fingerprint: "f",
  };

  it("sends identifiers and quantities only", () => {
    const input = buildOfflineEnqueueInput({
      draft,
      session,
      cart: cart(),
      paymentMethod: "cash",
      now: NOW,
    });

    expect(input.items).toEqual([{ itemId: "1", quantity: 2, modifiers: [] }]);

    const serialized = JSON.stringify(input);

    for (const banned of ["price", "basePrice", "lineKey", "name", "subtotal", "total"]) {
      expect(`payload carries ${banned}`).toBe(`payload carries ${banned}`);
      expect(serialized).not.toContain(banned);
    }
  });

  it("takes its authorization context from the validated session", () => {
    const input = buildOfflineEnqueueInput({
      draft,
      session,
      cart: cart(),
      paymentMethod: "card",
      now: NOW,
    });

    expect(input.deviceAuthUserId).toBe(USER);
    expect(input.deviceId).toBe(DEVICE);
    expect(input.projectId).toBe(PROJECT);
    expect(input.buildJobId).toBe(BUILD);
    expect(input.saleRequestId).toBe(draft.saleRequestId);
    expect(input.queueRecordId).toBe(draft.queueRecordId);
    expect(input.occurredAt).toBe(draft.occurredAt);
    expect(input.paymentMethod).toBe("card");
  });
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

describe("every refusal is explained in the operator's language", () => {
  it("names no database, schema, version or queue", () => {
    const copy = [
      ...Object.values(OFFLINE_CHECKOUT_BLOCKED_MESSAGES),
      OFFLINE_CHECKOUT_PREPARING_MESSAGE,
    ];

    for (const message of copy) {
      for (const banned of [
        "indexeddb",
        "queue",
        "schema",
        "version",
        "rpc",
        "supabase",
        "error",
        "failed",
      ]) {
        expect(`"${message}" says ${banned}`).toBe(`"${message}" says ${banned}`);
        expect(message.toLowerCase()).not.toContain(banned);
      }

      expect(message.length).toBeGreaterThan(20);
    }
  });

  it("covers every reason, so no refusal can reach an operator unexplained", () => {
    const reasons: OfflineCheckoutBlockedReason[] = [
      "no_cache",
      "identity_mismatch",
      "lease_expired",
      "clock_invalid",
      "cache_corrupt",
      "storage_unavailable",
      "device_revoked",
      "queue_unavailable",
      "empty_cart",
      "unsupported_payment_method",
      "insecure_browser",
    ];

    expect(Object.keys(OFFLINE_CHECKOUT_BLOCKED_MESSAGES).sort()).toEqual([...reasons].sort());
  });
});
