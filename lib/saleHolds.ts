// LF-2 Scope 2 — the owner's "Held sales" review (REPORT §12.4).
//
// Wraps the owner RPCs from supabase/migrations/20261025120000_local_first_sale_v6.sql
// (list_sale_holds, get_sale_hold, decide_sale_hold) and keeps the parts worth
// testing on their own pure: parsing, plain-language reasons, which decisions a
// reason allows, the conflict comparison and the stock wording.
import { createClient } from "@/lib/supabase/client";

export type HoldState = "held" | "accepted" | "declined";
export type HoldDecision = "accept_as_recorded" | "accept_unattributed" | "record_as_separate" | "decline";

export type HoldSummary = {
  holdId: string;
  saleRequestId: string;
  reason: string;
  state: HoldState;
  receivedAt: string;
  decidedAt: string | null;
  deviceName: string | null;
  pairedDeviceId: string;
  employeeName: string | null;
  employeeId: string | null;
  total: string | null;
  paymentMethod: string | null;
  occurredAt: string | null;
  orderId: string | null;
};

export type HoldList = { enabled: boolean; counts: Record<HoldState, number>; holds: HoldSummary[] };

export type HoldDecisionRecord = {
  decisionId: string;
  decision: HoldDecision;
  reason: string;
  priorState: string;
  resultingState: string;
  resultingOrderId: string | null;
  decidedAt: string;
};

export type RecordedLine = { itemId: string; quantity: number; unitPrice: string; lineTotal: string };

export type HoldDetail = HoldSummary & {
  payload: Record<string, unknown>;
  detail: Record<string, unknown>;
  clientVersion: string | null;
  buildJobId: string | null;
  device: { name: string | null; platform: string | null; pairedAt: string | null; revokedAt: string | null; unpairedAt: string | null } | null;
  conflict: { kind: "order" | "hold"; facts: ComparableFacts } | null;
  validDecisions: HoldDecision[];
  stockPreview: { itemId: string; itemName: string | null; before: number; after: number; shortfall: number }[];
  decisions: HoldDecisionRecord[];
};

/** The facts compared side by side for a conflict. */
export type ComparableFacts = {
  occurredAt: string | null;
  employeeId: string | null;
  paymentMethod: string | null;
  total: string | null;
  lines: string[];
};

export const REASON_TEXT: Readonly<Record<string, string>> = {
  after_revocation: "Sold on a till after it was revoked",
  after_unpair: "Sold on a till after it was unpaired",
  identity_conflict: "A different sale already uses this reference",
  not_this_device: "Another till already used this reference",
  identity_version_mismatch: "An older app already used this reference",
  build_not_pinned_by_device: "Priced with a menu version this till never had",
  price_mismatch: "Prices on the till differ from that menu version",
  time_out_of_bounds: "The sale time is in the future or before the till was paired",
  attribution_after_removal_delivered: "Rung up by an employee the till already knew was removed",
  attribution_invalid: "The employee or register on the sale does not belong to this till",
  unconfirmed_attempt: "A sale whose outcome the till could not confirm",
};

export const DECISION_TEXT: Readonly<Record<HoldDecision, string>> = {
  accept_as_recorded: "Accept as recorded",
  accept_unattributed: "Accept without an employee",
  record_as_separate: "Record as a separate sale",
  decline: "Decline",
};

export function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? reason;
}

/** The effect a confirmation must name before the decision is sent. */
export function decisionEffect(decision: HoldDecision, total: string | null): string {
  const amount = total === null ? "this sale" : `this $${total} sale`;
  switch (decision) {
    case "accept_as_recorded":
      return `Records ${amount} exactly as the till recorded it and reduces stock once.`;
    case "accept_unattributed":
      return `Records ${amount} with no employee and reduces stock once.`;
    case "record_as_separate":
      return `Records ${amount} as a new sale; the existing sale is not changed.`;
    case "decline":
      return `Does not record ${amount}. Stock is not changed. The held sale stays on file.`;
  }
}

