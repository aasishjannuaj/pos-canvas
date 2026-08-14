"use client";

// Feature 18.2 Phase 4 — owner modifier authoring, rendered underneath the
// selected menu item's existing fields.
//
// Purely presentational. Every state change goes through the pure operations in
// lib/modifierAuthoring.ts and leaves through a single `onChange(groups)` call,
// which EditorPropertiesPanel forwards to the EXISTING handleUpdateItem — the
// same path Item Name, Price and Stock Quantity already use. This component
// holds no state of its own, owns no ids, and knows nothing about saving,
// building or Supabase.
import {
  MAX_MODIFIER_GROUPS_PER_ITEM,
  MAX_OPTIONS_PER_GROUP,
} from "@/lib/modifiers";
import type { ModifierGroup } from "@/lib/modifiers";
import {
  addModifierGroup,
  addModifierOption,
  canAddModifierGroup,
  canAddModifierOption,
  createModifierId,
  getItemSelectionCapacityNotice,
  getModifierGroupNotice,
  removeModifierGroup,
  removeModifierOption,
  setModifierGroupMaxSelections,
  setModifierGroupSelection,
  updateModifierGroup,
  updateModifierOption,
} from "@/lib/modifierAuthoring";

type ModifierGroupsEditorProps = {
  groups: ModifierGroup[];
  currencySymbol: string;
  onChange: (groups: ModifierGroup[]) => void;
};

const FIELD_CLASS =
  "rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none";

const LABEL_CLASS =
  "text-xs font-medium uppercase tracking-wide text-neutral-400";

