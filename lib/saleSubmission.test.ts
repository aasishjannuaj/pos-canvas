// Feature 18.2 Phase 5A — behavioral tests for the shared checkout-submission
// rules.
//
// These are the rules the Builder Preview and the POS runtime now provably
// share. Everything here is pure, so it runs under plain Node exactly like
// lib/cart.test.ts and lib/saleRequest.test.ts.
import { describe, expect, it } from "vitest";
import {
  SALE_INSECURE_BROWSER_MESSAGE,
  SALE_INSUFFICIENT_STOCK_MESSAGE,
  SALE_UNCONFIRMED_MESSAGE,
  buildSaleRequestItems,
  createUncertainSale,
  decideUncertainSale,
  hasInsufficientStock,
  planSaleSubmission,
  toCompletedOrder,
} from "@/lib/saleSubmission";
import type { UncertainSale } from "@/lib/saleSubmission";
import { createSaleFingerprint } from "@/lib/saleRequest";
import { canonicalLineIdentity } from "@/lib/modifiers";
import { createCartItem } from "@/lib/cart";
import type { CartItem, CartModifierSelection } from "@/lib/cart";
import type { CompletedSaleReceipt } from "@/lib/completedSale";
import type { MenuItem } from "@/lib/projectConfig";
import type { SaleRequestState } from "@/lib/saleRequest";
import {
  SALE_AUTHORIZATION_MESSAGES,
  decideSaleAuthorization,
} from "@/components/runtime/PosRuntime";
import type { HostAuthoritySnapshot } from "@/components/runtime/PosRuntime";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function menuItem(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: "item-1",
    name: "Latte",
    price: 4,
    category: "Drinks",
    trackInventory: false,
    stockQuantity: 0,
    modifierGroups: [],
    ...overrides,
  } as MenuItem;
}

const MILK: CartModifierSelection = {
  groupId: "group-milk",
  groupName: "Milk",
  options: [{ id: "option-oat", name: "Oat", priceAdjustment: 0.6 }],
};

const SYRUP: CartModifierSelection = {
  groupId: "group-syrup",
  groupName: "Syrup",
  options: [
    { id: "option-vanilla", name: "Vanilla", priceAdjustment: 0.5 },
    { id: "option-hazelnut", name: "Hazelnut", priceAdjustment: 0.5 },
  ],
};

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const REQUEST_ID = "22222222-2222-2222-2222-222222222222";

// ---------------------------------------------------------------------------
// buildSaleRequestItems — the money-safety boundary
// ---------------------------------------------------------------------------

describe("buildSaleRequestItems sends identifiers only", () => {
  it("carries itemId, quantity and modifier ids, and nothing else", () => {
    const cart = [createCartItem(menuItem(), [MILK, SYRUP], 2)];

    expect(buildSaleRequestItems(cart)).toEqual([
      {
        itemId: "item-1",
        quantity: 2,
        modifiers: [
          { groupId: "group-milk", optionIds: ["option-oat"] },
          { groupId: "group-syrup", optionIds: ["option-vanilla", "option-hazelnut"] },
        ],
      },
    ]);
  });

  it("drops every display name and price adjustment", () => {
    const payload = JSON.stringify(buildSaleRequestItems([
      createCartItem(menuItem(), [MILK, SYRUP]),
    ]));

    // The exact leak this whole contract exists to prevent: a client-chosen
    // amount, or a name the server would otherwise have to trust.
    for (const leaked of ["Oat", "Vanilla", "Milk", "Syrup", "Latte", "0.6", "priceAdjustment"]) {
      expect(payload).not.toContain(leaked);
    }
  });

  it("never sends the client's unit price, base price or line identity", () => {
    const cart = [createCartItem(menuItem({ price: 4 }), [MILK])];
    const [line] = buildSaleRequestItems(cart);

    // lineKey is client-side cart identity; complete_sale_v3 recomputes the
    // canonical identity from the request and would not trust a supplied one.
    expect(Object.keys(line).sort()).toEqual(["itemId", "modifiers", "quantity"]);
    expect(cart[0].price).toBe(4.6);
  });

  it("omits a group with no chosen options", () => {
    const empty: CartModifierSelection = {
      groupId: "group-size",
      groupName: "Size",
      options: [],
    };

    expect(buildSaleRequestItems([createCartItem(menuItem(), [empty, MILK])])).toEqual([
      { itemId: "item-1", quantity: 1, modifiers: [{ groupId: "group-milk", optionIds: ["option-oat"] }] },
    ]);
  });

  it("a plain item still sends an empty modifier list", () => {
    // Backward compatibility: a product authored before Feature 18 must submit
    // exactly as it always did, with `modifiers` present but empty.
    expect(buildSaleRequestItems([createCartItem(menuItem(), [])])).toEqual([
      { itemId: "item-1", quantity: 1, modifiers: [] },
    ]);
  });

  it("keeps two selections of one product as two independent lines", () => {
    const cart = [
      createCartItem(menuItem(), [MILK]),
      createCartItem(menuItem(), [SYRUP]),
    ];

    const payload = buildSaleRequestItems(cart);
    expect(payload).toHaveLength(2);
    expect(payload[0].itemId).toBe(payload[1].itemId);
    expect(payload[0].modifiers).not.toEqual(payload[1].modifiers);
  });
});

// ---------------------------------------------------------------------------
// hasInsufficientStock — per PRODUCT, not per line
// ---------------------------------------------------------------------------

