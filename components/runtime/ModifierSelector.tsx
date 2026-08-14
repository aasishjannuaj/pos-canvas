"use client";

// Feature 18.2 — the ONE modifier selector, shared by every POS surface:
// the Builder preview, the owner runtime, and the paired-device runtime. It is
// mounted by ProductBrowser (components/editor/pos-layouts/index.tsx), which is
// the single point all three surfaces and all three layouts pass through, so
// there is deliberately no per-template or per-layout modifier behavior.
//
// TRUST MODEL: every number shown here is an ESTIMATE for the cashier. The
// price actually charged is recomputed by complete_sale_v3 from the authorized
// config and comes back on the receipt. Nothing selected here is trusted by the
// server — the checkout payload carries option IDENTIFIERS only.
//
// The validation rules are imported from lib/modifiers.ts rather than restated,
// so the selector, the cart and the SQL cannot drift apart.
import { useMemo, useState } from "react";
import {
  MAX_SELECTED_OPTIONS_PER_LINE,
  calculateModifiedUnitPrice,
  countSelectedOptions,
  validateModifierSelections,
} from "@/lib/modifiers";
import type { ModifierGroup, ModifierSelection } from "@/lib/modifiers";
import type { CartModifierSelection } from "@/lib/cart";
import type { MenuItem } from "@/lib/projectConfig";

type ModifierSelectorProps = {
  item: MenuItem;
  groups: ModifierGroup[];
  currencySymbol: string;
  accentColor: string;
  onCancel: () => void;
  onConfirm: (selections: CartModifierSelection[]) => void;
};

/** Describes a group's rule in one short phrase the cashier can act on. */
export function describeGroupRule(group: ModifierGroup): string {
  if (group.selection === "single") {
    return group.required ? "Required · choose one" : "Optional · choose one";
  }

  const max =
    group.maxSelections === null ? "" : ` · up to ${group.maxSelections}`;

  return `${group.required ? "Required" : "Optional"} · choose any${max}`;
}

