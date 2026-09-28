// v1.3 CP2d — ensure_daily_register_context(), device side.
//
// THE ONLY MODULE THAT CALLS ensure_daily_register_context.
// lib/dailyRegister.ts holds the pure types, the parser and the freshness
// scheduling; this file is the adapter, and it is deliberately as thin as
// lib/register.rpc.ts.
//
// ZERO ARGUMENTS, AND THAT IS THE WHOLE CONTRACT. There is nothing a till could
// send that would not be an authority claim: not a project, not a device, not a
// business date, not a timezone, not an opening amount and not an operator. The
// server derives every one of them from auth.uid() outwards. A till that could
// name its own business day would be a till that could choose which day its
// money landed on.
import { getDeviceSupabaseClient } from "@/lib/supabase/deviceClient";
import { classifyDeviceFailure } from "@/lib/deviceConnectivity";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { parseDailyEnsureResponse } from "@/lib/dailyRegister";
import type { DailyEnsureResult } from "@/lib/dailyRegister";

/**
 * Carries the HTTP status onto the error object so classifyDeviceFailure can
 * tell a real refusal from a synthesized fetch failure. Same shape, and same
 * reason, as lib/register.rpc.ts.
 */
function withStatus(error: unknown, status: number | undefined): unknown {
  if (error === null || typeof error !== "object" || status === undefined) {
    return error;
  }

  return Object.assign(Object.create(Object.getPrototypeOf(error)), error, { status });
}

/**
 * The daily register context for this till, established if today is its first
 * sale.
 *
 * A TRANSPORT FAILURE IS `unavailable`, NEVER A DOMAIN ANSWER. "The server said
 * this business has no timezone" and "we could not ask" must not collapse into
 * one outcome: the first is a setup problem a person fixes once, the second is
 * a network blip that resolves itself, and they earn different screens. The
 * caller keeps whatever it already held when this returns `unavailable`.
 */
export async function ensureDailyRegisterContext(): Promise<DailyEnsureResult> {
  try {
    const { data, error, status } = await getDeviceSupabaseClient().rpc(
      "ensure_daily_register_context"
    );

    if (error) {
      void (isAuthRetryableFetchError(error) || classifyDeviceFailure(withStatus(error, status)));

      return { ok: false, error: "unavailable" };
    }

    return parseDailyEnsureResponse(data);
  } catch (thrown) {
    void classifyDeviceFailure(thrown);

    return { ok: false, error: "unavailable" };
  }
}
