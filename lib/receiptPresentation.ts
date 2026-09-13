// Feature 28C — what a receipt is printed WITH, as opposed to what it says.
//
// THE DEFECT THIS CLOSES. Every money value on a receipt was already frozen at
// sale time and replayed unchanged. Everything printed around those numbers was
// not: the business name, address, contact lines, header, footer, currency
// symbol and the show/hide toggles were all read from the CURRENT
// configuration. Editing them re-headed every receipt the shop had ever issued,
// and on a paired till Feature 26's Apply Update did the same thing by moving
// the pinned build.
//
// WHERE THE SALE-TIME VALUES COME FROM. A device sale records
// orders.build_job_id, and that build's config_snapshot is immutable and holds
// the same two objects; an owner sale records orders.receipt_snapshot, because
// no build priced it. get_device_recent_orders resolves whichever applies and
// returns it as `presentation`. An order older than both mechanisms has neither
// — that configuration was never recorded and is not recoverable — so it
// resolves to "current", which is stated rather than disguised.
//
// NORMALIZED, NOT REJECTED — and that is the opposite of how this codebase
// treats money, deliberately. lib/completedSale.ts refuses a malformed payload
// outright because printing a half-understood PRICE is worse than printing an
// error. Nothing here is a price. A snapshot missing showTipLine should cost
// the reader a toggle, not the whole receipt, so each field falls back to the
// product default exactly as lib/generatedPosConfig.ts's toRuntimeSafe*
// functions do for a build snapshot.
//
// PURE. No React, no Supabase, no node builtins.

import { CURRENCY_SYMBOLS, defaultProjectConfig } from "@/lib/projectConfig";
import type {
  BusinessProfile,
  Currency,
  ProjectConfig,
  ReceiptSettings,
} from "@/lib/projectConfig";
import { isNonZeroMoney } from "@/lib/completedSale";

/**
 * Where the presentation came from.
 *
 * Load-bearing, not diagnostic: it decides whether a display toggle is allowed
 * to hide a charged line. See shouldShowChargedLine.
 */
export type ReceiptPresentationSource = "sale_time" | "current";

export type ResolvedReceiptPresentation = {
  businessProfile: BusinessProfile;
  receipt: ReceiptSettings;
  currencySymbol: string;
  source: ReceiptPresentationSource;
};

const DEFAULT_BUSINESS_PROFILE = defaultProjectConfig.businessProfile;
const DEFAULT_RECEIPT = defaultProjectConfig.receipt;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  source: Record<string, unknown>,
  key: string,
  fallback: string
): string {
  const value = source[key];

  return typeof value === "string" ? value : fallback;
}

function readBoolean(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean
): boolean {
  const value = source[key];

  return typeof value === "boolean" ? value : fallback;
}

function readCurrency(source: Record<string, unknown>): Currency {
  const value = source.currency;

  return typeof value === "string" && value in CURRENCY_SYMBOLS
    ? (value as Currency)
    : DEFAULT_RECEIPT.currency;
}

function normalizeBusinessProfile(value: unknown): BusinessProfile {
  if (!isPlainObject(value)) return { ...DEFAULT_BUSINESS_PROFILE };

  return {
    businessName: readString(value, "businessName", DEFAULT_BUSINESS_PROFILE.businessName),
    addressLine1: readString(value, "addressLine1", ""),
    addressLine2: readString(value, "addressLine2", ""),
    city: readString(value, "city", ""),
    state: readString(value, "state", ""),
    postalCode: readString(value, "postalCode", ""),
    phone: readString(value, "phone", ""),
    email: readString(value, "email", ""),
    website: readString(value, "website", ""),
  };
}

