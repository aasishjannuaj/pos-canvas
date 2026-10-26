// Batch A (Inventory foundations) — the owner's audited stock actions.
//
//   inventory_receive  "Received +N"  adds N to current stock
//   inventory_count    "Counted = N"  sets stock to the physical count
//   set_item_tracking                 turns stock tracking on or off
//
// All three are owner-only, audited and REQUEST-BOUND on the server
// (supabase/migrations/20261024120000_inventory_foundations.sql): a request id is
// bound to the business, the action, the item and the input. An exact retry
// returns the stored result and changes nothing; any changed payload under the
// same id is refused as request_conflict, also without changing anything.
//
// The client's half of that contract is to REUSE the request id when it retries
// the SAME submission — a reply lost after the server committed must not apply
// the action twice — and to mint a new one for anything else. createRequestKeeper
// is that rule, kept pure so it can be tested on its own.
import { createClient } from "@/lib/supabase/client";

export type InventoryAction = "receive" | "count" | "tracking";

export type InventoryActionResult = {
  action: InventoryAction;
  itemId: string;
  before: number | boolean;
  after: number | boolean;
  replayed: boolean;
  /** Batch B — authoritative catalog version after this call (current, also on replay). */
  catalogVersion: number | null;
  /** Batch B — version the server held when it authorized this action; null on a replay. */
  catalogVersionBefore: number | null;
};

function createRequestId(): string {
  return crypto.randomUUID();
}

/**
 * One pending request id per submission key (action + item + input).
 *
 * `idFor` returns the SAME id for the same key until `settle` is called for it —
 * so pressing the button again after an error or a timeout retries the original
 * request — and a fresh id for any other key. `settle` is called on any
 * DEFINITIVE answer (success, or a refusal the server will repeat).
 */
export function createRequestKeeper(mint: () => string = createRequestId) {
  const pending = new Map<string, string>();

  return {
    idFor(key: string): string {
      const existing = pending.get(key);

      if (existing !== undefined) return existing;

      const id = mint();
      pending.set(key, id);
      return id;
    },
    settle(key: string): void {
      pending.delete(key);
    },
  };
}

export function requestKey(action: InventoryAction, itemId: string, input: number | boolean): string {
  return `${action}|${itemId}|${String(input)}`;
}

export function parseInventoryActionResult(value: unknown): InventoryActionResult | null {
  if (typeof value !== "object" || value === null) return null;

  const row = value as Record<string, unknown>;
  const action = row.action;

  if (action !== "receive" && action !== "count" && action !== "tracking") return null;
  if (typeof row.itemId !== "string" || row.itemId.trim() === "") return null;

  const quantityLike = (v: unknown) => (action === "tracking" ? typeof v === "boolean" : Number.isInteger(v));

  if (!quantityLike(row.before) || !quantityLike(row.after)) return null;

  return {
    action,
    itemId: row.itemId,
    before: row.before as number | boolean,
    after: row.after as number | boolean,
    replayed: row.replayed === true,
    catalogVersion: Number.isInteger(row.catalogVersion) ? (row.catalogVersion as number) : null,
    catalogVersionBefore: Number.isInteger(row.catalogVersionBefore) ? (row.catalogVersionBefore as number) : null,
  };
}

/** Is this server refusal DEFINITIVE (retrying the same request would get the same answer)? */
export function isDefinitiveInventoryActionError(message: string): boolean {
  return [
    "request_conflict",
    "Project not found or access denied",
    "Menu item not found",
    "Turn on stock tracking first",
    "Quantity must be",
    "Counted must be",
    "enabled must be",
  ].some((fragment) => message.includes(fragment));
}

export function describeInventoryActionError(message: string): string {
  if (message.includes("request_conflict")) {
    return "This request was already used for a different stock change. Nothing was changed; try again.";
  }
  if (message.includes("Turn on stock tracking first")) {
    return "Turn on stock tracking for this item first.";
  }
  if (message.includes("Project not found or access denied")) {
    return "You can only change stock for your own business.";
  }
  if (message.includes("Quantity must be")) {
    return "Received quantity must be a whole number from 1 to 1,000,000.";
  }
  if (message.includes("Counted must be")) {
    return "Counted quantity must be a whole number of 0 or more.";
  }
  return message;
}

async function callAction(
  fn: "inventory_receive" | "inventory_count" | "set_item_tracking",
  args: Record<string, unknown>
): Promise<{ result: InventoryActionResult | null; error: string | null }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc(fn, args);

  if (error) return { result: null, error: error.message };

  const result = parseInventoryActionResult(data);

  return result === null
    ? { result: null, error: "Invalid response from the stock action." }
    : { result, error: null };
}

export function receiveInventory(input: { projectId: string; itemId: string; quantity: number; requestId: string; note?: string | null }) {
  return callAction("inventory_receive", {
    p_project_id: input.projectId,
    p_item_id: input.itemId,
    p_quantity: input.quantity,
    p_request_id: input.requestId,
    p_note: input.note ?? null,
  });
}

export function countInventory(input: { projectId: string; itemId: string; counted: number; requestId: string; note?: string | null }) {
  return callAction("inventory_count", {
    p_project_id: input.projectId,
    p_item_id: input.itemId,
    p_counted: input.counted,
    p_request_id: input.requestId,
    p_note: input.note ?? null,
  });
}

export function setItemTracking(input: { projectId: string; itemId: string; enabled: boolean; requestId: string; note?: string | null }) {
  return callAction("set_item_tracking", {
    p_project_id: input.projectId,
    p_item_id: input.itemId,
    p_enabled: input.enabled,
    p_request_id: input.requestId,
    p_note: input.note ?? null,
  });
}