export default function ModifierGroupsEditor({
  groups,
  currencySymbol,
  onChange,
}: ModifierGroupsEditorProps) {
  // Feature 18.2 Phase 5A — the per-ITEM ceiling, which no per-group control can
  // express: checkout bounds the total options selected on ONE line, so the
  // limit emerges from the groups collectively. Null for every realistic menu.
  const capacityNotice = getItemSelectionCapacityNotice(groups);

  return (
    <div className="flex flex-col gap-3 border-t border-neutral-200 pt-4">
      <div className="flex items-center justify-between">
        <span className={LABEL_CLASS}>Modifiers</span>
        {groups.length > 0 && (
          <span className="text-xs text-neutral-400">
            {groups.length} of {MAX_MODIFIER_GROUPS_PER_ITEM}
          </span>
        )}
      </div>

      {capacityNotice && (
        <p className="text-xs text-amber-700">{capacityNotice}</p>
      )}

      {/* Feature 18.2 — the backward-compatible empty state. Reached by an item
          whose modifierGroups key is absent entirely (any project saved before
          Feature 18.1) and by one holding [], because normalizeModifierGroups
          resolves both to the same empty list. */}
      {groups.length === 0 && (
        <p className="text-sm text-neutral-500">No modifiers</p>
      )}

      {groups.map((group) => {
        const notice = getModifierGroupNotice(group);

        return (
          <div
            key={group.id}
            className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-3"
          >
            <div className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-1.5">
                <label className={LABEL_CLASS}>Group Name</label>
                <input
                  type="text"
                  value={group.name}
                  placeholder="Size"
                  onChange={(event) =>
                    onChange(
                      updateModifierGroup(groups, group.id, {
                        name: event.target.value,
                      })
                    )
                  }
                  className={FIELD_CLASS}
                />
              </div>

              <button
                type="button"
                onClick={() => onChange(removeModifierGroup(groups, group.id))}
                aria-label={`Delete ${group.name.trim() || "group"}`}
                className="rounded-lg border border-neutral-200 px-3 py-2 text-xs font-medium text-neutral-600 transition-colors hover:border-red-500 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
              >
                Delete
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={LABEL_CLASS}>Selection</label>
              <select
                value={group.selection}
                onChange={(event) =>
                  onChange(
                    setModifierGroupSelection(
                      groups,
                      group.id,
                      event.target.value === "multiple" ? "multiple" : "single"
                    )
                  )
                }
                className={FIELD_CLASS}
              >
                <option value="single">Single choice</option>
                <option value="multiple">Multiple choice</option>
              </select>
            </div>

            <label className="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 px-3 py-2">
              <span className="text-sm font-medium text-neutral-900">
                Required
              </span>
              <input
                type="checkbox"
                checked={group.required}
                onChange={(event) =>
                  onChange(
                    updateModifierGroup(groups, group.id, {
                      required: event.target.checked,
                    })
                  )
                }
                className="h-4 w-4 cursor-pointer accent-blue-600"
              />
            </label>

            {/* Max selections is meaningless for a single-choice group — the
                selection type already implies a maximum of one — so it is not
                rendered at all rather than shown disabled. */}
            {group.selection === "multiple" && (
              <div className="flex flex-col gap-1.5">
                <label className={LABEL_CLASS}>Max Selections</label>
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={group.maxSelections ?? ""}
                  placeholder="No limit"
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    onChange(
                      setModifierGroupMaxSelections(
                        groups,
                        group.id,
                        raw === "" ? null : Math.floor(Number(raw))
                      )
                    );
                  }}
                  className={FIELD_CLASS}
                />
              </div>
            )}

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className={LABEL_CLASS}>Options</span>
                <span className="text-xs text-neutral-400">
                  {group.options.length} of {MAX_OPTIONS_PER_GROUP}
                </span>
              </div>

              {group.options.map((option) => (
                <div key={option.id} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={option.name}
                    placeholder="Large"
                    onChange={(event) =>
                      onChange(
                        updateModifierOption(groups, group.id, option.id, {
                          name: event.target.value,
                        })
                      )
                    }
                    className={`${FIELD_CLASS} min-w-0 flex-1`}
                  />

                  <div className="flex items-center gap-1">
                    <span className="text-sm text-neutral-400">
                      {currencySymbol}
                    </span>
                    {/* Matches the item Price field exactly: same type, step and
                        min, and the same `|| 0` treatment of an emptied input.
                        Negative adjustments are out of scope for the MVP, and
                        updateModifierOption floors at 0 as a second line of
                        defense against a pasted or spun-down value. */}
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={option.priceAdjustment}
                      onChange={(event) =>
                        onChange(
                          updateModifierOption(groups, group.id, option.id, {
                            priceAdjustment: Number(event.target.value) || 0,
                          })
                        )
                      }
                      className={`${FIELD_CLASS} w-20`}
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      onChange(removeModifierOption(groups, group.id, option.id))
                    }
                    aria-label={`Remove ${option.name.trim() || "option"}`}
                    className="rounded-lg border border-neutral-200 px-2 py-2 text-xs font-medium text-neutral-500 transition-colors hover:border-red-500 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
                  >
                    Remove
                  </button>
                </div>
              ))}

              <button
                type="button"
                onClick={() =>
                  onChange(addModifierOption(groups, group.id, createModifierId))
                }
                disabled={!canAddModifierOption(group)}
                className="rounded-full border border-neutral-200 px-4 py-2 text-xs font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {canAddModifierOption(group)
                  ? "Add option"
                  : `Limit of ${MAX_OPTIONS_PER_GROUP} options reached`}
              </button>
            </div>

            {/* What the save will actually do with this group, sourced from
                normalizeModifierGroups itself rather than from a restatement of
                its rules. Null while the group is already saveable as authored. */}
            {notice && <p className="text-xs text-amber-700">{notice}</p>}
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => onChange(addModifierGroup(groups, createModifierId))}
        disabled={!canAddModifierGroup(groups)}
        className="rounded-full border border-neutral-200 px-4 py-2 text-xs font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {canAddModifierGroup(groups)
          ? "Add modifier group"
          : `Limit of ${MAX_MODIFIER_GROUPS_PER_ITEM} groups reached`}
      </button>
    </div>
  );
}