function normalizeReceiptSettings(value: unknown): ReceiptSettings {
  if (!isPlainObject(value)) return { ...DEFAULT_RECEIPT };

  return {
    currency: readCurrency(value),
    footer: readString(value, "footer", ""),
    orderPrefix: readString(value, "orderPrefix", DEFAULT_RECEIPT.orderPrefix),
    tipsEnabled: readBoolean(value, "tipsEnabled", DEFAULT_RECEIPT.tipsEnabled),
    showBusinessName: readBoolean(value, "showBusinessName", DEFAULT_RECEIPT.showBusinessName),
    headerMessage: readString(value, "headerMessage", ""),
    showTaxLine: readBoolean(value, "showTaxLine", DEFAULT_RECEIPT.showTaxLine),
    showTipLine: readBoolean(value, "showTipLine", DEFAULT_RECEIPT.showTipLine),
    showPaymentMethod: readBoolean(value, "showPaymentMethod", DEFAULT_RECEIPT.showPaymentMethod),
    showOrderNumber: readBoolean(value, "showOrderNumber", DEFAULT_RECEIPT.showOrderNumber),
  };
}

/**
 * The presentation for a sale being completed RIGHT NOW.
 *
 * Source is "sale_time" because it is: the configuration in hand is the one
 * this sale is being priced from, this instant. A live checkout receipt and an
 * offline one are both this case.
 */
export function saleTimePresentation(config: {
  businessProfile: ProjectConfig["businessProfile"];
  receipt: ProjectConfig["receipt"];
}): ResolvedReceiptPresentation {
  return {
    businessProfile: config.businessProfile,
    receipt: config.receipt,
    currencySymbol: CURRENCY_SYMBOLS[config.receipt.currency],
    source: "sale_time",
  };
}

/**
 * The presentation for a historical sale whose own is not recoverable.
 *
 * Source is "current", which is the honest answer and also the one that stops a
 * toggle set today from hiding a line charged months ago.
 */
export function currentConfigPresentation(config: {
  businessProfile: ProjectConfig["businessProfile"];
  receipt: ProjectConfig["receipt"];
}): ResolvedReceiptPresentation {
  return {
    businessProfile: config.businessProfile,
    receipt: config.receipt,
    currencySymbol: CURRENCY_SYMBOLS[config.receipt.currency],
    source: "current",
  };
}

/**
 * The presentation to print one historical receipt with.
 *
 * `stored` is the `presentation` object from the server, unvalidated. Null,
 * absent or unreadable falls back to the current configuration — a receipt
 * whose header is today's is worse than one whose header is right, and far
 * better than no receipt at all.
 */
export function resolveReceiptPresentation(input: {
  stored: unknown;
  current: { businessProfile: ProjectConfig["businessProfile"]; receipt: ProjectConfig["receipt"] };
}): ResolvedReceiptPresentation {
  if (!isPlainObject(input.stored)) {
    return currentConfigPresentation(input.current);
  }

  // Both halves or neither. Half a snapshot — today's address under a
  // historical business name — would be a receipt that never existed.
  if (!isPlainObject(input.stored.businessProfile) || !isPlainObject(input.stored.receipt)) {
    return currentConfigPresentation(input.current);
  }

  const receipt = normalizeReceiptSettings(input.stored.receipt);

  return {
    businessProfile: normalizeBusinessProfile(input.stored.businessProfile),
    receipt,
    currencySymbol: CURRENCY_SYMBOLS[receipt.currency],
    source: "sale_time",
  };
}

/**
 * May this receipt hide a Tax or Tip line?
 *
 * THE RULE IN ONE SENTENCE: money that contributes to the Total is always
 * shown. A display toggle may suppress only a ZERO line.
 *
 * THIS RULE USED TO CONSULT THE TOGGLE, and staging QA proved that wrong.
 * The first version honoured the toggle whenever it came from the sale's own
 * snapshot, on the reasoning that a setting in force at the time was the
 * owner's genuine choice. ORD-1008 on staging then printed:
 *
 *     Subtotal  $10.00
 *     Total     $12.00
 *
 * with no Tax row, because showTaxLine was off when that sale was rung up —
 * while $2.00 of tax had in fact been charged. A customer reading that slip
 * cannot reconcile it, and no configuration setting should be able to produce
 * one. `showTaxLine`/`showTipLine` therefore govern a zero line only, which is
 * the one case where hiding costs the reader nothing.
 *
 * The presentation SOURCE is still resolved and still matters for the business
 * identity, header and footer — it is simply not consulted here any more,
 * because the answer is the same either way.
 */
export function shouldShowChargedLine(input: { amount: string }): boolean {
  return isNonZeroMoney(input.amount);
}
