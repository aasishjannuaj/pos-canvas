"use client";

import { useState } from "react";
import type { MenuItem } from "@/components/editor/EditorShell";
import { ALL_CATEGORY, deriveCategories, displayCategory } from "./shared";

export type UseProductCategoriesResult = {
  categories: string[];
  activeCategory: string | null;
  setActiveCategory: (category: string) => void;
  visibleItems: MenuItem[];
};

// Feature 12.3 bug fix — category tabs across all three layouts were
// non-interactive <span> elements (a decorative pattern inherited from the
// original, pre-12.3 EditorPreview.tsx, which always rendered every
// category's items stacked and never actually filtered). This hook is the
// single source of truth for real category selection/filtering, shared by
// MenuGridBrowser/ProductGridBrowser/ServiceGridBrowser so the logic isn't
// duplicated three times — each layout only owns how the tabs/cards look.
export type UseProductCategoriesOptions = {
  /**
   * v1.3 Lane 2 Task 2 — prepend an "All" pill that shows every product.
   *
   * OPT-IN, and that is the whole point. MenuGrid/ProductGrid/ServiceGrid call
   * this hook with no options and are byte-identical in behavior to before:
   * same derived categories, same first-category default, same filtering. Only
   * the Liquor Store browser passes true, so Retail's default presentation
   * cannot change as a side effect of this feature.
   */
  includeAll?: boolean;
};

export function useProductCategories(
  menuItems: MenuItem[],
  options?: UseProductCategoriesOptions
): UseProductCategoriesResult {
  const includeAll = options?.includeAll === true;

  const derived = deriveCategories(menuItems);

  // A merchant category literally named "All" is folded into the pseudo-
  // category rather than rendered twice. That pill then shows everything,
  // which is what its label promises either way.
  const categories = includeAll
    ? [ALL_CATEGORY, ...derived.filter((category) => category !== ALL_CATEGORY)]
    : derived;

  const [activeCategory, setActiveCategoryState] = useState<string | null>(
    () => categories[0] ?? null
  );

  // Requirement #6 — if menuItems change such that the active category no
  // longer exists (item deleted/recategorized, or the whole menu changed),
  // fall back to the first available category. Computed during render
  // (not an effect) so the very same render that filters `visibleItems`
  // below already uses the corrected category — no stale/flashing frame.
  // A manual click (setActiveCategory) always wins as long as that category
  // still exists, so this never overrides a valid user selection.
  const resolvedActiveCategory =
    activeCategory !== null && categories.includes(activeCategory)
      ? activeCategory
      : categories[0] ?? null;

  function setActiveCategory(category: string) {
    setActiveCategoryState(category);
  }

  // Requirement #7 — an empty menu yields categories = [] and
  // resolvedActiveCategory = null, so visibleItems is simply [] here. No
  // crash; callers render their own empty-menu state when categories is
  // empty.
  const visibleItems =
    resolvedActiveCategory === null
      ? []
      : resolvedActiveCategory === ALL_CATEGORY && includeAll
        ? menuItems
        : menuItems.filter(
            (item) => displayCategory(item.category) === resolvedActiveCategory
          );

  return {
    categories,
    activeCategory: resolvedActiveCategory,
    setActiveCategory,
    visibleItems,
  };
}