/** WEB-6 — a negative level reads as oversold (negative stock itself stays OFF until activation). */
export function formatStockLevel(level: number): string {
  return level < 0 ? `−${Math.abs(level)} (oversold)` : String(level);
}

export function stockPreviewText(p: { itemName: string | null; itemId: string; before: number; after: number; shortfall: number }): string {
  const name = p.itemName ?? p.itemId;
  const base = `Accepting will reduce ${name} from ${formatStockLevel(p.before)} to ${formatStockLevel(p.after)}`;
  return p.shortfall > 0 ? `${base} (${p.shortfall} short)` : base;
}

/** Field-by-field differences between the held sale and what it conflicts with. */
export function compareFacts(held: ComparableFacts, other: ComparableFacts): (keyof ComparableFacts)[] {
  const keys: (keyof ComparableFacts)[] = ["occurredAt", "employeeId", "paymentMethod", "total", "lines"];
  return keys.filter((k) => {
    // Two spellings of one instant (microseconds vs whole seconds) are the same time.
    if (k === "occurredAt" && held[k] !== null && other[k] !== null) {
      return Math.floor(Date.parse(held[k] as string) / 1000) !== Math.floor(Date.parse(other[k] as string) / 1000);
    }
    return JSON.stringify(held[k]) !== JSON.stringify(other[k]);
  });
}

// ---------------------------------------------------------------------------
// Parsing (defensive: anything unexpected is refused rather than shown wrong)
// ---------------------------------------------------------------------------
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const STATES = new Set(["held", "accepted", "declined"]);
const DECISIONS = new Set(["accept_as_recorded", "accept_unattributed", "record_as_separate", "decline"]);

function parseSummary(v: unknown): HoldSummary | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const holdId = s(r.holdId);
  const state = s(r.state);
  if (holdId === null || state === null || !STATES.has(state) || s(r.reason) === null || s(r.receivedAt) === null) return null;
  return {
    holdId,
    saleRequestId: s(r.saleRequestId) ?? "",
    reason: s(r.reason) as string,
    state: state as HoldState,
    receivedAt: s(r.receivedAt) as string,
    decidedAt: s(r.decidedAt),
    deviceName: s(r.deviceName),
    pairedDeviceId: s(r.pairedDeviceId) ?? "",
    employeeName: s(r.employeeName),
    employeeId: s(r.employeeId),
    total: s(r.total),
    paymentMethod: s(r.paymentMethod),
    occurredAt: s(r.occurredAt),
    orderId: s(r.orderId),
  };
}

