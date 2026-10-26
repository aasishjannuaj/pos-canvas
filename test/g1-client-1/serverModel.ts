// G-1-CLIENT-1 — a SIMULATED model of the accepted server contract, for client
// tests only. SYNTHETIC DATA ONLY.
//
// Modelled on supabase/migrations/20261015120000_sale_recovery_attribution.sql
// (get_device_sale_by_request_id, complete_sale_recovery_v1) and on the parts of
// complete_sale_v5 those functions rely on: idempotency by sale request id
// before attribution, the online path attributing to the CURRENT session and
// refusing a moved register, and the offline path validating claims against
// this device's history (employee claim -> NULL when unprovable; register claim
// -> refused when unprovable).
//
// WHAT IT CANNOT PROVE: anything about the real PostgreSQL functions, their
// locking, or their hashing. Those are proven against a real local database in
// supabase/migrations/20261015120000_sale_recovery_client_contract.db.test.ts
// and in the accepted G1-SERVER-1A suite. Every response here is SHAPED like
// the real one (same keys, same value types) so the client's validators are
// exercised, but the model is deliberately simple.
//
// Pure TypeScript: no DOM, no Node API. Used by the unit sync tests, the in-page
// browser fake and the loopback HTTP mock for the real-restart run, so all
// three answer identically.

export type ModelOrder = {
  orderId: string;
  orderNumber: string;
  saleRequestId: string;
  contentHash: string;
  source: "online" | "offline_queued";
  paymentMethod: string;
  employeeId: string | null;
  employeePosSessionId: string | null;
  registerSessionId: string | null;
  /** NULL models an owner sale or a pre-1B device sale. */
  pairedDeviceId: string | null;
  occurredAt: string | null;
  createdAt: string;
};

export type ModelSession = {
  id: string;
  employeeId: string;
  deviceId: string;
  startedAt: number;
  endedAt: number | null;
};

export type ModelAnswer = { status: number; body: unknown; outcome: string };

const RAISE = (message: string, outcome: string): ModelAnswer => ({
  status: 400,
  body: { code: "P0001", message, details: null, hint: null },
  outcome,
});

type Items = { itemId: string; quantity: number; modifiers?: { groupId: string; optionIds: string[] }[] }[];

export function contentHash(args: Record<string, unknown>): string {
  const items = ((args.p_items as Items) ?? [])
    .map(
      (i) =>
        `${i.itemId}{${(i.modifiers ?? [])
          .filter((g) => g.optionIds.length > 0)
          .map((g) => `${g.groupId}:${[...g.optionIds].sort().join(",")}`)
          .sort()
          .join(";")}}=${i.quantity}`
    )
    .sort();

  return [args.p_payment_method, Number(args.p_tip_amount ?? 0).toFixed(2), ...items].join("|");
}