export default function ModifierSelector({
  item,
  groups,
  currencySymbol,
  accentColor,
  onCancel,
  onConfirm,
}: ModifierSelectorProps) {
  // Selection lives ONLY here until Add to Cart. Cancelling unmounts the
  // component and the state goes with it — nothing partial is ever persisted
  // or handed to the cart.
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  const selections: ModifierSelection[] = useMemo(
    () =>
      groups
        .map((group) => ({ groupId: group.id, optionIds: selected[group.id] ?? [] }))
        .filter((entry) => entry.optionIds.length > 0),
    [groups, selected]
  );

  const validation = validateModifierSelections(groups, selections);
  const unitPrice = calculateModifiedUnitPrice(item.price, groups, selections);

  // Feature 18.2 Phase 5A — the per-LINE ceiling, which is separate from any
  // group's own maximum: checkout (and complete_sale_v3's c_max_mod_selected)
  // bound the total options across every group of one line. Before this, ticking
  // the 51st box simply greyed out Add to Cart with nothing said about why.
  //
  // Takes a selection map rather than reading `selected`, so the state updater
  // below can ask the question of `prev` instead of a render-time closure.
  // Counted over `groups`, so a stale key for a group that no longer exists
  // cannot inflate the total.
  function isAtLineLimit(chosen: Record<string, string[]>): boolean {
    const entries = groups.map((group) => ({
      groupId: group.id,
      optionIds: chosen[group.id] ?? [],
    }));

    return countSelectedOptions(entries) >= MAX_SELECTED_OPTIONS_PER_LINE;
  }

  const atLineLimit = isAtLineLimit(selected);

  function toggle(group: ModifierGroup, optionId: string) {
    setSelected((prev) => {
      const current = prev[group.id] ?? [];

      if (group.selection === "single") {
        // Radio behavior: re-tapping the chosen option clears it, which is the
        // only way to empty an optional single group.
        return { ...prev, [group.id]: current[0] === optionId ? [] : [optionId] };
      }

      if (current.includes(optionId)) {
        return { ...prev, [group.id]: current.filter((id) => id !== optionId) };
      }

      // Checkbox behavior, refusing the tap that would exceed the maximum
      // rather than silently dropping an earlier choice.
      if (group.maxSelections !== null && current.length >= group.maxSelections) {
        return prev;
      }

      // Same treatment for the per-line ceiling. Refusing the tap keeps
      // validation.ok true, so Add to Cart never goes dead for a reason the
      // cashier has no way to see; the footer explains the ceiling instead.
      if (isAtLineLimit(prev)) {
        return prev;
      }

      return { ...prev, [group.id]: [...current, optionId] };
    });
  }

  function handleConfirm() {
    if (!validation.ok) {
      return;
    }

    // Carry display names/prices into the cart line for rendering. The payload
    // built from this at checkout keeps only ids (lib/cart.ts's
    // toModifierSelections), so none of it ever reaches the server.
    const cartSelections: CartModifierSelection[] = groups
      .map((group) => ({
        groupId: group.id,
        groupName: group.name,
        options: group.options.filter((option) =>
          (selected[group.id] ?? []).includes(option.id)
        ),
      }))
      .filter((group) => group.options.length > 0);

    onConfirm(cartSelections);
  }

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col bg-white"
      role="dialog"
      aria-modal="true"
      aria-label={`Options for ${item.name}`}
    >
      <header className="flex-none border-b border-neutral-200 px-4 py-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
          Choose options
        </p>
        <h2 className="mt-0.5 text-base font-semibold text-neutral-900">{item.name}</h2>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {groups.map((group) => {
          const chosen = selected[group.id] ?? [];
          const atMax =
            group.selection === "multiple" &&
            group.maxSelections !== null &&
            chosen.length >= group.maxSelections;

          // The per-line ceiling closes further ADDITIONS the same way a group
          // maximum does. Only multiple-choice groups are affected: tapping a
          // single-choice option replaces rather than adds, so it never grows
          // the total and must stay available even at the ceiling.
          const atCapacity = atMax || (group.selection === "multiple" && atLineLimit);

          return (
            <section key={group.id} className="mb-5 last:mb-0">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium text-neutral-900">{group.name}</h3>
                <span
                  className={`text-[11px] font-medium ${
                    group.required ? "text-neutral-600" : "text-neutral-400"
                  }`}
                >
                  {describeGroupRule(group)}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                {group.options.map((option) => {
                  const isChosen = chosen.includes(option.id);
                  // A group at its capacity greys out only the options not
                  // already chosen, so a cashier can still deselect to change
                  // their mind.
                  const disabled = atCapacity && !isChosen;

                  return (
                    <button
                      key={option.id}
                      type="button"
                      role={group.selection === "single" ? "radio" : "checkbox"}
                      aria-checked={isChosen}
                      disabled={disabled}
                      onClick={() => toggle(group, option.id)}
                      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                        isChosen
                          ? "border-neutral-900 bg-neutral-50 text-neutral-900"
                          : disabled
                            ? "cursor-not-allowed border-neutral-100 text-neutral-300"
                            : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className={`inline-block h-3.5 w-3.5 flex-none border ${
                            group.selection === "single" ? "rounded-full" : "rounded-[3px]"
                          } ${isChosen ? "border-neutral-900 bg-neutral-900" : "border-neutral-300"}`}
                        />
                        {option.name}
                      </span>

                      {/* A zero adjustment is not shown: "+$0.00" is noise. */}
                      {option.priceAdjustment > 0 && (
                        <span className="flex-none tabular-nums text-neutral-500">
                          +{currencySymbol}
                          {option.priceAdjustment.toFixed(2)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <footer className="flex-none border-t border-neutral-200 px-4 py-3">
        {/* Says why further options stopped responding. Only ever visible on a
            product whose groups collectively allow more than the ceiling —
            ModifierGroupsEditor warns the owner about exactly that shape while
            they are authoring it. */}
        {atLineLimit && (
          <p aria-live="polite" className="mb-2 text-xs text-amber-700">
            Limit of {MAX_SELECTED_OPTIONS_PER_LINE} options reached for this item.
          </p>
        )}

        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-xs text-neutral-500">Item total</span>
          <span className="text-base font-semibold tabular-nums text-neutral-900">
            {currencySymbol}
            {unitPrice.toFixed(2)}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-none rounded-lg border border-neutral-200 px-4 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleConfirm}
            disabled={!validation.ok}
            style={validation.ok ? { backgroundColor: accentColor } : undefined}
            className="flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
          >
            Add to Cart
          </button>
        </div>
      </footer>
    </div>
  );
}