export function parseHoldList(v: unknown): HoldList | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.enabled !== "boolean" || !Array.isArray(r.holds)) return null;
  const holds = r.holds.map(parseSummary);
  if (holds.some((h) => h === null)) return null;
  const c = (r.counts ?? {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" ? x : 0);
  return { enabled: r.enabled, counts: { held: n(c.held), accepted: n(c.accepted), declined: n(c.declined) }, holds: holds as HoldSummary[] };
}

function linesOf(lines: unknown, from: "payload" | "order"): string[] {
  if (!Array.isArray(lines)) return [];
  return lines.map((l) => {
    const x = l as Record<string, unknown>;
    return from === "payload"
      ? `${s(x.itemId)} × ${x.quantity} @ ${s(x.unitPrice)} = ${s(x.lineTotal)}`
      : `${s(x.itemId)} × ${x.quantity} @ ${s(x.unitPrice)} = ${s(x.lineTotal)}`;
  });
}

export function heldFacts(payload: Record<string, unknown>): ComparableFacts {
  return {
    occurredAt: s(payload.occurredAt),
    employeeId: s(payload.employeeId),
    paymentMethod: s(payload.paymentMethod),
    total: s(payload.total),
    lines: linesOf(payload.lines, "payload"),
  };
}

export function parseHoldDetail(v: unknown): HoldDetail | null {
  const summary = parseSummary(v);
  if (summary === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.payload !== "object" || r.payload === null || !Array.isArray(r.validDecisions) || !Array.isArray(r.decisions)) return null;
  const valid = (r.validDecisions as unknown[]).filter((d): d is HoldDecision => typeof d === "string" && DECISIONS.has(d));

  let conflict: HoldDetail["conflict"] = null;
  const c = r.conflict as Record<string, unknown> | null;
  if (c && c.kind === "order" && typeof c.order === "object" && c.order !== null) {
    const o = c.order as Record<string, unknown>;
    const attribution = (o.attribution ?? {}) as Record<string, unknown>;
    conflict = {
      kind: "order",
      facts: {
        occurredAt: s(o.occurredAt),
        employeeId: s(attribution.employeeId),
        paymentMethod: s(o.paymentMethod),
        total: s(o.total),
        lines: linesOf(o.items, "order"),
      },
    };
  } else if (c && c.kind === "hold" && typeof c.payload === "object" && c.payload !== null) {
    conflict = { kind: "hold", facts: heldFacts(c.payload as Record<string, unknown>) };
  }

  const device = (r.device ?? null) as Record<string, unknown> | null;
  return {
    ...summary,
    payload: r.payload as Record<string, unknown>,
    detail: (typeof r.detail === "object" && r.detail !== null ? r.detail : {}) as Record<string, unknown>,
    clientVersion: s(r.clientVersion),
    buildJobId: s(r.buildJobId),
    device: device === null ? null : {
      name: s(device.name), platform: s(device.platform), pairedAt: s(device.pairedAt),
      revokedAt: s(device.revokedAt), unpairedAt: s(device.unpairedAt),
    },
    conflict,
    validDecisions: valid,
    stockPreview: Array.isArray(r.stockPreview)
      ? (r.stockPreview as Record<string, unknown>[]).map((p) => ({
          itemId: s(p.itemId) ?? "", itemName: s(p.itemName),
          before: Number(p.before), after: Number(p.after), shortfall: Number(p.shortfall),
        }))
      : [],
    decisions: (r.decisions as Record<string, unknown>[]).map((d) => ({
      decisionId: s(d.decisionId) ?? "",
      decision: s(d.decision) as HoldDecision,
      reason: s(d.reason) ?? "",
      priorState: s(d.priorState) ?? "",
      resultingState: s(d.resultingState) ?? "",
      resultingOrderId: s(d.resultingOrderId),
      decidedAt: s(d.decidedAt) ?? "",
    })),
  };
}

// ---------------------------------------------------------------------------
// RPCs
// ---------------------------------------------------------------------------
export type HoldFilters = { state: HoldState | null; reason: string | null; deviceId: string | null; from: string | null; to: string | null };

export async function fetchHoldList(projectId: string, f: HoldFilters): Promise<{ list: HoldList | null; error: string | null }> {
  const { data, error } = await createClient().rpc("list_sale_holds", {
    p_project_id: projectId, p_state: f.state, p_reason: f.reason, p_device_id: f.deviceId,
    p_from: f.from, p_to: f.to, p_limit: 200,
  });
  if (error) return { list: null, error: error.message };
  const list = parseHoldList(data);
  return list === null ? { list: null, error: "Invalid response from held sales." } : { list, error: null };
}

export async function fetchHoldDetail(holdId: string): Promise<{ detail: HoldDetail | null; error: string | null }> {
  const { data, error } = await createClient().rpc("get_sale_hold", { p_hold_id: holdId });
  if (error) return { detail: null, error: error.message };
  const detail = parseHoldDetail(data);
  return detail === null ? { detail: null, error: "Invalid response for this held sale." } : { detail, error: null };
}

export async function submitHoldDecision(input: { holdId: string; decision: HoldDecision; reason: string; decisionId: string }) {
  const { data, error } = await createClient().rpc("decide_sale_hold", {
    p_hold_id: input.holdId, p_decision: input.decision, p_reason: input.reason, p_decision_id: input.decisionId,
  });
  if (error) return { ok: false as const, error: error.message };
  const r = (data ?? {}) as Record<string, unknown>;
  return { ok: true as const, state: s(r.state), orderId: s(r.orderId), error: null };
}