describe("hasInsufficientStock counts the whole product", () => {
  const tracked = menuItem({ trackInventory: true, stockQuantity: 3 });

  it("allows a cart within stock", () => {
    const cart = [createCartItem(tracked, [MILK], 2)];
    expect(hasInsufficientStock(cart, [tracked])).toBe(false);
  });

  it("sums two modifier lines of the same product against one pool", () => {
    // 2 + 2 = 4 against a stock of 3. Validating each line separately would
    // wrongly pass, and the server would then reject the sale.
    const cart = [
      createCartItem(tracked, [MILK], 2),
      createCartItem(tracked, [SYRUP], 2),
    ];

    expect(hasInsufficientStock(cart, [tracked])).toBe(true);
  });

  it("ignores untracked products entirely", () => {
    const untracked = menuItem({ trackInventory: false, stockQuantity: 0 });
    expect(hasInsufficientStock([createCartItem(untracked, [], 99)], [untracked])).toBe(false);
  });

  it("skips a line whose product the local menu no longer knows", () => {
    // The server is the authority and will reject it if genuinely unsellable;
    // blocking locally would strand a cart the operator cannot fix.
    expect(hasInsufficientStock([createCartItem(menuItem(), [])], [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planSaleSubmission
// ---------------------------------------------------------------------------

describe("planSaleSubmission", () => {
  const tracked = menuItem({ trackInventory: true, stockQuantity: 1 });

  function plan(
    cart: CartItem[],
    current: SaleRequestState | null = null,
    generate: () => string = () => REQUEST_ID
  ) {
    return planSaleSubmission({
      projectId: PROJECT_ID,
      paymentMethod: "cash",
      tipAmount: 0,
      cart,
      menuItems: [tracked],
      current,
      generate,
    });
  }

  it("refuses a cart that exceeds stock, before any id is issued", () => {
    const result = plan([createCartItem(tracked, [], 5)]);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(SALE_INSUFFICIENT_STOCK_MESSAGE);
  });

  it("returns the request id and the identifiers-only payload", () => {
    const result = plan([createCartItem(tracked, [MILK])]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.request.id).toBe(REQUEST_ID);
    expect(result.items).toEqual([
      { itemId: "item-1", quantity: 1, modifiers: [{ groupId: "group-milk", optionIds: ["option-oat"] }] },
    ]);
  });

  it("reuses the id when the cart is unchanged, so a retry replays", () => {
    const first = plan([createCartItem(tracked, [MILK])]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const retry = plan([createCartItem(tracked, [MILK])], first.request, () => {
      throw new Error("must not mint a new id for an unchanged cart");
    });

    expect(retry.ok).toBe(true);
    expect(retry.ok === true && retry.request.id).toBe(REQUEST_ID);
  });

  it("issues a new id when a modifier changes", () => {
    // Under itemId-only fingerprinting, swapping Oat for Vanilla would have
    // reused the id and been rejected by the server as a hash mismatch.
    const first = plan([createCartItem(tracked, [MILK])]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const changed = planSaleSubmission({
      projectId: PROJECT_ID,
      paymentMethod: "cash",
      tipAmount: 0,
      cart: [createCartItem(tracked, [SYRUP])],
      menuItems: [tracked],
      current: first.request,
      generate: () => "33333333-3333-3333-3333-333333333333",
    });

    expect(changed.ok === true && changed.request.id).toBe(
      "33333333-3333-3333-3333-333333333333"
    );
  });

  it("reports an unusable crypto implementation instead of guessing an id", () => {
    const result = plan([createCartItem(tracked, [])], null, () => {
      throw new Error("no randomUUID");
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(SALE_INSECURE_BROWSER_MESSAGE);
  });
});

describe("the unconfirmed-sale message never claims the sale failed", () => {
  it("tells the operator to retry, and that a replay shows the original receipt", () => {
    // A transport failure may already have committed server-side. Wording that
    // asserted failure would invite a second, real sale.
    expect(SALE_UNCONFIRMED_MESSAGE).not.toMatch(/failed|did not|was not/i);
    expect(SALE_UNCONFIRMED_MESSAGE).toMatch(/retry/i);
    expect(SALE_UNCONFIRMED_MESSAGE).toMatch(/original receipt/i);
  });
});

// ---------------------------------------------------------------------------
// toCompletedOrder — reading the server's answer
// ---------------------------------------------------------------------------

const RECEIPT: CompletedSaleReceipt = {
  orderId: "order-1",
  orderNumber: "ORD-1042",
  paymentMethod: "card",
  subtotal: "10.20",
  taxAmount: "0.82",
  tipAmount: "0.00",
  total: "11.02",
  createdAt: "2026-08-13T10:00:00.000Z",
  items: [
    {
      itemId: "item-1",
      itemName: "Latte",
      unitPrice: "5.10",
      quantity: 2,
      lineTotal: "10.20",
      modifiers: [
        {
          groupId: "group-milk",
          groupName: "Milk",
          optionId: "option-oat",
          optionName: "Oat",
          priceAdjustment: "0.60",
        },
        {
          groupId: "group-syrup",
          groupName: "Syrup",
          optionId: "option-vanilla",
          optionName: "Vanilla",
          priceAdjustment: "0.50",
        },
      ],
    },
  ],
};

describe("toCompletedOrder projects the authoritative receipt", () => {
  it("takes every total from the server, never from a cart", () => {
    const order = toCompletedOrder(RECEIPT);

    expect(order.id).toBe("order-1");
    expect(order.orderNumber).toBe("ORD-1042");
    expect(order.subtotal).toBe(10.2);
    expect(order.taxAmount).toBe(0.82);
    expect(order.tip).toBe(0);
    expect(order.total).toBe(11.02);
    expect(order.paymentMethod).toBe("card");
    expect(order.createdAt).toBe("2026-08-13T10:00:00.000Z");
  });

  it("preserves the modifier snapshot, grouped as the server recorded it", () => {
    const [line] = toCompletedOrder(RECEIPT).items;

    expect(line.modifiers).toEqual([
      {
        groupId: "group-milk",
        groupName: "Milk",
        options: [{ id: "option-oat", name: "Oat", priceAdjustment: 0.6 }],
      },
      {
        groupId: "group-syrup",
        groupName: "Syrup",
        options: [{ id: "option-vanilla", name: "Vanilla", priceAdjustment: 0.5 }],
      },
    ]);
  });

  it("derives basePrice by subtracting the recorded adjustments", () => {
    // unit_price already includes them, so the breakdown must come back out of
    // the snapshot rather than from a menu lookup that may since have changed.
    const [line] = toCompletedOrder(RECEIPT).items;

    expect(line.price).toBe(5.1);
    expect(line.basePrice).toBeCloseTo(4, 10);
  });

  it("gives the line the same identity the cart would have produced", () => {
    // This is what lets a reprinted receipt and a live cart line agree.
    const [line] = toCompletedOrder(RECEIPT).items;
    const cartLine = createCartItem(
      menuItem({ id: "item-1", name: "Latte", price: 4 }),
      [
        MILK,
        {
          groupId: "group-syrup",
          groupName: "Syrup",
          options: [{ id: "option-vanilla", name: "Vanilla", priceAdjustment: 0.5 }],
        },
      ]
    );

    expect(line.lineKey).toBe(cartLine.lineKey);
  });

  it("a receipt with no modifiers key reads as a plain line", () => {
    // Backward compatibility: complete_sale_v2 never emitted the key, and
    // orders placed before Feature 18 have none.
    const legacy: CompletedSaleReceipt = {
      ...RECEIPT,
      items: [
        {
          itemId: "item-1",
          itemName: "Latte",
          unitPrice: "4.00",
          quantity: 1,
          lineTotal: "4.00",
        },
      ],
    };

    const [line] = toCompletedOrder(legacy).items;

    expect(line.modifiers).toEqual([]);
    expect(line.basePrice).toBe(4);
    expect(line.price).toBe(4);
    expect(line.lineKey).toBe(createCartItem(menuItem(), []).lineKey);
  });
});

// ---------------------------------------------------------------------------
// v1.3 CP-2B — the sale authorization boundary
//
// PURE, SO EVERY REFUSAL IS REACHABLE. decideSaleAuthorization reads nothing
// itself: the runtime reads the live host authority synchronously and hands it
// in. That is what lets a ring-out mid-order, a register change, a
// configuration re-resolution and an unread recovery store all be exercised
// here under plain Node.
//
// WHAT THESE DO NOT PROVE: that the runtime calls this at the right moment,
// that a keyboard cannot press Done twice, or that any of it behaves on real
// hardware. Those are browser and device concerns, recorded as NOT VERIFIED.
// ---------------------------------------------------------------------------

/**
 * Builds the opaque token the host folds its identities into.
 *
 * The runtime never interprets this; these tests do, only so each scenario can
 * say WHICH fact changed. The separator matches DeviceApp's.
 */
function token(parts: {
  employee?: string;
  register?: string;
  build?: string;
  generation?: number;
} = {}): string {
  return [
    parts.employee ?? "emp-1",
    parts.register ?? "reg-1",
    parts.build ?? "build-1",
    String(parts.generation ?? 7),
  ].join("\u001f");
}

function authority(over: Partial<HostAuthoritySnapshot> = {}): HostAuthoritySnapshot {
  return { authorityToken: token(), blockedReason: null, ...over };
}

function decide(over: Partial<Parameters<typeof decideSaleAuthorization>[0]> = {}) {
  return decideSaleAuthorization({
    hostPresent: true,
    prepared: authority(),
    live: authority(),
    inFlight: false,
    tender: { required: false },
    ...over,
  });
}

describe("CP-2B host and configuration freshness at the sale boundary", () => {
  it("authorizes when every authority is unchanged and the store was read", () => {
    expect(decide()).toEqual({ ok: true });
  });

  it("refuses when the employee changed before Done", () => {
    expect(decide({ live: authority({ authorityToken: token({ employee: "emp-2" }) }) })).toEqual({
      ok: false,
      refusal: "host_changed",
      message: SALE_AUTHORIZATION_MESSAGES.host_changed,
    });
  });

  it("refuses when the register session changed before Done", () => {
    expect(decide({ live: authority({ authorityToken: token({ register: "reg-2" }) }) })).toMatchObject({
      ok: false,
      refusal: "host_changed",
    });
  });

  it("refuses when the build id moved", () => {
    expect(decide({ live: authority({ authorityToken: token({ build: "build-2" }) }) })).toMatchObject({
      ok: false,
      refusal: "host_changed",
    });
  });

  it("refuses a CONFIGURATION change with an UNCHANGED build id", () => {
    // THE REQUIREMENT buildJobId ALONE CANNOT MEET. A reconnect or an
    // offline-to-online transition re-resolves the device state and produces a
    // fresh configuration snapshot while the pin stays put. The generation
    // counts that replacement, so the token moves even though the build did not.
    const prepared = authority({ authorityToken: token({ build: "build-1", generation: 7 }) });
    const live = authority({ authorityToken: token({ build: "build-1", generation: 8 }) });

    // Same build, different authority.
    expect(prepared.authorityToken).toContain("build-1");
    expect(live.authorityToken).toContain("build-1");
    expect(prepared.authorityToken).not.toBe(live.authorityToken);

    expect(decide({ prepared, live })).toMatchObject({ ok: false, refusal: "host_changed" });
  });

  it("refuses when host authority is unavailable", () => {
    expect(decide({ live: null })).toMatchObject({ ok: false, refusal: "host_unavailable" });
  });

  it("refuses a checkout that was never prepared under an authority", () => {
    expect(decide({ prepared: null })).toMatchObject({ ok: false, refusal: "host_changed" });
  });

  it("does not substitute newly established authority for the old one", () => {
    expect(
      decide({
        prepared: authority({ authorityToken: token({ employee: "emp-1" }) }),
        live: authority({ authorityToken: token({ employee: "emp-2" }) }),
      }),
    ).toMatchObject({ ok: false, refusal: "host_changed" });
  });

  it("refuses a pending host transition, where the live read has gone null", () => {
    // The case a captured prop could never catch: the gate changed microseconds
    // ago and any prop from the last render still names the old employee.
    expect(decide({ live: null })).toMatchObject({ ok: false, refusal: "host_unavailable" });
  });

  it("preserves owner and Builder Preview behaviour when no host is present", () => {
    expect(decide({ hostPresent: false, prepared: null, live: null })).toEqual({ ok: true });
  });

  it("still refuses a second in-flight attempt even with no host", () => {
    expect(decide({ hostPresent: false, prepared: null, live: null, inFlight: true }))
      .toMatchObject({ ok: false, refusal: "in_flight" });
  });
});

describe("CP-2B UNKNOWN recovery fencing", () => {
  it("blocks while recovery hydration is still pending", () => {
    // Before CP-2B the runtime received a nullable UncertainSale, so "not read
    // yet" and "nothing outstanding" were the same value — and it authorized.
    expect(decide({ live: authority({ blockedReason: "Checking for an unfinished sale." }) })).toMatchObject({
      ok: false,
      refusal: "authority_blocked",
    });
  });

  it("authorizes only after an authoritative read proved absence", () => {
    expect(decide({ live: authority({ blockedReason: null }) })).toEqual({
      ok: true,
    });
  });

  it.each([
    "storage unavailable",
    "a failed read",
    "an unreadable record",
    "an identity mismatch",
  ])("refuses when the host reports %s rather than treating it as clear", (reason) => {
    const result = decide({ live: authority({ blockedReason: `blocked: ${reason}` }) });

    expect(result).toMatchObject({ ok: false, refusal: "authority_blocked" });
    // The host's own sentence reaches the operator verbatim.
    if (!result.ok) expect(result.message).toBe(`blocked: ${reason}`);
  });

  it("leaves an OUTSTANDING record to decideUncertainSale, preserving replay", () => {
    // Deliberate: the host reports no block for an outstanding record, because
    // the existing uncertainty gate is keyed on the sale fingerprint and owns
    // that decision. Refusing here would break the same-identity replay.
    expect(decide({ live: authority({ blockedReason: null }) })).toEqual({ ok: true });
  });

  it("refuses a second Done while a submission is in flight", () => {
    expect(decide({ inFlight: true })).toMatchObject({ ok: false, refusal: "in_flight" });
  });

  it("checks in-flight first, so a second press is refused cheaply", () => {
    expect(decide({ inFlight: true, live: null, prepared: null })).toMatchObject({
      ok: false,
      refusal: "in_flight",
    });
  });

  it("fences recovery before comparing host identity", () => {
    // An unresolved earlier sale is reported as itself, not as a host change.
    expect(
      decide({
        prepared: authority({ authorityToken: token({ employee: "emp-1" }) }),
        live: authority({
          authorityToken: token({ employee: "emp-2" }),
          blockedReason: "Checking for an unfinished sale.",
        }),
      }),
    ).toMatchObject({ ok: false, refusal: "authority_blocked" });
  });
});

describe("CP-2B tender authorization is an inert extension point", () => {
  it("authorizes a checkout that requires no tender, which is every checkout today", () => {
    expect(decide({ tender: { required: false } })).toEqual({ ok: true });
  });

  it("authorizes a required tender that has not been consumed", () => {
    expect(decide({ tender: { required: true, consumed: false } })).toEqual({ ok: true });
  });

  it("refuses a required tender that was already consumed", () => {
    // One-use: the same confirmation cannot pay for a second sale. The rule is
    // enforced now so CP-2C cannot land without it.
    expect(decide({ tender: { required: true, consumed: true } })).toMatchObject({
      ok: false,
      refusal: "tender_unauthorized",
    });
  });

  it("every refusal carries an operator message", () => {
    const results = [
      decide({ inFlight: true }),
      decide({ live: null }),
      decide({ live: authority({ authorityToken: token({ employee: "other" }) }) }),
      decide({ live: authority({ blockedReason: "Checking for an unfinished sale." }) }),
      decide({ live: authority({ blockedReason: "read failed" }) }),
      decide({ tender: { required: true, consumed: true } }),
    ];

    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message.length).toBeGreaterThan(0);

        // `authority_blocked` carries the HOST's own sentence rather than the
        // default, because only the host knows which precondition failed.
        if (result.refusal !== "authority_blocked") {
          expect(result.message).toBe(SALE_AUTHORIZATION_MESSAGES[result.refusal]);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// v1.3 CP-2B FINAL — the three contracts, behaviorally
//
// INJECTED HOST, NOT SOURCE TEXT. Each scenario drives a stand-in host whose
// checkout lifecycle, fence and authority are modelled exactly as DeviceApp
// models them, so the ORDERING is exercised rather than asserted about: the
// fence is raised before the arm resolves, authority is mutated while the arm
// is pending, and the verdict is taken at the moment of dispatch.
//
// WHAT IT IS AND IS NOT. The identity half of the recovery decision uses the
// REAL decideUncertainSale, and the fingerprint reconstruction below uses the
// REAL createSaleFingerprint / canonicalLineIdentity / buildSaleRequestItems —
// those parts are not modelled at all. The authority lifecycle is a model of
// DeviceApp's refs, and the structural guards in
// lib/offlineCheckout.guards.test.ts are what tie that model to the source.
// Neither is a browser test and neither is claimed as one.
// ---------------------------------------------------------------------------

type Fence =
  | { status: "idle" }
  | {
      status: "arming" | "armed" | "unresolved";
      saleRequestId: string;
      fingerprint: string;
      checkoutGeneration: number;
    };

type StoreState = "pending" | "verified_clear" | "outstanding" | "blocked";

type Attempt = {
  saleRequestId: string | null;
  fingerprint: string;
  checkoutGeneration: number;
};

type HostModel = {
  live: { authorityToken: string; blockedReason: string | null } | null;
  /** What prepareCheckoutAuthorization minted, or null once invalidated. */
  prepared: {
    generation: number;
    token: string;
    scope:
      | { kind: "new_sale" }
      | { kind: "exact_recovery"; requestId: string; fingerprint: string };
  } | null;
  fence: Fence;
  store: StoreState;
  /** What the durable store reports outstanding, which is a SECOND source. */
  outstanding: UncertainSale | null;
  /** Recorded by the gate, read by the host's own final verification. */
  authorized: { generation: number; requestId: string | null; fingerprint: string } | null;
  dispatches: string[];
};

function uncertain(saleRequestId: string, fingerprint: string): UncertainSale {
  return createUncertainSale({
    saleRequestId,
    projectId: "project-1",
    paymentMethod: "cash",
    tipAmount: 0,
    items: [{ itemId: "item-1", quantity: 1, modifiers: [] }],
    fingerprint,
  });
}

/** Mirrors DeviceApp.decideSaleDispatch exactly. */
function hostDecide(
  host: HostModel,
  attempt: Attempt
):
  | { decision: "new_sale" }
  | { decision: "resume_exact"; requestId: string }
  | { decision: "blocked"; reason: string } {
  if (!host.live) return { decision: "blocked", reason: "no host" };
  if (host.live.blockedReason !== null) {
    return { decision: "blocked", reason: host.live.blockedReason };
  }

  const prepared = host.prepared;

  if (
    prepared === null ||
    prepared.generation !== attempt.checkoutGeneration ||
    prepared.token !== host.live.authorityToken
  ) {
    return { decision: "blocked", reason: "authority changed" };
  }

  // THE RECORDED SCOPE IS BINDING, and checked before the fence.
  if (
    prepared.scope.kind === "exact_recovery" &&
    (host.fence.status === "idle" ||
      attempt.saleRequestId !== prepared.scope.requestId ||
      attempt.fingerprint !== prepared.scope.fingerprint)
  ) {
    return { decision: "blocked", reason: "earlier sale unfinished" };
  }

  if (host.fence.status === "armed" || host.fence.status === "unresolved") {
    // TWO INDEPENDENT AUTHORITIES. The fence is this process's record; the
    // identity decision is the REAL decideUncertainSale, answering from what
    // the durable store reports.
    const identity = decideUncertainSale(
      host.store === "outstanding" ? host.outstanding : null,
      attempt.fingerprint
    );

    const exact =
      host.fence.saleRequestId === attempt.saleRequestId &&
      host.fence.fingerprint === attempt.fingerprint &&
      identity.status === "resume" &&
      identity.saleRequestId === host.fence.saleRequestId;

    if (exact) {
      host.authorized = {
        generation: prepared.generation,
        requestId: host.fence.saleRequestId,
        fingerprint: host.fence.fingerprint,
      };

      return { decision: "resume_exact", requestId: host.fence.saleRequestId };
    }

    return { decision: "blocked", reason: "earlier sale unfinished" };
  }

  if (host.fence.status === "arming") return { decision: "blocked", reason: "still protecting" };
  if (host.store !== "verified_clear") return { decision: "blocked", reason: "store not verified" };

  host.authorized = {
    generation: prepared.generation,
    requestId: attempt.saleRequestId,
    fingerprint: attempt.fingerprint,
  };

  return { decision: "new_sale" };
}

/** Mirrors DeviceApp.verifySubmittedSale exactly. */
function hostVerify(
  host: HostModel,
  submitted: { requestId: string; fingerprint: string }
): ReturnType<typeof hostDecide> {
  const authorized = host.authorized;

  if (authorized === null) return { decision: "blocked", reason: "not authorized" };
  if (authorized.fingerprint !== submitted.fingerprint) {
    return { decision: "blocked", reason: "order changed" };
  }
  if (authorized.requestId !== null && authorized.requestId !== submitted.requestId) {
    return { decision: "blocked", reason: "order changed" };
  }

  return hostDecide(host, {
    saleRequestId: submitted.requestId,
    fingerprint: submitted.fingerprint,
    checkoutGeneration: authorized.generation,
  });
}

/**
 * A host whose durable arm is deferred, so authority can change mid-flight.
 *
 * The checkout lifecycle is explicit: `openCheckout` mints a generation,
 * `closeCheckout` and `completeCheckout` invalidate one BY NAME, and
 * `changeAuthority` advances the epoch the way advanceAuthorityEpoch does.
 */
function injectedHost(initialToken = "tok-1") {
  let epoch = 0;
  let generations = 0;

  const token = (base: string) => `${base}\u001f${epoch}`;

  const host: HostModel = {
    live: { authorityToken: token(initialToken), blockedReason: null },
    prepared: null,
    fence: { status: "idle" },
    store: "verified_clear",
    outstanding: null,
    authorized: null,
    dispatches: [],
  };

  let base = initialToken;
  let release: ((ok: boolean) => void) | null = null;

  const api = {
    host,
    get generation() {
      return generations;
    },
    /** prepareCheckoutAuthorization: refuses while recovery protection is up. */
    openCheckout(): { ok: true; generation: number } | { ok: false; reason: string } {
      if (!host.live) return { ok: false, reason: "no host" };
      if (host.live.blockedReason !== null) return { ok: false, reason: host.live.blockedReason };

      // Always refused: an in-flight durable write, and a store that has not
      // answered or could not be read.
      if (host.fence.status === "arming") return { ok: false, reason: "still protecting" };
      if (host.store === "pending" || host.store === "blocked") {
        return { ok: false, reason: "store not verified" };
      }

      let scope: NonNullable<HostModel["prepared"]>["scope"];

      if (host.fence.status === "idle") {
        if (host.store !== "verified_clear") return { ok: false, reason: "store not verified" };

        scope = { kind: "new_sale" };
      } else {
        // The durable record must agree with the fence, through the REAL
        // recovery policy rather than the fence's own word.
        const outstanding = host.store === "outstanding" ? host.outstanding : null;
        const identity = decideUncertainSale(outstanding, host.fence.fingerprint);

        if (identity.status !== "resume" || identity.saleRequestId !== host.fence.saleRequestId) {
          return { ok: false, reason: "earlier sale unfinished" };
        }

        scope = {
          kind: "exact_recovery",
          requestId: host.fence.saleRequestId,
          fingerprint: host.fence.fingerprint,
        };
      }

      generations += 1;
      host.prepared = { generation: generations, token: host.live.authorityToken, scope };
      host.authorized = null;

      return { ok: true, generation: generations };
    },
    /** invalidateCheckoutAuthorization: generation-scoped, so late is harmless. */
    closeCheckout(generation: number) {
      if (host.prepared === null || host.prepared.generation !== generation) return;

      host.prepared = null;
      host.authorized = null;
    },
    /** An employee, register, pairing or configuration change. */
    changeAuthority(nextBase = base) {
      base = nextBase;
      epoch += 1;
      host.live = { authorityToken: token(base), blockedReason: null };
      // advanceAuthorityEpoch drops the open authorization and NOTHING else.
      host.prepared = null;
      host.authorized = null;
    },
    decide: (attempt: Attempt) => hostDecide(host, attempt),
    verify: (submitted: { requestId: string; fingerprint: string }) => hostVerify(host, submitted),
    arm(sale: { saleRequestId: string; fingerprint: string }, generation: number): Promise<boolean> {
      host.store = "pending";
      host.outstanding = null;
      host.fence = { status: "arming", ...sale, checkoutGeneration: generation };

      return new Promise<boolean>((resolve) => {
        release = (ok) => {
          if (ok) {
            host.fence = { status: "armed", ...sale, checkoutGeneration: generation };
            host.store = "outstanding";
            host.outstanding = uncertain(sale.saleRequestId, sale.fingerprint);
          }
          resolve(ok);
        };
      });
    },
    settleArm(ok: boolean) {
      release?.(ok);
      release = null;
    },
    /** A remount: pending until an authoritative read answers. */
    remount(answer: { status: "outstanding"; sale: UncertainSale } | { status: "verified_clear" } | { status: "blocked" }) {
      host.prepared = null;
      host.authorized = null;
      host.store = "pending";
      host.outstanding = null;

      if (answer.status === "outstanding") {
        host.store = "outstanding";
        host.outstanding = answer.sale;
        host.fence = {
          status: "unresolved",
          saleRequestId: answer.sale.saleRequestId,
          fingerprint: answer.sale.fingerprint,
          checkoutGeneration: 0,
        };
      } else if (answer.status === "verified_clear") {
        host.store = "verified_clear";
        host.fence = { status: "idle" };
      }
    },
    /** The full path: pre-dispatch gate, then the host's own verification. */
    dispatch(submitted: { requestId: string; fingerprint: string }, generation: number) {
      const pre = hostDecide(host, {
        saleRequestId: submitted.requestId,
        fingerprint: submitted.fingerprint,
        checkoutGeneration: generation,
      });

      if (pre.decision === "blocked") return pre;

      const verdict = hostVerify(host, submitted);

      if (verdict.decision !== "blocked") host.dispatches.push(submitted.requestId);

      return verdict;
    },
  };

  return api;
}

/** Opens a checkout and returns the host plus the generation it issued. */
function openedHost(initialToken = "tok-1") {
  const h = injectedHost(initialToken);
  const prep = h.openCheckout();

  if (!prep.ok) throw new Error(`preparation refused: ${prep.reason}`);

  return { h, generation: prep.generation };
}

const SALE = { saleRequestId: "sale-1", fingerprint: "fp-1" };
/** The same sale as it reaches a FINAL gate, which names the id `requestId`. */
const SUBMITTED = { requestId: "sale-1", fingerprint: "fp-1" };

describe("CP-2B final A — the checkout authorization lifecycle", () => {
  it("the FIRST checkout captures the authority live at that moment", () => {
    const { h, generation } = openedHost();

    expect(generation).toBe(1);
    expect(h.host.prepared).toEqual({
      generation: 1,
      token: h.host.live?.authorityToken,
      scope: { kind: "new_sale" },
    });
    expect(h.decide({ ...SALE, checkoutGeneration: generation }).decision).toBe("new_sale");
  });

  it("a SECOND legitimate checkout after an employee change still sells", () => {
    // THE DEFECT THIS CLOSES. preparedTokenRef was written once and never
    // reset, so after any authority change every later sale on the till was
    // refused for the life of the process. A till that cannot sell after a
    // shift change is broken, not safe.
    const first = openedHost();

    first.h.closeCheckout(first.generation);
    first.h.changeAuthority("employee-2");

    const second = first.h.openCheckout();

    expect(second.ok).toBe(true);

    if (!second.ok) return;

    expect(second.generation).toBe(2);
    expect(first.h.decide({ ...SALE, checkoutGeneration: second.generation }).decision).toBe(
      "new_sale"
    );
  });

  it("a SECOND legitimate checkout after a same-build configuration change still sells", () => {
    const first = openedHost("emp-1\u001freg-1\u001fbuild-1");

    first.h.closeCheckout(first.generation);
    // The build pin does NOT move; only the snapshot is re-resolved.
    first.h.changeAuthority("emp-1\u001freg-1\u001fbuild-1");

    const second = first.h.openCheckout();

    expect(second.ok).toBe(true);

    if (!second.ok) return;

    expect(first.h.host.live?.authorityToken).toContain("build-1");
    expect(first.h.decide({ ...SALE, checkoutGeneration: second.generation }).decision).toBe(
      "new_sale"
    );
  });

  it("a STALE checkout is refused after the authority moves under it", () => {
    const { h, generation } = openedHost();

    h.changeAuthority("employee-2");

    expect(h.decide({ ...SALE, checkoutGeneration: generation }).decision).toBe("blocked");
  });

  it("a stale checkout cannot refresh itself by asking again", () => {
    const { h, generation } = openedHost();

    h.changeAuthority("employee-2");

    // Repeated attempts under the same generation stay refused; nothing in the
    // dispatch path re-prepares.
    for (let press = 0; press < 3; press += 1) {
      expect(h.decide({ ...SALE, checkoutGeneration: generation }).decision).toBe("blocked");
    }
  });

  it("A -> B -> A is refused even though the visible token returns to its old value", () => {
    const { h, generation } = openedHost("employee-A");
    const originalToken = h.host.live?.authorityToken;

    h.changeAuthority("employee-B");
    h.changeAuthority("employee-A");

    // Every visible identity is back where it started...
    expect(h.host.live?.authorityToken).not.toBe(originalToken);
    expect(h.host.live?.authorityToken).toContain("employee-A");
    // ...because the epoch is monotonic, so the token can never repeat, AND the
    // prepared record was dropped at the first change. Two barriers.
    expect(h.host.prepared).toBeNull();
    expect(h.decide({ ...SALE, checkoutGeneration: generation }).decision).toBe("blocked");
  });

  it("a completed checkout's authorization is spent", () => {
    const { h, generation } = openedHost();

    expect(h.dispatch(SUBMITTED, generation).decision).toBe("new_sale");

    h.closeCheckout(generation);

    expect(h.decide({ ...SALE, checkoutGeneration: generation }).decision).toBe("blocked");
  });

  it("a cancelled checkout's authorization is spent, and reopening mints a new one", () => {
    const { h, generation } = openedHost();

    h.closeCheckout(generation);

    expect(h.decide({ ...SALE, checkoutGeneration: generation }).decision).toBe("blocked");

    const reopened = h.openCheckout();

    expect(reopened.ok).toBe(true);

    if (!reopened.ok) return;

    expect(reopened.generation).toBe(2);
    // And the OLD generation is still refused after the reopen.
    expect(h.decide({ ...SALE, checkoutGeneration: generation }).decision).toBe("blocked");
    expect(h.decide({ ...SALE, checkoutGeneration: reopened.generation }).decision).toBe("new_sale");
  });

  it("a DELAYED close from an older checkout cannot strand the newer one", () => {
    const first = openedHost();

    first.h.closeCheckout(first.generation);

    const second = first.h.openCheckout();

    expect(second.ok).toBe(true);

    if (!second.ok) return;

    // The late callback finally fires, naming the OLD generation.
    first.h.closeCheckout(first.generation);

    // The new checkout is untouched.
    expect(first.h.host.prepared).toEqual({
      generation: second.generation,
      token: first.h.host.live?.authorityToken,
      scope: { kind: "new_sale" },
    });
    expect(first.h.decide({ ...SALE, checkoutGeneration: second.generation }).decision).toBe(
      "new_sale"
    );
  });

  it("preparation over an unresolved identity is SCOPED to it, not refused", () => {
    // CORRECTED. This previously asserted a refusal, and the refusal was the
    // bug: no generation was minted, so nothing could present one, so the
    // exact-recovery path was unreachable and the till could neither finish
    // the sale nor be reset. Preparation is granted — scoped to that identity
    // and to nothing else.
    const h = injectedHost();

    h.remount({ status: "outstanding", sale: uncertain("sale-1", "fp-1") });

    const prep = h.openCheckout();

    expect(prep.ok).toBe(true);
    expect(h.host.prepared?.scope).toEqual({
      kind: "exact_recovery",
      requestId: "sale-1",
      fingerprint: "fp-1",
    });
  });

  it("preparation is REFUSED when the fence and the durable record disagree", () => {
    const h = injectedHost();

    h.remount({ status: "outstanding", sale: uncertain("sale-1", "fp-1") });
    // The store now reports a DIFFERENT identity than the fence is protecting.
    h.host.outstanding = uncertain("sale-OTHER", "fp-OTHER");

    const prep = h.openCheckout();

    expect(prep.ok).toBe(false);

    if (prep.ok) return;

    expect(prep.reason).toBe("earlier sale unfinished");
  });

  it("preparation is REFUSED while the recovery read is still pending", () => {
    const h = injectedHost();

    h.remount({ status: "blocked" });

    expect(h.openCheckout().ok).toBe(false);
  });

  it("closing a checkout does NOT release durable recovery protection", () => {
    const { h, generation } = openedHost();
    const pending = h.arm(SALE, generation);

    h.settleArm(true);

    void pending;

    h.closeCheckout(generation);

    // The authorization is gone; the fence and the record are not.
    expect(h.host.prepared).toBeNull();
    expect(h.host.fence.status).toBe("armed");
    expect(h.host.outstanding).not.toBeNull();

    // And a fresh checkout over it is EXACT-RECOVERY scoped, never a new sale.
    const reopened = h.openCheckout();

    expect(reopened.ok).toBe(true);
    expect(h.host.prepared?.scope).toMatchObject({ kind: "exact_recovery", requestId: "sale-1" });
  });

  it("an authority change does NOT release durable recovery protection", async () => {
    const { h, generation } = openedHost();
    const pending = h.arm(SALE, generation);

    h.settleArm(true);
    await pending;

    h.changeAuthority("employee-2");

    expect(h.host.prepared).toBeNull();
    expect(h.host.fence.status).toBe("armed");
    expect(h.host.outstanding).not.toBeNull();
  });
});

describe("CP-2B final B — the submitted payload is reconstructed, not echoed", () => {
  // THE REAL FUNCTIONS, NOT A MODEL. This is the equivalence the online gate
  // depends on: the host receives SaleSubmissionItems and must recover the
  // lineKey the cart built, without being handed it.
  const SELECTION: CartModifierSelection[] = [
    {
      groupId: "group-milk",
      groupName: "Milk",
      options: [{ id: "opt-oat", name: "Oat", priceAdjustment: 0.5 }],
    },
  ];

  function reconstruct(items: ReturnType<typeof buildSaleRequestItems>, projectId = "project-1") {
    return createSaleFingerprint({
      projectId,
      paymentMethod: "cash",
      tipAmount: 0,
      items: items.map((item) => ({
        lineKey: canonicalLineIdentity(item.itemId, item.modifiers),
        quantity: item.quantity,
      })),
    });
  }

  it("reconstructs the EXACT fingerprint the cart produced", () => {
    const cart = [createCartItem(menuItem(), SELECTION, 2)];
    const fromCart = createSaleFingerprint({
      projectId: "project-1",
      paymentMethod: "cash",
      tipAmount: 0,
      items: cart,
    });

    expect(reconstruct(buildSaleRequestItems(cart))).toBe(fromCart);
  });

  it("reconstructs a multi-line cart regardless of item order", () => {
    const a = createCartItem(menuItem({ id: "item-1" }), SELECTION, 1);
    const b = createCartItem(menuItem({ id: "item-2" }), [], 3);
    const fromCart = createSaleFingerprint({
      projectId: "project-1",
      paymentMethod: "cash",
      tipAmount: 0,
      items: [a, b],
    });

    // createSaleFingerprint sorts by lineKey, so neither side depends on order.
    expect(reconstruct(buildSaleRequestItems([b, a]))).toBe(fromCart);
  });

  it("a changed QUANTITY produces a different fingerprint", () => {
    const original = reconstruct(buildSaleRequestItems([createCartItem(menuItem(), SELECTION, 2)]));
    const tampered = reconstruct(buildSaleRequestItems([createCartItem(menuItem(), SELECTION, 3)]));

    expect(tampered).not.toBe(original);
  });

  it("a changed MODIFIER produces a different fingerprint", () => {
    const other: CartModifierSelection[] = [
      {
        groupId: "group-milk",
        groupName: "Milk",
        options: [{ id: "opt-soy", name: "Soy", priceAdjustment: 0.5 }],
      },
    ];
    const original = reconstruct(buildSaleRequestItems([createCartItem(menuItem(), SELECTION, 1)]));
    const tampered = reconstruct(buildSaleRequestItems([createCartItem(menuItem(), other, 1)]));

    expect(tampered).not.toBe(original);
  });

  it("a changed ITEM produces a different fingerprint", () => {
    const original = reconstruct(buildSaleRequestItems([createCartItem(menuItem({ id: "item-1" }), [], 1)]));
    const tampered = reconstruct(buildSaleRequestItems([createCartItem(menuItem({ id: "item-2" }), [], 1)]));

    expect(tampered).not.toBe(original);
  });

  it("a changed PROJECT produces a different fingerprint", () => {
    const items = buildSaleRequestItems([createCartItem(menuItem(), SELECTION, 1)]);

    expect(reconstruct(items, "project-OTHER")).not.toBe(reconstruct(items, "project-1"));
  });

  it("a changed PAYMENT METHOD produces a different fingerprint", () => {
    const cart = [createCartItem(menuItem(), SELECTION, 1)];
    const cash = createSaleFingerprint({
      projectId: "project-1",
      paymentMethod: "cash",
      tipAmount: 0,
      items: cart,
    });
    const card = createSaleFingerprint({
      projectId: "project-1",
      paymentMethod: "card",
      tipAmount: 0,
      items: cart,
    });

    expect(card).not.toBe(cash);
  });

  it("a changed TIP produces a different fingerprint", () => {
    const cart = [createCartItem(menuItem(), SELECTION, 1)];
    const none = createSaleFingerprint({
      projectId: "project-1",
      paymentMethod: "cash",
      tipAmount: 0,
      items: cart,
    });
    const tipped = createSaleFingerprint({
      projectId: "project-1",
      paymentMethod: "cash",
      tipAmount: 1.5,
      items: cart,
    });

    expect(tipped).not.toBe(none);
  });

  it("the OFFLINE path needs no derivation, because CartItem already carries lineKey", () => {
    const cart = [createCartItem(menuItem(), SELECTION, 2)];
    const fromCart = createSaleFingerprint({
      projectId: "project-1",
      paymentMethod: "cash",
      tipAmount: 0,
      items: cart,
    });

    // Exactly what queueOfflineSale computes, with the project taken from the
    // host's own session rather than from the payload.
    expect(
      createSaleFingerprint({
        projectId: "project-1",
        paymentMethod: "cash",
        tipAmount: 0,
        items: cart,
      })
    ).toBe(fromCart);
  });
});

describe("CP-2B final B — the final host gates refuse a tampered payload", () => {
  it("the ONLINE gate refuses a payload whose fingerprint differs from the authorized one", () => {
    const { h, generation } = openedHost();

    // Authorized for fp-1...
    expect(h.decide({ ...SALE, checkoutGeneration: generation }).decision).toBe("new_sale");
    // ...but the payload that arrives hashes differently.
    expect(h.verify({ requestId: "sale-1", fingerprint: "fp-TAMPERED" }).decision).toBe("blocked");
    expect(h.host.dispatches).toEqual([]);
  });

  it("the ONLINE gate refuses a SUBSTITUTED request id", () => {
    const { h, generation } = openedHost();

    expect(h.decide({ ...SALE, checkoutGeneration: generation }).decision).toBe("new_sale");
    expect(h.verify({ requestId: "sale-OTHER", fingerprint: "fp-1" }).decision).toBe("blocked");
  });

  it("the ONLINE gate refuses a payload that was never authorized at all", () => {
    const { h } = openedHost();

    // No pre-dispatch gate ran, so nothing was recorded.
    expect(h.host.authorized).toBeNull();
    expect(h.verify({ requestId: "sale-1", fingerprint: "fp-1" }).decision).toBe("blocked");
  });

  it("the OFFLINE gate permits the host-minted draft id under a null authorization", () => {
    const { h, generation } = openedHost();

    // The runtime names no id on an ordinary offline sale.
    expect(
      h.decide({ saleRequestId: null, fingerprint: "fp-1", checkoutGeneration: generation }).decision
    ).toBe("new_sale");
    expect(h.host.authorized).toEqual({ generation, requestId: null, fingerprint: "fp-1" });
    // The draft id the host minted is then accepted...
    expect(h.verify({ requestId: "offline-draft-1", fingerprint: "fp-1" }).decision).toBe("new_sale");
    // ...but a tampered cart is still refused.
    expect(h.verify({ requestId: "offline-draft-1", fingerprint: "fp-OTHER" }).decision).toBe(
      "blocked"
    );
  });

  it("an unresolved ONLINE identity cannot become a new OFFLINE sale", () => {
    const { h, generation } = openedHost();
    const pending = h.arm(SALE, generation);

    h.settleArm(true);
    void pending;

    expect(
      h.decide({ saleRequestId: null, fingerprint: "fp-NEW", checkoutGeneration: generation })
        .decision
    ).toBe("blocked");
  });

  it("a legitimate offline sale still succeeds", () => {
    const { h, generation } = openedHost();

    expect(h.dispatch({ requestId: "offline-1", fingerprint: "fp-1" }, generation).decision).toBe(
      "new_sale"
    );
    expect(h.host.dispatches).toEqual(["offline-1"]);
  });

  it("CARD behaves exactly as CASH at both gates", () => {
    for (const method of ["cash", "card"] as const) {
      const { h, generation } = openedHost();
      const fingerprint = `fp-${method}`;

      expect(
        h.dispatch({ requestId: `sale-${method}`, fingerprint }, generation).decision
      ).toBe("new_sale");
      expect(h.host.dispatches).toEqual([`sale-${method}`]);

      h.changeAuthority("employee-2");

      expect(
        h.decide({ saleRequestId: `sale-${method}`, fingerprint, checkoutGeneration: generation })
          .decision
      ).toBe("blocked");
    }
  });
});

describe("CP-2B final B — fencing across the arm, UNKNOWN and cleanup", () => {
  it("raises the fence BEFORE the durable arm resolves", async () => {
    const { h, generation } = openedHost();
    const pending = h.arm(SALE, generation);

    expect(h.host.fence.status).toBe("arming");
    expect(h.decide({ ...SALE, checkoutGeneration: generation }).decision).toBe("blocked");

    h.settleArm(true);
    await pending;

    expect(h.host.fence.status).toBe("armed");
  });

  it("publishes the outstanding identity synchronously on a successful arm", async () => {
    const { h, generation } = openedHost();
    const pending = h.arm(SALE, generation);

    h.settleArm(true);

    expect(await pending).toBe(true);
    expect(h.host.store).toBe("outstanding");
    expect(h.decide({ ...SALE, checkoutGeneration: generation })).toEqual({
      decision: "resume_exact",
      requestId: "sale-1",
    });
  });

  it("an ambiguous arm failure does NOT become verified clear", async () => {
    const { h, generation } = openedHost();
    const pending = h.arm(SALE, generation);

    h.settleArm(false);
    await pending;

    expect(h.host.store).not.toBe("verified_clear");
    expect(h.decide({ ...SALE, checkoutGeneration: generation }).decision).toBe("blocked");
  });

  it("an employee change while the arm is pending refuses dispatch and keeps the identity", async () => {
    const { h, generation } = openedHost();
    const pending = h.arm(SALE, generation);

    h.changeAuthority("employee-2");
    h.settleArm(true);
    await pending;

    expect(h.dispatch(SUBMITTED, generation).decision).toBe("blocked");
    expect(h.host.dispatches).toEqual([]);
    expect(h.host.fence).toMatchObject({ status: "armed", saleRequestId: "sale-1" });
  });

  it("a configuration change with an UNCHANGED build id refuses dispatch", async () => {
    const { h, generation } = openedHost("emp-1\u001freg-1\u001fbuild-1");
    const pending = h.arm(SALE, generation);

    h.changeAuthority("emp-1\u001freg-1\u001fbuild-1");
    h.settleArm(true);
    await pending;

    expect(h.host.live?.authorityToken).toContain("build-1");
    expect(h.dispatch(SUBMITTED, generation).decision).toBe("blocked");
    expect(h.host.dispatches).toEqual([]);
  });

  it("repeated Done cannot mint a second identity, but an exact replay still works", async () => {
    const { h, generation } = openedHost();
    const pending = h.arm(SALE, generation);

    h.settleArm(true);
    await pending;

    expect(h.dispatch({ requestId: "sale-2", fingerprint: "fp-2" }, generation).decision).toBe(
      "blocked"
    );
    expect(h.dispatch(SUBMITTED, generation).decision).toBe("resume_exact");
    expect(h.host.dispatches).toEqual(["sale-1"]);
  });

  it("cleanup that merely STARTED does not permit a new sale", () => {
    const { h, generation } = openedHost();

    h.host.fence = {
      status: "unresolved",
      saleRequestId: "sale-1",
      fingerprint: "fp-1",
      checkoutGeneration: generation,
    };
    // resolveUncertainSale has been issued; the read has not answered.
    h.host.store = "pending";
    h.host.outstanding = null;

    expect(
      h.decide({ saleRequestId: "sale-NEW", fingerprint: "fp-NEW", checkoutGeneration: generation })
        .decision
    ).toBe("blocked");
    // Not even the original identity, while the outcome is unknown.
    expect(h.decide({ ...SALE, checkoutGeneration: generation }).decision).toBe("blocked");
  });

  it("a failed verification after cleanup remains blocked", () => {
    const { h, generation } = openedHost();

    h.host.fence = {
      status: "unresolved",
      saleRequestId: "sale-1",
      fingerprint: "fp-1",
      checkoutGeneration: generation,
    };
    h.host.store = "blocked";

    expect(
      h.decide({ saleRequestId: "sale-NEW", fingerprint: "fp-NEW", checkoutGeneration: generation })
        .decision
    ).toBe("blocked");
  });

  it("only an authoritative resolution plus verified cleanup permits a new identity", () => {
    const h = injectedHost();

    h.remount({ status: "outstanding", sale: uncertain("sale-1", "fp-1") });

    // Recovery-scoped, so an UNRELATED identity still cannot be dispatched.
    const scoped = h.openCheckout();

    expect(scoped.ok).toBe(true);

    if (scoped.ok) {
      expect(
        h.decide({
          saleRequestId: "sale-NEW",
          fingerprint: "fp-NEW",
          checkoutGeneration: scoped.generation,
        }).decision
      ).toBe("blocked");
    }

    // The receipt arrived and the delete was VERIFIED absent by a real read.
    h.remount({ status: "verified_clear" });

    const prep = h.openCheckout();

    expect(prep.ok).toBe(true);

    if (!prep.ok) return;

    expect(h.decide({ saleRequestId: "sale-NEW", fingerprint: "fp-NEW", checkoutGeneration: prep.generation })).toEqual({
      decision: "new_sale",
    });
  });
});

describe("CP-2B final B — remount hydration and exact recovery", () => {
  it("a remount starts PENDING and cannot be read as clear", () => {
    const h = injectedHost();

    h.remount({ status: "blocked" });

    expect(h.host.store).toBe("pending");
    expect(h.openCheckout().ok).toBe(false);
  });

  it("an outstanding record after remount rebuilds the fence under the ORIGINAL identity", () => {
    const h = injectedHost();
    const record = uncertain("sale-ORIGINAL", "fp-ORIGINAL");

    h.remount({ status: "outstanding", sale: record });

    expect(h.host.fence).toMatchObject({
      status: "unresolved",
      saleRequestId: "sale-ORIGINAL",
      fingerprint: "fp-ORIGINAL",
    });
    // Nothing was minted: the id is the one that was dispatched.
    expect(h.host.outstanding?.saleRequestId).toBe("sale-ORIGINAL");
  });

  it("an ordinary NEW sale is refused after remount with an outstanding record", () => {
    const h = injectedHost();

    h.remount({ status: "outstanding", sale: uncertain("sale-ORIGINAL", "fp-ORIGINAL") });

    // Preparation succeeds, but ONLY as exact recovery — so the unrelated sale
    // is refused at dispatch rather than by withholding the checkout.
    const prep = h.openCheckout();

    expect(prep.ok).toBe(true);

    if (!prep.ok) return;

    expect(h.host.prepared?.scope).toMatchObject({ kind: "exact_recovery" });
    expect(
      h.decide({
        saleRequestId: "sale-NEW",
        fingerprint: "fp-NEW",
        checkoutGeneration: prep.generation,
      }).decision
    ).toBe("blocked");
  });

  it("an EXACT recovery is permitted under the original id and fingerprint", () => {
    const h = injectedHost();
    const record = uncertain("sale-ORIGINAL", "fp-ORIGINAL");

    h.remount({ status: "outstanding", sale: record });

    // The approved recovery operation: the host authorizes the replay directly,
    // under the generation the recovery checkout was granted.
    h.host.prepared = {
      generation: 99,
      token: h.host.live?.authorityToken ?? "",
      scope: {
        kind: "exact_recovery",
        requestId: h.host.fence.status === "idle" ? "" : h.host.fence.saleRequestId,
        fingerprint: h.host.fence.status === "idle" ? "" : h.host.fence.fingerprint,
      },
    };

    expect(
      h.decide({
        saleRequestId: "sale-ORIGINAL",
        fingerprint: "fp-ORIGINAL",
        checkoutGeneration: 99,
      })
    ).toEqual({ decision: "resume_exact", requestId: "sale-ORIGINAL" });
  });

  it("a recovery with a CHANGED cart is refused, not silently resumed", () => {
    const h = injectedHost();

    h.remount({ status: "outstanding", sale: uncertain("sale-ORIGINAL", "fp-ORIGINAL") });
    h.host.prepared = {
      generation: 99,
      token: h.host.live?.authorityToken ?? "",
      scope: {
        kind: "exact_recovery",
        requestId: h.host.fence.status === "idle" ? "" : h.host.fence.saleRequestId,
        fingerprint: h.host.fence.status === "idle" ? "" : h.host.fence.fingerprint,
      },
    };

    expect(
      h.decide({
        saleRequestId: "sale-ORIGINAL",
        fingerprint: "fp-CHANGED",
        checkoutGeneration: 99,
      }).decision
    ).toBe("blocked");
  });

  it("BOTH identity authorities must agree — the fence alone is not enough", () => {
    const h = injectedHost();

    h.remount({ status: "outstanding", sale: uncertain("sale-ORIGINAL", "fp-ORIGINAL") });
    h.host.prepared = {
      generation: 99,
      token: h.host.live?.authorityToken ?? "",
      scope: {
        kind: "exact_recovery",
        requestId: h.host.fence.status === "idle" ? "" : h.host.fence.saleRequestId,
        fingerprint: h.host.fence.status === "idle" ? "" : h.host.fence.fingerprint,
      },
    };

    // The fence still names the identity, but the durable store no longer
    // reports it. decideUncertainSale then answers `none`, and the replay is
    // refused rather than resumed on the fence's word alone.
    h.host.store = "pending";

    expect(
      h.decide({
        saleRequestId: "sale-ORIGINAL",
        fingerprint: "fp-ORIGINAL",
        checkoutGeneration: 99,
      }).decision
    ).toBe("blocked");
  });

  it("the ORIGINAL request id is what an approved replay dispatches, never a new one", () => {
    const h = injectedHost();

    h.remount({ status: "outstanding", sale: uncertain("sale-ORIGINAL", "fp-ORIGINAL") });
    h.host.prepared = {
      generation: 99,
      token: h.host.live?.authorityToken ?? "",
      scope: {
        kind: "exact_recovery",
        requestId: h.host.fence.status === "idle" ? "" : h.host.fence.saleRequestId,
        fingerprint: h.host.fence.status === "idle" ? "" : h.host.fence.fingerprint,
      },
    };

    const verdict = h.dispatch({ requestId: "sale-ORIGINAL", fingerprint: "fp-ORIGINAL" }, 99);

    expect(verdict).toMatchObject({ decision: "resume_exact", requestId: "sale-ORIGINAL" });
    // Server idempotency: the same key goes back out, so complete_sale replays
    // rather than creating a second order.
    expect(h.host.dispatches).toEqual(["sale-ORIGINAL"]);
  });
});

describe("CP-2B final — negative controls on the behavioral model", () => {
  it("dropping the generation comparison lets a stale checkout through", () => {
    const { h, generation } = openedHost();

    h.changeAuthority("employee-2");

    const withBarrier = hostDecide(h.host, { ...SALE, checkoutGeneration: generation });
    // Simulate the barrier's absence: the authority is re-prepared from the
    // live value, which is precisely the self-comparison CP-2B removed.
    const withoutBarrier = hostDecide(
      {
        ...h.host,
        prepared: {
          generation,
          token: h.host.live?.authorityToken ?? "",
          scope: { kind: "new_sale" as const },
        },
      },
      { ...SALE, checkoutGeneration: generation }
    );

    expect(withBarrier.decision).toBe("blocked");
    expect(withoutBarrier.decision).toBe("new_sale");
  });

  it("deriving the submitted fingerprint from the authorization makes the gate vacuous", () => {
    const { h, generation } = openedHost();

    expect(h.decide({ ...SALE, checkoutGeneration: generation }).decision).toBe("new_sale");

    // The real gate, against a tampered payload.
    expect(h.verify({ requestId: "sale-1", fingerprint: "fp-TAMPERED" }).decision).toBe("blocked");
    // The OLD behaviour: take the fingerprint from the same place it is
    // compared against, and every payload passes.
    expect(
      h.verify({ requestId: "sale-1", fingerprint: h.host.authorized?.fingerprint ?? "" }).decision
    ).toBe("new_sale");
  });

  it("treating a pending store as clear permits an unsafe sale", () => {
    const { h, generation } = openedHost();

    h.host.store = "pending";

    expect(hostDecide(h.host, { ...SALE, checkoutGeneration: generation }).decision).toBe("blocked");
    expect(
      hostDecide({ ...h.host, store: "verified_clear" }, { ...SALE, checkoutGeneration: generation })
        .decision
    ).toBe("new_sale");
  });

  it("an unconditional close would strand a newer checkout", () => {
    const first = openedHost();

    first.h.closeCheckout(first.generation);

    const second = first.h.openCheckout();

    expect(second.ok).toBe(true);

    if (!second.ok) return;

    // Generation-scoped: the late close is ignored.
    first.h.closeCheckout(first.generation);
    expect(first.h.host.prepared).not.toBeNull();

    // Unconditional: the new checkout loses its authorization.
    first.h.host.prepared = null;
    expect(
      first.h.decide({ ...SALE, checkoutGeneration: second.generation }).decision
    ).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// v1.3 CP-2B RECOVERY — close/reopen, with REAL fingerprints
//
// Every identity below is a fingerprint computed by the real
// createSaleFingerprint over a real cart built by the real createCartItem, so
// "a different quantity" and "a different tender" are different the way the
// product makes them different — not because the test wrote a different string.
// ---------------------------------------------------------------------------

describe("CP-2B recovery — close/reopen under the original identity", () => {
  const OAT: CartModifierSelection[] = [
    {
      groupId: "group-milk",
      groupName: "Milk",
      options: [{ id: "opt-oat", name: "Oat", priceAdjustment: 0.5 }],
    },
  ];
  const SOY: CartModifierSelection[] = [
    {
      groupId: "group-milk",
      groupName: "Milk",
      options: [{ id: "opt-soy", name: "Soy", priceAdjustment: 0.5 }],
    },
  ];

  /** The fingerprint the runtime computes at Done, for this cart and tender. */
  function fingerprintOf(
    cart: readonly CartItem[],
    paymentMethod: "cash" | "card" = "cash",
    projectId = "project-1",
    tipAmount = 0
  ) {
    return createSaleFingerprint({ projectId, paymentMethod, tipAmount, items: cart });
  }

  const ORIGINAL_CART = [createCartItem(menuItem(), OAT, 2)];
  const ORIGINAL_FP = fingerprintOf(ORIGINAL_CART);
  const ORIGINAL_ID = "sale-ORIGINAL";

  /**
   * A till that dispatched ORIGINAL_ID, lost the answer, and has since had its
   * checkout closed — so the authorization is gone and the fence is not.
   */
  function afterCloseWithUnknown() {
    const h = injectedHost();

    h.remount({
      status: "outstanding",
      sale: createUncertainSale({
        saleRequestId: ORIGINAL_ID,
        projectId: "project-1",
        paymentMethod: "cash",
        tipAmount: 0,
        items: buildSaleRequestItems(ORIGINAL_CART),
        fingerprint: ORIGINAL_FP,
      }),
    });

    expect(h.host.prepared).toBeNull();
    expect(h.host.fence.status).toBe("unresolved");

    return h;
  }

  /** Reopen, re-select the original tender, and present what Done would. */
  function reopen(h: ReturnType<typeof injectedHost>) {
    const prep = h.openCheckout();

    expect(prep.ok).toBe(true);

    if (!prep.ok) throw new Error(`reopen refused: ${prep.reason}`);

    return prep.generation;
  }

  it("1. recovers under the ORIGINAL request id and fingerprint", () => {
    const h = afterCloseWithUnknown();
    const generation = reopen(h);

    expect(
      h.decide({
        saleRequestId: ORIGINAL_ID,
        fingerprint: ORIGINAL_FP,
        checkoutGeneration: generation,
      })
    ).toEqual({ decision: "resume_exact", requestId: ORIGINAL_ID });
  });

  it("17. close/reopen with the original tender explicitly reselected dispatches the original id", () => {
    // closeCheckout nulls selectedPaymentMethod, so the cashier must choose
    // again. Choosing CASH reproduces the original fingerprint exactly.
    const h = afterCloseWithUnknown();
    const generation = reopen(h);
    const reselected = fingerprintOf(ORIGINAL_CART, "cash");

    expect(reselected).toBe(ORIGINAL_FP);

    const verdict = h.dispatch({ requestId: ORIGINAL_ID, fingerprint: reselected }, generation);

    expect(verdict).toMatchObject({ decision: "resume_exact", requestId: ORIGINAL_ID });
    expect(h.host.dispatches).toEqual([ORIGINAL_ID]);
  });

  it("5. a DIFFERENT payment method is refused, and mints nothing", () => {
    const h = afterCloseWithUnknown();
    const generation = reopen(h);
    const card = fingerprintOf(ORIGINAL_CART, "card");

    expect(card).not.toBe(ORIGINAL_FP);
    expect(
      h.dispatch({ requestId: ORIGINAL_ID, fingerprint: card }, generation).decision
    ).toBe("blocked");
    expect(h.host.dispatches).toEqual([]);
    // The original identity survives the refusal untouched.
    expect(h.host.fence).toMatchObject({ status: "unresolved", saleRequestId: ORIGINAL_ID });
    expect(h.host.outstanding?.saleRequestId).toBe(ORIGINAL_ID);
  });

  it("2/3/4. a different cart, quantity or modifier is refused", () => {
    for (const [label, cart] of [
      ["different item", [createCartItem(menuItem({ id: "item-2" }), OAT, 2)]],
      ["different quantity", [createCartItem(menuItem(), OAT, 3)]],
      ["different modifier", [createCartItem(menuItem(), SOY, 2)]],
      ["extra line", [createCartItem(menuItem(), OAT, 2), createCartItem(menuItem({ id: "item-3" }), [], 1)]],
    ] as const) {
      const h = afterCloseWithUnknown();
      const generation = reopen(h);
      const changed = fingerprintOf(cart);

      expect(changed, `${label} produced the original fingerprint`).not.toBe(ORIGINAL_FP);
      expect(
        h.dispatch({ requestId: ORIGINAL_ID, fingerprint: changed }, generation).decision,
        `${label} was not refused`
      ).toBe("blocked");
      expect(h.host.dispatches).toEqual([]);
    }
  });

  it("6. a DIFFERENT request id under the original fingerprint is refused", () => {
    const h = afterCloseWithUnknown();
    const generation = reopen(h);

    expect(
      h.dispatch({ requestId: "sale-FRESH", fingerprint: ORIGINAL_FP }, generation).decision
    ).toBe("blocked");
    expect(h.host.dispatches).toEqual([]);
  });

  it("7. a DIFFERENT fingerprint under the original id is refused", () => {
    const h = afterCloseWithUnknown();
    const generation = reopen(h);

    expect(
      h.dispatch({ requestId: ORIGINAL_ID, fingerprint: "fp-SOMETHING-ELSE" }, generation).decision
    ).toBe("blocked");
  });

  it("8/9/10/11. changed pairing, employee, register or configuration refuses recovery", () => {
    for (const changed of ["pairing-2", "employee-2", "register-2", "config-2"]) {
      const h = afterCloseWithUnknown();
      const generation = reopen(h);

      h.changeAuthority(changed);

      expect(
        h.decide({
          saleRequestId: ORIGINAL_ID,
          fingerprint: ORIGINAL_FP,
          checkoutGeneration: generation,
        }).decision,
        `${changed} did not refuse recovery`
      ).toBe("blocked");
      // The durable identity is NOT released by an authority change.
      expect(h.host.fence).toMatchObject({ status: "unresolved", saleRequestId: ORIGINAL_ID });
    }
  });

  it("12. A -> B -> A cannot revive a recovery authorization either", () => {
    const h = afterCloseWithUnknown();
    const generation = reopen(h);

    h.changeAuthority("employee-B");
    h.changeAuthority("tok-1");

    expect(h.host.prepared).toBeNull();
    expect(
      h.decide({
        saleRequestId: ORIGINAL_ID,
        fingerprint: ORIGINAL_FP,
        checkoutGeneration: generation,
      }).decision
    ).toBe("blocked");
  });

  it("13. a deferred, ambiguous arm keeps recovery refused until it settles", () => {
    const h = afterCloseWithUnknown();

    h.host.fence = { status: "arming", saleRequestId: ORIGINAL_ID, fingerprint: ORIGINAL_FP, checkoutGeneration: 0 };

    // `arming` is refused at preparation: the device cannot say which identity
    // it would scope the checkout to.
    expect(h.openCheckout().ok).toBe(false);
  });

  it("14. recovery pending or blocked refuses preparation outright", () => {
    for (const store of ["pending", "blocked"] as const) {
      const h = afterCloseWithUnknown();

      h.host.store = store;

      expect(h.openCheckout().ok, `${store} did not refuse preparation`).toBe(false);
    }
  });

  it("15. an unresolved online identity cannot fall back to a NEW offline sale", () => {
    const h = afterCloseWithUnknown();
    const generation = reopen(h);

    // The offline path names no id; the host would mint the draft.
    expect(
      h.decide({ saleRequestId: null, fingerprint: ORIGINAL_FP, checkoutGeneration: generation })
        .decision
    ).toBe("blocked");
    expect(h.host.dispatches).toEqual([]);
  });

  it("16. nothing in a close, a reopen or a refusal releases the fence", () => {
    const h = afterCloseWithUnknown();
    const generation = reopen(h);

    h.dispatch({ requestId: "sale-FRESH", fingerprint: ORIGINAL_FP }, generation);
    h.closeCheckout(generation);
    reopen(h);

    expect(h.host.fence).toMatchObject({ status: "unresolved", saleRequestId: ORIGINAL_ID });
    expect(h.host.outstanding?.saleRequestId).toBe(ORIGINAL_ID);
    expect(h.host.store).toBe("outstanding");

    // Only an authoritative read proving absence lowers it.
    h.remount({ status: "verified_clear" });

    expect(h.host.fence.status).toBe("idle");
  });

  it("clearing local storage alone does NOT permit a new sale", () => {
    const h = afterCloseWithUnknown();

    // Local state forgotten, but the network outcome is still unknown: the read
    // reports `blocked`, not absence.
    h.remount({ status: "blocked" });

    expect(h.openCheckout().ok).toBe(false);
  });
});
