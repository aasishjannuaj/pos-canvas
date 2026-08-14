// Feature 18.2 Phase 4 — the pure editing operations behind owner modifier
// authoring.
//
// No React, no Supabase, no storage. The Builder's ModifierGroupsEditor calls
// these and hands the result straight to the existing handleUpdateItem, so
// authoring introduces NO second storage model: everything lives in
// ProjectConfig.menuItems[].modifierGroups, the shape Feature 18.1 already
// defined and that normalizeProjectConfig, createGeneratedPosConfig and the
// build snapshot already carry.
//
// VALIDATION IS NOT RE-IMPLEMENTED HERE. lib/modifiers.ts's
// normalizeModifierGroups is the single authority on what a sellable group is;
// this module calls it as an oracle (previewNormalizedGroup) rather than
// restating any of its rules. A rule that existed in two places would
// eventually disagree with the one that actually reaches checkout.
import {
  MAX_MODIFIER_GROUPS_PER_ITEM,
  MAX_OPTIONS_PER_GROUP,
  MAX_SELECTED_OPTIONS_PER_LINE,
  normalizeModifierGroups,
} from "@/lib/modifiers";
import type {
  ModifierGroup,
  ModifierOption,
  ModifierSelectionType,
} from "@/lib/modifiers";
import type { MenuItem, ProjectConfig } from "@/lib/projectConfig";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Mints a stable id for a new group or option.
 *
 * Follows lib/saleRequest.ts's injectable-crypto convention rather than
 * EditorShell's local createId, so this stays unit-testable without a DOM.
 *
 * WHY STABILITY MATTERS MORE HERE THAN ANYWHERE ELSE IN THE EDITOR: these ids
 * are load-bearing at checkout. canonicalLineIdentity builds a line's identity
 * from the item id plus its group and option ids, complete_sale_v3 hashes that
 * identity, and order_items.modifiers freezes it into order history. Renaming
 * "Large" must never change an id, or two carts that are the same drink stop
 * merging, a retry stops matching its original sale, and historical receipts
 * stop describing what was actually sold.
 *
 * Falls back to a time+random id rather than throwing, matching EditorShell's
 * createId: authoring is local editor state, not a money path, and losing the
 * ability to add a modifier group in an older browser would be a worse outcome
 * than a theoretically weaker id. (createSaleRequestId throws instead, because
 * a colliding id THERE would cross-wire two receipts.)
 */
