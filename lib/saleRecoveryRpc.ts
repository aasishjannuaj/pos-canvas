// G-1-CLIENT-1 — the ONE module that calls get_device_sale_by_request_id and
// complete_sale_recovery_v1.
//
// Same shape as lib/offlineSaleRpc.ts and for the same reason: keeping these
// calls in one small adapter makes "strict recovery is reachable only from
// here" a property a guard can check by listing files. Every answer is
// validated by lib/saleRecovery.ts before anything acts on it.
//
// NEVER A FALLBACK. Nothing here calls complete_sale_v5, and nothing here turns
// a missing function, a refusal, a timeout or an unreadable answer into one.
// Each of those comes back as what it is, and the caller keeps the sale
// protected.
//
// IDENTIFIERS ONLY, as on every other sale path: item ids, quantities, modifier
// selections, a "cash"/"card" label, the original sale request id, the original
// employee POS session and register, and the original attempt time. No price,
// no total and no credential.
import { getDeviceSupabaseClient } from "@/lib/supabase/deviceClient";
import { classifyDeviceFailure, isDatabaseRejection } from "@/lib/deviceConnectivity";
import type { DeviceFailureKind } from "@/lib/deviceConnectivity";
import {
  isMissingRecoveryFunction,
  parseSaleLookupAnswer,
  parseSaleRecoveryAnswer,
} from "@/lib/saleRecovery";
import type { SaleLookupAnswer, SaleRecoveryAnswer } from "@/lib/saleRecovery";
import type { QueuedSaleItem } from "@/lib/saleQueue";

/** The shape both calls need from PostgREST, so a test can supply one. */
export type RecoveryRpcCall = (
  name: "get_device_sale_by_request_id" | "complete_sale_recovery_v1",
  args: Record<string, unknown>,
  signal: AbortSignal
) => Promise<{ data: unknown; error: unknown; status?: number }>;

const defaultRpc: RecoveryRpcCall = async (name, args, signal) => {
  const { data, error, status } = await getDeviceSupabaseClient()
    .rpc(name, args)
    .abortSignal(signal);

  return { data, error, status };
};

/**
 * How long a lookup may take. It is read-only and takes no lock, so it is
 * shorter than a sale; a slow answer is simply "could not check", and the sale
 * stays protected.
 */
export const SALE_LOOKUP_TIMEOUT_MS = 15_000;

/**
 * How long a strict recovery may take. The same band, and the same reasoning,
 * as SALE_SUBMISSION_TIMEOUT_MS in lib/offlineSaleRpc.ts: it takes the same
 * project lock a sale does.
 */
export const SALE_RECOVERY_TIMEOUT_MS = 30_000;

export const SALE_RECOVERY_TIMEOUT_MESSAGE = "The sale recovery request timed out on this device";

/** Why a call produced no validated answer. */
export type RecoveryCallFailure =
  | {
      kind: "failed";
      /**
       * transport — positively never reached a server;
       * unknown   — may or may not have arrived (includes our own timeout);
       * rejected  — the server answered with a refusal;
       * missing   — the function does not exist on this server.
       */
      failure: "transport" | "unknown" | "rejected" | "missing";
      message: string | null;
      /** PostgreSQL raised: THIS invocation committed nothing. */
      rolledBack: boolean;
      timedOut: boolean;
    };

export type LookupCallResult = { kind: "answer"; answer: SaleLookupAnswer } | RecoveryCallFailure;
export type RecoveryCallResult = { kind: "answer"; answer: SaleRecoveryAnswer } | RecoveryCallFailure;

function withStatus(error: unknown, status: number | undefined): unknown {
  if (error === null || typeof error !== "object" || typeof status !== "number") {
    return error;
  }

  return { ...(error as Record<string, unknown>), status };
}

function messageOf(error: unknown): string | null {
  return error !== null &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : null;
}

function toFailure(kind: DeviceFailureKind): "transport" | "unknown" | "rejected" {
  return kind === "transport" ? "transport" : kind === "server_rejected" ? "rejected" : "unknown";
}