export function createServerModel(options: { deviceId: string; now?: () => number }) {
  const now = options.now ?? (() => Date.now());

  const state = {
    deviceId: options.deviceId,
    orders: [] as ModelOrder[],
    sessions: new Map<string, ModelSession>(),
    registers: new Map<string, { deviceId: string }>(),
    currentSessionId: null as string | null,
    currentRegisterId: null as string | null,
    orderSeq: 1000,
    /** RPC names answered with PostgREST's missing-function error. */
    missing: new Set<string>(),
    /** RPC names answered with an unreadable 200 body. */
    malformed: new Set<string>(),
  };

  const receiptFor = (order: ModelOrder, args: Record<string, unknown>) => ({
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    paymentMethod: order.paymentMethod,
    subtotal: "10.00",
    taxAmount: "0.00",
    tipAmount: "0.00",
    total: "10.00",
    createdAt: order.createdAt,
    items: ((args.p_items as Items) ?? []).map((i) => ({
      itemId: i.itemId,
      itemName: "Synthetic",
      unitPrice: "1.00",
      quantity: i.quantity,
      lineTotal: `${i.quantity}.00`,
    })),
    attribution: { registerSessionId: order.registerSessionId },
  });

  const find = (saleRequestId: unknown) => state.orders.find((o) => o.saleRequestId === saleRequestId);

  /**
   * complete_sale_v5, modelled. `commit: false` builds the order without
   * storing it, so complete_sale_recovery_v1's attribution guard can refuse it
   * and leave nothing behind — the rollback.
   */
  function v5(args: Record<string, unknown>, commit = true): ModelAnswer & { order?: ModelOrder } {
    const hash = contentHash(args);
    const existing = find(args.p_sale_request_id);

    if (existing) {
      if (existing.contentHash !== hash) {
        return RAISE("Sale request ID was already used for a different order", "hash_conflict");
      }

      return { status: 200, body: receiptFor(existing, args), outcome: "replayed", order: existing };
    }

    let employeeId: string | null = null;
    const registerSessionId = (args.p_register_session_id as string | null) ?? null;
    const sessionId = (args.p_employee_pos_session_id as string | null) ?? null;

    if (args.p_source === "online") {
      if (state.currentSessionId === null) {
        return RAISE("An employee must be signed in on this register", "refused_no_session");
      }
      if (sessionId !== state.currentSessionId) {
        return RAISE("The signed-in employee changed", "refused_session_changed");
      }
      if (registerSessionId !== state.currentRegisterId) {
        return RAISE("The register session changed", "refused_register_changed");
      }

      employeeId = state.sessions.get(sessionId)?.employeeId ?? null;
    } else {
      const occurred = Date.parse(String(args.p_occurred_at));

      if (!Number.isFinite(occurred)) {
        return RAISE("An offline sale must declare when it happened", "missing_occurred_at");
      }

      const session = sessionId === null ? undefined : state.sessions.get(sessionId);

      // Validate-or-NULL: proven only if the session is this device's and the
      // sale time falls inside it.
      employeeId =
        session !== undefined &&
        session.deviceId === state.deviceId &&
        occurred >= session.startedAt &&
        (session.endedAt === null || occurred < session.endedAt)
          ? session.employeeId
          : null;

      if (registerSessionId === null || state.registers.get(registerSessionId)?.deviceId !== state.deviceId) {
        return RAISE("A register session is required for an offline sale", "register_unverified");
      }
    }

    state.orderSeq += 1;

    const order: ModelOrder = {
      orderId: `0d000000-0000-4000-8000-${String(state.orderSeq).padStart(12, "0")}`,
      orderNumber: String(state.orderSeq),
      saleRequestId: String(args.p_sale_request_id),
      contentHash: hash,
      source: args.p_source === "online" ? "online" : "offline_queued",
      paymentMethod: String(args.p_payment_method),
      employeeId,
      employeePosSessionId: sessionId,
      registerSessionId,
      pairedDeviceId: state.deviceId,
      occurredAt: args.p_source === "online" ? null : String(args.p_occurred_at),
      createdAt: new Date(now()).toISOString(),
    };

    if (commit) state.orders.push(order);

    return { status: 200, body: receiptFor(order, args), outcome: "created", order };
  }

  function lookup(args: Record<string, unknown>): ModelAnswer {
    const order = find(args.p_sale_request_id);

    if (!order) return { status: 200, body: { status: "not_found" }, outcome: "not_found" };
    if (order.pairedDeviceId !== state.deviceId) {
      return { status: 200, body: { status: "not_this_device" }, outcome: "not_this_device" };
    }
    if (order.contentHash !== contentHash(args)) {
      return { status: 200, body: { status: "payload_mismatch" }, outcome: "payload_mismatch" };
    }

    const sessionClaim = args.p_original_employee_pos_session_id as string | null | undefined;
    const registerClaim = args.p_original_register_session_id as string | null | undefined;
    let attribution: string;

    if (!sessionClaim || !registerClaim) {
      attribution = "unverified";
    } else {
      const session = state.sessions.get(sessionClaim);
      const registerOk = state.registers.get(registerClaim)?.deviceId === state.deviceId;

      if (session === undefined || session.deviceId !== state.deviceId || !registerOk) {
        attribution = "claims_unverifiable";
      } else if (order.employeeId === session.employeeId && order.registerSessionId === registerClaim) {
        attribution = "verified";
      } else {
        attribution = "conflict";
      }
    }

    return {
      status: 200,
      outcome: `match_${attribution}`,
      body: {
        status: "match",
        attribution,
        order: {
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          total: "10.00",
          paymentMethod: order.paymentMethod,
          createdAt: order.createdAt.replace(/\.\d{3}Z$/, "Z"),
          occurredAt: order.occurredAt === null ? null : order.occurredAt.replace(/\.\d{3}Z$/, "Z"),
          source: order.source,
          employeeId: order.employeeId,
          registerSessionId: order.registerSessionId,
        },
      },
    };
  }

  function recovery(args: Record<string, unknown>): ModelAnswer {
    const source = args.p_source;

    if (source !== "online" && source !== "offline_queued") return RAISE("Invalid sale source", "invalid_source");
    if (!args.p_original_employee_pos_session_id || !args.p_original_register_session_id) {
      return RAISE("Recovery requires the original employee session and register", "claims_missing");
    }
    if (source === "offline_queued" && !args.p_original_attempt_at) {
      return RAISE("Recovery requires the original attempt time", "time_missing");
    }
    if (source === "online" && args.p_original_attempt_at) {
      return RAISE("An online recovery cannot declare its own sale time", "online_time");
    }
    if (source === "online" && !args.p_current_employee_pos_session_id) {
      return RAISE("Online recovery requires the signed-in employee session", "online_session_missing");
    }

    const original = state.sessions.get(String(args.p_original_employee_pos_session_id));

    if (original === undefined || original.deviceId !== state.deviceId) {
      return RAISE("The original employee session could not be verified", "employee_unverified");
    }
    if (state.registers.get(String(args.p_original_register_session_id))?.deviceId !== state.deviceId) {
      return RAISE("The original register could not be verified", "register_unverified");
    }

    const existing = find(args.p_sale_request_id);

    if (existing) {
      if (existing.pairedDeviceId !== state.deviceId) {
        return { status: 200, body: { status: "not_this_device" }, outcome: "not_this_device" };
      }
      if (existing.contentHash !== contentHash(args)) {
        return RAISE("Sale request ID was already used for a different order", "hash_conflict");
      }
      if (
        existing.employeeId !== original.employeeId ||
        existing.registerSessionId !== args.p_original_register_session_id
      ) {
        return {
          status: 200,
          outcome: "attribution_conflict",
          body: {
            status: "attribution_conflict",
            orderId: existing.orderId,
            orderNumber: existing.orderNumber,
            stored: {
              employeeId: existing.employeeId,
              registerSessionId: existing.registerSessionId,
              pairedDeviceId: existing.pairedDeviceId,
            },
            expected: {
              employeeId: original.employeeId,
              registerSessionId: args.p_original_register_session_id,
              pairedDeviceId: state.deviceId,
            },
          },
        };
      }

      const replay = v5({ ...args, p_source: source });

      return { status: 200, body: { status: "replayed", receipt: replay.body }, outcome: "replayed" };
    }

    let created: ReturnType<typeof v5>;

    if (source === "online") {
      const current = state.sessions.get(String(args.p_current_employee_pos_session_id));

      if (
        current === undefined ||
        current.endedAt !== null ||
        current.deviceId !== state.deviceId ||
        current.employeeId !== original.employeeId
      ) {
        return RAISE("Only the original employee can recover this sale online", "wrong_employee");
      }

      created = v5(
        {
          ...args,
          p_source: "online",
          p_occurred_at: null,
          p_employee_pos_session_id: args.p_current_employee_pos_session_id,
          p_register_session_id: args.p_original_register_session_id,
        },
        false
      );
    } else {
      created = v5(
        {
          ...args,
          p_source: "offline_queued",
          p_occurred_at: args.p_original_attempt_at,
          p_employee_pos_session_id: args.p_original_employee_pos_session_id,
          p_register_session_id: args.p_original_register_session_id,
        },
        false
      );
    }

    if (created.status !== 200 || created.order === undefined) return created;

    // THE ATTRIBUTION GUARD: anything but the originals rolls back (the order
    // was built uncommitted above and is simply not stored).
    if (
      created.order.employeeId !== original.employeeId ||
      created.order.registerSessionId !== args.p_original_register_session_id
    ) {
      state.orderSeq -= 1;

      return RAISE("The original employee and register could not be proven for this sale", "attribution_unproven");
    }

    state.orders.push(created.order);

    return { status: 200, body: { status: "created", receipt: created.body }, outcome: "created" };
  }

  return {
    state,
    signIn(sessionId: string, employeeId: string, at = now()) {
      if (state.currentSessionId !== null) {
        const previous = state.sessions.get(state.currentSessionId);

        if (previous && previous.endedAt === null) previous.endedAt = at;
      }

      state.sessions.set(sessionId, { id: sessionId, employeeId, deviceId: state.deviceId, startedAt: at, endedAt: null });
      state.currentSessionId = sessionId;
    },
    signOut(at = now()) {
      if (state.currentSessionId !== null) {
        const current = state.sessions.get(state.currentSessionId);

        if (current && current.endedAt === null) current.endedAt = at;
      }

      state.currentSessionId = null;
    },
    openRegister(registerId: string) {
      state.registers.set(registerId, { deviceId: state.deviceId });
      state.currentRegisterId = registerId;
    },
    /** A legacy v5 call storing whatever it stores — the G-1 conflict source. */
    v5,
    rpc(name: string, args: Record<string, unknown>): ModelAnswer {
      if (state.missing.has(name)) {
        return {
          status: 404,
          outcome: "missing_function",
          body: { code: "PGRST202", message: `Could not find the function public.${name}`, details: null, hint: null },
        };
      }
      if (state.malformed.has(name)) {
        return { status: 200, outcome: "malformed", body: { status: "match", order: "???" } };
      }

      switch (name) {
        case "get_device_sale_by_request_id":
          return lookup(args);
        case "complete_sale_recovery_v1":
          return recovery(args);
        case "complete_sale_v5":
          return v5(args);
        default:
          return {
            status: 404,
            outcome: "unmocked",
            body: { code: "PGRST202", message: `model: unmocked rpc ${name}`, details: null, hint: null },
          };
      }
    },
  };
}

export type ServerModel = ReturnType<typeof createServerModel>;