export function createModifierId(
  cryptoImpl: { randomUUID?: () => string } | null | undefined = globalThis.crypto
): string {
  if (cryptoImpl && typeof cryptoImpl.randomUUID === "function") {
    return cryptoImpl.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type ModifierIdFactory = () => string;

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * A brand-new option: named by the owner, free by default.
 *
 * priceAdjustment starts at 0 rather than empty, matching how the existing item
 * Price field behaves (`Number(value) || 0`), and because a free option is the
 * common case for the first thing anyone adds.
 */
export function createModifierOption(createId: ModifierIdFactory): ModifierOption {
  return { id: createId(), name: "", priceAdjustment: 0 };
}

/**
 * A brand-new group, seeded with one empty option.
 *
 * The seed matters: normalizeModifierGroups drops a group with zero usable
 * options, so a group created empty would be silently unsaveable. Starting with
 * one option row shows the owner the shape they need to fill in.
 */
export function createModifierGroup(createId: ModifierIdFactory): ModifierGroup {
  return {
    id: createId(),
    name: "",
    selection: "single",
    required: false,
    maxSelections: null,
    options: [createModifierOption(createId)],
  };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export function canAddModifierGroup(groups: ModifierGroup[]): boolean {
  return groups.length < MAX_MODIFIER_GROUPS_PER_ITEM;
}

export function canAddModifierOption(group: ModifierGroup): boolean {
  return group.options.length < MAX_OPTIONS_PER_GROUP;
}

// ---------------------------------------------------------------------------
// Group operations
// ---------------------------------------------------------------------------

/** No-op at the cap, so the caller can never exceed it even if the UI slips. */
export function addModifierGroup(
  groups: ModifierGroup[],
  createId: ModifierIdFactory
): ModifierGroup[] {
  if (!canAddModifierGroup(groups)) {
    return groups;
  }

  return [...groups, createModifierGroup(createId)];
}

/** Removes exactly one group. Every other group keeps its id and contents. */
export function removeModifierGroup(
  groups: ModifierGroup[],
  groupId: string
): ModifierGroup[] {
  return groups.filter((group) => group.id !== groupId);
}

/**
 * Edits a group's name or required flag.
 *
 * The Partial is deliberately narrowed to `name` and `required`: id, selection,
 * maxSelections and options each have their own operation, so no caller can
 * reach in and rewrite an id through this door.
 */
export function updateModifierGroup(
  groups: ModifierGroup[],
  groupId: string,
  changes: Partial<Pick<ModifierGroup, "name" | "required">>
): ModifierGroup[] {
  return groups.map((group) =>
    group.id === groupId ? { ...group, ...changes } : group
  );
}

/**
 * Switches a group between single and multiple choice.
 *
 * multiple -> single: maxSelections is cleared, because "single" already means
 * a maximum of one and a leftover number would be a contradiction the
 * normalizer would silently drop anyway. Options and `required` are preserved.
 *
 * single -> multiple: maxSelections starts null ("no explicit maximum"), never
 * a guessed number. Options and `required` are preserved.
 *
 * Options are NEVER removed by a mode switch in either direction — losing an
 * owner's typed options as a side effect of a toggle would be indefensible.
 */
export function setModifierGroupSelection(
  groups: ModifierGroup[],
  groupId: string,
  selection: ModifierSelectionType
): ModifierGroup[] {
  return groups.map((group) =>
    group.id === groupId ? { ...group, selection, maxSelections: null } : group
  );
}

/**
 * Sets the optional per-group maximum. `null` means no explicit maximum.
 *
 * Only meaningful for `multiple`; a call against a `single` group stores null,
 * mirroring the normalizer, which never carries a maximum on a single group.
 *
 * A value larger than the option count is stored as typed and clamped later by
 * normalizeModifierGroups. Clamping here too would be a second implementation
 * of the same rule; getModifierGroupNotice instead shows the owner what the
 * normalizer will actually do.
 */
export function setModifierGroupMaxSelections(
  groups: ModifierGroup[],
  groupId: string,
  maxSelections: number | null
): ModifierGroup[] {
  const next =
    typeof maxSelections === "number" &&
    Number.isInteger(maxSelections) &&
    maxSelections > 0
      ? maxSelections
      : null;

  return groups.map((group) =>
    group.id === groupId
      ? { ...group, maxSelections: group.selection === "multiple" ? next : null }
      : group
  );
}

// ---------------------------------------------------------------------------
// Option operations
// ---------------------------------------------------------------------------

export function addModifierOption(
  groups: ModifierGroup[],
  groupId: string,
  createId: ModifierIdFactory
): ModifierGroup[] {
  return groups.map((group) => {
    if (group.id !== groupId || !canAddModifierOption(group)) {
      return group;
    }

    return { ...group, options: [...group.options, createModifierOption(createId)] };
  });
}

/** Removes exactly one option from exactly one group. */
export function removeModifierOption(
  groups: ModifierGroup[],
  groupId: string,
  optionId: string
): ModifierGroup[] {
  return groups.map((group) =>
    group.id === groupId
      ? { ...group, options: group.options.filter((option) => option.id !== optionId) }
      : group
  );
}

/**
 * Edits an option's name or price adjustment.
 *
 * priceAdjustment is floored at 0 here: negative modifiers are deliberately out
 * of the MVP, and normalizeModifierGroups DROPS a negative option rather than
 * coercing it — so letting a negative into the draft would mean the owner types
 * a discount, sees it in the editor, and silently loses the whole option on
 * save. Clamping at the input is the honest behavior.
 *
 * The value is otherwise stored exactly as typed. It is NOT rounded: SQL's
 * round(numeric, 2) and JavaScript's Math.round(x * 100) / 100 disagree at
 * half-cent boundaries, and complete_sale_v3 is the authority on money.
 */
export function updateModifierOption(
  groups: ModifierGroup[],
  groupId: string,
  optionId: string,
  changes: Partial<Pick<ModifierOption, "name" | "priceAdjustment">>
): ModifierGroup[] {
  const safeChanges: Partial<ModifierOption> = { ...changes };

  if (typeof safeChanges.priceAdjustment === "number") {
    safeChanges.priceAdjustment = Number.isFinite(safeChanges.priceAdjustment)
      ? Math.max(0, safeChanges.priceAdjustment)
      : 0;
  }

  return groups.map((group) =>
    group.id === groupId
      ? {
          ...group,
          options: group.options.map((option) =>
            option.id === optionId ? { ...option, ...safeChanges } : option
          ),
        }
      : group
  );
}

// ---------------------------------------------------------------------------
// The authoring render input
//
// Feature 18.2 Phase 5B — the fix for a Phase 4 defect found in manual
// validation: "Add modifier group" appeared to do nothing.
//
// WHAT WENT WRONG. EditorPropertiesPanel rendered the editor with
// `normalizeModifierGroups(selectedItem.modifierGroups)`. That function is the
// PERSISTENCE authority: its whole job is to delete anything not sellable. A
// brand-new group is `{ name: "", options: [{ name: "" }] }`, which is exactly
// what it deletes — so the group was written into the draft, then dropped on the
// way back to the screen. The owner saw nothing, while the raw draft kept it and
// the save blocker correctly reported it.
//
// It was destructive in three further ways, all reproduced before this fix:
//   - Clearing an existing group's NAME made the whole group and its options
//     vanish from the UI. The next edit was then computed from a list that no
//     longer contained it, so the options were lost outright.
//   - A typed Max Selections above the option count was rewritten in the draft,
//     contradicting getModifierGroupNotice, which promises to say what the SAVE
//     will do to a value the draft still holds.
//   - Names could not keep a trailing space, because every render trimmed them.
//
// THE RULE THIS ESTABLISHES: destructive normalization belongs at the three
// PERSISTENCE/RUNTIME boundaries (load, save, build) and nowhere near the
// authoring render input. An editor must show the owner what they actually
// typed; telling them what will be saved is getModifierGroupNotice's job.
// ---------------------------------------------------------------------------

/**
 * The groups the authoring UI renders: the RAW draft, unmodified.
 *
 * The only transformation is the absent/legacy case — a project saved before
 * Feature 18.1 has no `modifierGroups` key at all, and must read as an empty
 * list rather than crash. Nothing is dropped, trimmed, clamped or reordered.
 *
 * Element shape is guaranteed upstream: EditorShell seeds its state through
 * normalizeProjectConfig, which runs normalizeModifierGroups at LOAD, so
 * anything malformed in storage is already gone before authoring begins. This
 * function deliberately does not re-run that check — doing so is precisely the
 * defect it exists to remove.
 */
export function toEditableModifierGroups(
  groups: ModifierGroup[] | undefined
): ModifierGroup[] {
  return Array.isArray(groups) ? groups : [];
}

// ---------------------------------------------------------------------------
// Telling the owner what will actually be saved
// ---------------------------------------------------------------------------

/**
 * What normalizeModifierGroups would make of this one group — the authority
 * itself, called as an oracle, never a paraphrase of its rules.
 *
 * `null` means the group would not survive a save at all.
 */
export function previewNormalizedGroup(group: ModifierGroup): ModifierGroup | null {
  return normalizeModifierGroups([group])[0] ?? null;
}

/**
 * A short, honest sentence about a group that will not save as authored — or
 * null when what you see is exactly what gets saved.
 *
 * This exists because the Builder writes every keystroke straight into the
 * draft config (the long-standing behavior for item name, price and category),
 * so a half-finished group IS in the draft. Rather than blocking typing, the
 * editor stays free-form and says plainly what the save will do.
 */
export function getModifierGroupNotice(group: ModifierGroup): string | null {
  const normalized = previewNormalizedGroup(group);

  if (normalized === null) {
    if (group.name.trim() === "") {
      return "Name this group so it can be saved.";
    }

    return "Add at least one option with a name so this group can be saved.";
  }

  if (normalized.options.length < group.options.length) {
    const dropped = group.options.length - normalized.options.length;
    return dropped === 1
      ? "1 option needs a name before it can be saved."
      : `${dropped} options need names before they can be saved.`;
  }

  if (
    group.maxSelections !== null &&
    normalized.maxSelections !== null &&
    normalized.maxSelections !== group.maxSelections
  ) {
    return `Saved as a maximum of ${normalized.maxSelections}, because this group has ${normalized.options.length} options.`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// The per-ITEM selection ceiling
//
// Feature 18.2 Phase 5A. The caps are per group (10 groups, 20 options each),
// but checkout also bounds the TOTAL options selected on one line at
// MAX_SELECTED_OPTIONS_PER_LINE — enforced identically by
// validateModifierSelections here and by c_max_mod_selected in
// complete_sale_v3. Nothing in authoring previously mentioned that third limit,
// so an owner could build 10 unlimited multiple-choice groups of 20 options
// (200 selectable) with no hint that a cashier would be stopped at 50.
//
// This is deliberately a NOTICE, not a new cap. Two reasons:
//
//   1. A cap in authoring would be the wrong shape. The limit constrains one
//      SALE, not one menu. A pizza with 6 toppings groups is legitimate; only a
//      cashier ticking 51 boxes on a single line is not. Refusing the 51st
//      option at authoring time would forbid menus that sell perfectly well.
//   2. The runtime already fails safe. ModifierSelector validates through
//      validateModifierSelections, which includes this exact rule, so a
//      selection over the ceiling can never be added to a cart, let alone
//      submitted. What was missing was an EXPLANATION, on both surfaces.
// ---------------------------------------------------------------------------

/**
 * The most options a cashier could ever select on one line of this product.
 *
 * A single-choice group contributes 1. A multiple-choice group contributes its
 * explicit maximum, or its whole option count when it has none.
 *
 * Computed over the groups AS AUTHORED (the live draft), not the normalized
 * ones, because the point is to warn while the owner is still editing.
 */
export function getMaxSelectableOptions(groups: ModifierGroup[]): number {
  return groups.reduce((total, group) => {
    if (group.selection === "single") {
      return total + 1;
    }

    return total + (group.maxSelections ?? group.options.length);
  }, 0);
}

/**
 * A sentence about this product's groups collectively exceeding the per-sale
 * ceiling — or null, which is the case for every realistic menu.
 *
 * Names the actual numbers rather than a rule, and names the fix (a maximum on
 * the multiple-choice groups), since that is the only lever the owner has.
 */
export function getItemSelectionCapacityNotice(
  groups: ModifierGroup[]
): string | null {
  const capacity = getMaxSelectableOptions(groups);

  if (capacity <= MAX_SELECTED_OPTIONS_PER_LINE) {
    return null;
  }

  return `These groups allow up to ${capacity} options on one item, but a sale accepts at most ${MAX_SELECTED_OPTIONS_PER_LINE}. Set a Max Selections on the multiple-choice groups to stay within it.`;
}

// ---------------------------------------------------------------------------
// The save boundary
// ---------------------------------------------------------------------------

/**
 * True when saving this group would LOSE something the owner typed.
 *
 * Two cases, both read from the normalizer itself rather than restated: the
 * group would not survive at all, or some of its options would be dropped.
 *
 * The maxSelections clamp is deliberately NOT lossy: a maximum above the option
 * count means the same thing after clamping, getModifierGroupNotice already
 * explains it, and blocking a save for it would be obstruction rather than
 * protection.
 */
export function isModifierGroupLossy(group: ModifierGroup): boolean {
  const normalized = previewNormalizedGroup(group);

  if (normalized === null) {
    return true;
  }

  return normalized.options.length < group.options.length;
}

/**
 * The items holding at least one lossy group, in menu order.
 *
 * An item with no `modifierGroups` key at all — every project saved before
 * Feature 18.1 — reads as an empty list, exactly as normalizeMenuItem treats it,
 * so a legacy project can never be blocked from saving.
 *
 * Two independent checks, because they catch different losses: the count
 * comparison catches a whole group disappearing (unnamed, no usable options, a
 * duplicate id, or past the group cap), and isModifierGroupLossy catches options
 * dropped from a group that otherwise survives.
 */
export function findItemsWithUnsaveableModifiers(config: ProjectConfig): MenuItem[] {
  return config.menuItems.filter((item) => {
    const authored = Array.isArray(item.modifierGroups) ? item.modifierGroups : [];

    return (
      normalizeModifierGroups(authored).length !== authored.length ||
      authored.some(isModifierGroupLossy)
    );
  });
}

/**
 * Why this project cannot be saved yet — or null, which is the normal case.
 *
 * WHY THIS BLOCKS RATHER THAN WARNS. Before Phase 5A, Save succeeded and
 * normalizeConfigModifiers quietly discarded the half-finished group; the owner
 * saw "Saved" and the group was simply gone on the next load, with no undo. The
 * Phase 4 amber notice warned beforehand, but a warning that can be scrolled
 * past is not a safeguard against silent data loss.
 *
 * Naming the item matters: an owner may have authored the broken group on a
 * product they are no longer looking at, and "a modifier group is incomplete"
 * with no location is close to useless in a menu of thirty items.
 */
export function getModifierSaveBlockerMessage(config: ProjectConfig): string | null {
  const items = findItemsWithUnsaveableModifiers(config);

  if (items.length === 0) {
    return null;
  }

  const names = items.map((item) => item.name.trim() || "Untitled item");

  if (names.length === 1) {
    return `${names[0]} has an incomplete modifier group. Name the group and its options, or delete it, before saving.`;
  }

  return `${names.length} items have incomplete modifier groups (${names.join(", ")}). Name each group and its options, or delete them, before saving.`;
}

/**
 * Normalizes every item's modifier groups on the way to the database.
 *
 * WHERE NORMALIZATION HAPPENS, precisely — there are now three points, all of
 * them the same lib/modifiers.ts function:
 *
 *   1. LOAD  — normalizeProjectConfig -> normalizeMenuItem (Feature 18.1),
 *              when EditorShell seeds its state from the saved config.
 *   2. SAVE  — this function, applied to the value sent to saveNewProject /
 *              updateProject. NEW in Phase 4, and necessary: nothing previously
 *              normalized on the way out, so before this a half-typed group
 *              would have been written verbatim into projects.config and then
 *              silently vanished on the next load.
 *   3. BUILD — createGeneratedPosConfig -> toRuntimeSafeMenuItem (Feature 18.1),
 *              producing the immutable snapshot a paired device pins.
 *
 * The React draft is deliberately NOT normalized: typing stays free-form, and
 * getModifierGroupNotice tells the owner what step 2 will do before they save.
 *
 * Only modifierGroups is touched. Running the whole normalizeProjectConfig here
 * would change save behavior for every unrelated field, which is outside this
 * feature and would be a silent redesign of the editor.
 */
export function normalizeConfigModifiers(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    menuItems: config.menuItems.map(
      (item): MenuItem => ({
        ...item,
        modifierGroups: normalizeModifierGroups(item.modifierGroups),
      })
    ),
  };
}
