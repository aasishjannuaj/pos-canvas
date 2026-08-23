// Feature 25.1 — the active-pairing rule, and the line it must never cross.
//
// TWO TIMESTAMPS, TWO MEANINGS, AND THEY MUST NOT MERGE.
//
// `revoked_at` is a FINANCIAL boundary. An owner can revoke remotely while a
// till is offline, so sales taken before that instant are real money the device
// could not have known about — which is why complete_sale_v4 compares it against
// occurred_at and accepts what came first. Feature 24.5F proved that behaviour on
// real hardware.
//
// `unpaired_at` is ADMINISTRATIVE. It is set on the device, by a person, and only
// after decideDeviceResetSafety has proven the queue holds nothing pending,
// syncing, needing attention, or uncertain. There is no legitimate sale left for
// a temporal window to admit, so it gets none.
//
// The guards below exist to keep the second from drifting into the first.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  TERMINAL_LOCAL_RESOLUTION_CODES,
  RETRYABLE_NEEDS_ATTENTION_CODES,
  decideRejectedSaleDiscardSafety,
  decideRejectedSaleRetrySafety,
  describeRejectedSaleReason,
} from "@/lib/rejectedSaleResolution";
import { classifySubmissionFailure } from "@/lib/saleSyncClassifier";
import type { QueuedSale } from "@/lib/saleQueue";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

const MIGRATION = "supabase/migrations/20260823120000_device_voluntary_unpair.sql";

/** The body of one function inside the migration. */
function fn(name: string): string {
  const sql = read(MIGRATION);
  const start = sql.indexOf(`create or replace function public.${name}`);

  if (start === -1) throw new Error(`${name} is not defined in the migration`);

  return sql.slice(start, sql.indexOf("\n$function$;", start));
}

describe("an active pairing is neither revoked nor unpaired", () => {
  for (const name of ["resolve_sale_owner", "get_device_config", "complete_sale_v3"]) {
    it(`${name} requires both`, () => {
      const body = fn(name);

      expect(body).toContain("revoked_at is null");
      expect(body).toContain("unpaired_at is null");
    });
  }

  it("the legacy family inherits the rule through resolve_sale_owner", () => {
    // complete_sale and complete_sale_v2 have no device lookup of their own;
    // they call resolve_sale_owner, which now enforces both.
    const owner = fn("resolve_sale_owner");

    expect(owner).toContain("from public.paired_devices d");
    expect(owner).toContain("and d.unpaired_at is null;");
  });
});

describe("complete_sale_v4 keeps its replay structure", () => {
  it("resolves the device WITHOUT filtering revoked or unpaired rows", () => {
    const v4 = fn("complete_sale_v4");
    const auth = v4.slice(v4.indexOf("if not v_is_owner then"), v4.indexOf("-- 3. Lock"));

    // The unfiltered resolve is what makes a replay possible at all.
    expect(auth).toContain("d.unpaired_at");
    expect(auth).not.toContain("and d.revoked_at is null");
    expect(auth).not.toContain("and d.unpaired_at is null");
  });

  it("looks the idempotency key up BEFORE any unpaired rejection", () => {
    const v4 = fn("complete_sale_v4");
    const idem = v4.indexOf("and o.sale_request_id = p_sale_request_id;");
    const replay = v4.indexOf("if found then", idem);
    const newSale = v4.indexOf("\n  else\n", replay);
    const refusal = v4.indexOf("v_device_unpaired_at is not null then");

    expect(idem).toBeGreaterThan(-1);
    // Replay is answered first; the refusal lives inside the NEW-sale branch.
    expect(replay).toBeGreaterThan(idem);
    expect(newSale).toBeGreaterThan(replay);
    expect(refusal).toBeGreaterThan(newSale);
  });

  it("rejects a NEW sale from an unpaired pairing, with a stable message", () => {
    const v4 = fn("complete_sale_v4");

    expect(v4).toContain("if not v_is_owner and v_device_unpaired_at is not null then");
    expect(v4).toContain("raise exception 'This device is no longer paired';");
  });

  it("NEVER compares unpaired_at against occurred_at", () => {
    const v4 = fn("complete_sale_v4");

    // The whole point. Any comparison here would make voluntary unpair a second
    // revocation contract, with a window nobody designed.
    expect(v4).not.toMatch(/occurred_at\s*[<>=]+\s*v_device_unpaired_at/);
    expect(v4).not.toMatch(/v_device_unpaired_at\s*[<>=]+\s*[a-z_]*occurred_at/);

    // And the refusal itself is unconditional — no occurred_at anywhere near it.
    const at = v4.indexOf("v_device_unpaired_at is not null then");

    expect(v4.slice(at, at + 200)).not.toContain("occurred_at");
  });

  it("revoked_at remains the ONLY timestamp compared against occurred_at", () => {
    const v4 = fn("complete_sale_v4");
    const comparisons = v4.match(/v_occurred_at\s*>=\s*v_device_\w+/g) ?? [];

    expect(comparisons).toEqual(["v_occurred_at >= v_device_revoked_at"]);
  });

  it("leaves the revocation window byte-identical", () => {
    const v4 = fn("complete_sale_v4");

    expect(v4).toContain(`if not v_is_owner and v_device_revoked_at is not null then
      if v_sale_source <> 'offline_queued' then`);
    expect(v4).toContain(`if v_occurred_at >= v_device_revoked_at then
        raise exception 'Offline sale occurred after this device was revoked';`);
  });
});

describe("the client tells the two rejections apart", () => {
  function sale(code: string): QueuedSale {
    return {
      state: "needs_attention",
      lastErrorCode: code,
      saleRequestId: "11111111-1111-4111-8111-111111111111",
      serverOrderId: null,
      serverOrderNumber: null,
    } as QueuedSale;
  }

  it("classifies the refusal as a definite answer, not a retry", () => {
    expect(
      classifySubmissionFailure(
        { transport: "server_rejected", message: "This device is no longer paired" },
        1
      )
    ).toEqual({ outcome: "needs_attention", code: "device_unpaired" });
  });

  it("does not retry it however many attempts have been made", () => {
    for (const attempts of [1, 9, 10, 50]) {
      expect(
        classifySubmissionFailure(
          { transport: "server_rejected", message: "This device is no longer paired" },
          attempts
        ).outcome
      ).toBe("needs_attention");
    }
  });

  it("is NOT locally discardable — post_revocation remains the only one", () => {
    expect([...TERMINAL_LOCAL_RESOLUTION_CODES]).toEqual(["post_revocation"]);

    expect(
      decideRejectedSaleDiscardSafety({
        record: sale("device_unpaired"),
        uncertain: { present: false },
      })
    ).toEqual({ allowed: false, reason: "not_terminal_rejection" });
  });

  it("is NOT retryable either", () => {
    expect(RETRYABLE_NEEDS_ATTENTION_CODES).not.toContain("device_unpaired");

    expect(
      decideRejectedSaleRetrySafety({
        record: sale("device_unpaired"),
        uncertain: { present: false },
      })
    ).toEqual({ allowed: false, reason: "not_retryable" });
  });

  it("explains itself without blaming the owner", () => {
    const reason = describeRejectedSaleReason("device_unpaired");

    expect(reason).toContain("already been unpaired");
    // It was not a revocation, and must not read like one.
    expect(reason).not.toContain("revoked");
    expect(reason).not.toBe(describeRejectedSaleReason("post_revocation"));
  });
});
