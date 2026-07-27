"use client";

import { useState } from "react";
import type { MenuItem } from "@/components/editor/EditorShell";
import { deriveCategories, displayCategory } from "./shared";

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
export function useProductCategories(menuItems: MenuItem[]): UseProductCategoriesResult {
  const categories = deriveCategories(menuItems);

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