async function call(
  name: "get_device_sale_by_request_id" | "complete_sale_recovery_v1",
  args: Record<string, unknown>,
  timeoutMs: number,
  rpc: RecoveryRpcCall
): Promise<{ kind: "data"; data: unknown } | RecoveryCallFailure> {
  const controller = new AbortController();

  // THE SENTINEL, exactly as in lib/offlineSaleRpc.ts: "did WE give up?" is
  // answered by a variable this function owns, never by an error message. An
  // abort routed through the ordinary classifier reads as `transport`, which
  // would be a false claim that the request never arrived.
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const timeout = (): RecoveryCallFailure => ({
    kind: "failed",
    failure: "unknown",
    message: SALE_RECOVERY_TIMEOUT_MESSAGE,
    rolledBack: false,
    timedOut: true,
  });

  try {
    const { data, error, status } = await rpc(name, args, controller.signal);

    if (timedOut) return timeout();

    if (error) {
      if (isMissingRecoveryFunction(error)) {
        return {
          kind: "failed",
          failure: "missing",
          message: messageOf(error),
          rolledBack: false,
          timedOut: false,
        };
      }

      return {
        kind: "failed",
        failure: toFailure(classifyDeviceFailure(withStatus(error, status))),
        message: messageOf(error),
        rolledBack: isDatabaseRejection(error),
        timedOut: false,
      };
    }

    return { kind: "data", data };
  } catch (thrown) {
    if (timedOut) return timeout();

    return {
      kind: "failed",
      failure: toFailure(classifyDeviceFailure(thrown)),
      message: messageOf(thrown),
      rolledBack: false,
      timedOut: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

function itemsArg(items: readonly QueuedSaleItem[]) {
  return items.map((item) => ({
    itemId: item.itemId,
    quantity: item.quantity,
    modifiers: item.modifiers.map((group) => ({
      groupId: group.groupId,
      optionIds: group.optionIds,
    })),
  }));
}

/**
 * Asks whether an order already exists for this sale, on THIS device.
 *
 * READ-ONLY on the server (a STABLE function). "not_found" is reported as
 * exactly that and nothing more: an earlier request under the same id may
 * still commit after this read.
 */
export async function lookupDeviceSale(
  input: {
    saleRequestId: string;
    paymentMethod: "cash" | "card";
    tipAmount: number;
    items: readonly QueuedSaleItem[];
    originalEmployeePosSessionId: string | null;
    originalRegisterSessionId: string | null;
  },
  options: { timeoutMs?: number; rpc?: RecoveryRpcCall } = {}
): Promise<LookupCallResult> {
  const result = await call(
    "get_device_sale_by_request_id",
    {
      p_sale_request_id: input.saleRequestId,
      p_payment_method: input.paymentMethod,
      p_items: itemsArg(input.items),
      p_tip_amount: input.tipAmount,
      p_original_employee_pos_session_id: input.originalEmployeePosSessionId,
      p_original_register_session_id: input.originalRegisterSessionId,
    },
    options.timeoutMs ?? SALE_LOOKUP_TIMEOUT_MS,
    options.rpc ?? defaultRpc
  );

  return result.kind === "data"
    ? { kind: "answer", answer: parseSaleLookupAnswer(result.data) }
    : result;
}

/**
 * Creates or replays a sale under its ORIGINAL attribution only.
 *
 *   source "online"         — the original employee is signed in now; the
 *                             server attributes it to their CURRENT session and
 *                             the original register, and refuses anyone else.
 *   source "offline_queued" — the historical-claim path: the original session,
 *                             register and attempt time, validated by the server
 *                             against this device's own history.
 *
 * Either way the server refuses — and rolls back — rather than store a
 * substituted or NULL attribution.
 */
export async function submitSaleRecovery(
  input: {
    saleRequestId: string;
    paymentMethod: "cash" | "card";
    tipAmount: number;
    items: readonly QueuedSaleItem[];
    originalEmployeePosSessionId: string;
    originalRegisterSessionId: string;
  } & (
    | { source: "online"; currentEmployeePosSessionId: string }
    | { source: "offline_queued"; originalAttemptAt: string }
  ),
  options: { timeoutMs?: number; rpc?: RecoveryRpcCall } = {}
): Promise<RecoveryCallResult> {
  const result = await call(
    "complete_sale_recovery_v1",
    {
      p_payment_method: input.paymentMethod,
      p_tip_amount: input.tipAmount,
      p_items: itemsArg(input.items),
      p_sale_request_id: input.saleRequestId,
      p_source: input.source,
      p_original_employee_pos_session_id: input.originalEmployeePosSessionId,
      p_original_register_session_id: input.originalRegisterSessionId,
      // The server refuses a declared time online and requires one offline.
      p_original_attempt_at: input.source === "offline_queued" ? input.originalAttemptAt : null,
      p_current_employee_pos_session_id:
        input.source === "online" ? input.currentEmployeePosSessionId : null,
    },
    options.timeoutMs ?? SALE_RECOVERY_TIMEOUT_MS,
    options.rpc ?? defaultRpc
  );

  return result.kind === "data"
    ? { kind: "answer", answer: parseSaleRecoveryAnswer(result.data) }
    : result;
}
