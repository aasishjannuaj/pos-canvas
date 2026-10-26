// LF-2 Scope 2 — what a complete_sale_v6 answer is ABOUT (REPORT §11, K-4).
//
// The server returns structured classes, so this never reads an error's
// wording to decide anything:
//   SQLSTATE LFS01  sale          — about THIS sale's content      → O2 (isolate this sale)
//   SQLSTATE LFA01  authorization — about the device/caller        → A2 (pause uploads; never a sale answer)
//   SQLSTATE LFC01  capability    — the business has not enabled v6 → pause uploads; never a sale answer
//   anything else (transport, HTTP 5xx/429, missing function, no reply) → O1 (retry under the same ID)
// A hold is not a failure: { status: "held" } is a definitive answer about the sale.
//
// Pure. No client calls this yet: the queue-first v6 client is Scope 3.

export type V6Order = { orderId: string; orderNumber: string };

export type V6Outcome =
  | { kind: "booked" | "replayed"; identityHash: string; order: V6Order }
  | { kind: "held"; identityHash: string; holdId: string; reason: string; state: string }
  | { kind: "sale_rejected"; code: string } // O2
  | { kind: "authorization_failure"; code: string } // A2
  | { kind: "capability_off"; code: string }
  | { kind: "retry" }; // O1 — including a reply that never arrived

export type RpcErrorLike = { code?: string | null; message?: string | null; hint?: string | null } | null;

const HASH = /^[0-9a-f]{64}$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export function classifyV6Response(data: unknown, error: RpcErrorLike): V6Outcome {
  if (error) {
    const code = str(error.message) ?? "";
    switch (error.code) {
      case "LFS01":
        return { kind: "sale_rejected", code };
      case "LFA01":
        return { kind: "authorization_failure", code };
      case "LFC01":
        return { kind: "capability_off", code };
      default:
        return { kind: "retry" };
    }
  }

  if (typeof data !== "object" || data === null) return { kind: "retry" };
  const row = data as Record<string, unknown>;
  const identityHash = str(row.identityHash);
  if (identityHash === null || !HASH.test(identityHash)) return { kind: "retry" };

  if (row.status === "booked" || row.status === "replayed") {
    const order = row.order as Record<string, unknown> | null;
    const orderId = str(order?.orderId);
    const orderNumber = str(order?.orderNumber);
    if (orderId === null || orderNumber === null) return { kind: "retry" };
    return { kind: row.status, identityHash, order: { orderId, orderNumber } };
  }

  if (row.status === "held") {
    const holdId = str(row.holdId);
    const reason = str(row.reason);
    const state = str(row.state);
    if (holdId === null || reason === null || state === null) return { kind: "retry" };
    return { kind: "held", identityHash, holdId, reason, state };
  }

  // An answer we cannot read proves nothing about the sale: keep it, retry by ID.
  return { kind: "retry" };
}

/** Only O2 answers and holds are about the sale; nothing else may isolate it. */
export function isAnswerAboutTheSale(outcome: V6Outcome): boolean {
  return outcome.kind === "held" || outcome.kind === "sale_rejected" || outcome.kind === "booked" || outcome.kind === "replayed";
}
