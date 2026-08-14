"use client";

import { useState } from "react";
import type { PosLayout } from "@/lib/posLayout";
import type { MenuItem } from "@/lib/projectConfig";
import type { CartModifierSelection } from "@/lib/cart";
import { normalizeModifierGroups } from "@/lib/modifiers";
import ModifierSelector from "@/components/runtime/ModifierSelector";
import type { ProductBrowserProps } from "./shared";
import MenuGridBrowser from "./MenuGridBrowser";
import ProductGridBrowser from "./ProductGridBrowser";
import ServiceGridBrowser from "./ServiceGridBrowser";

type ProductBrowserSwitchProps = Omit<ProductBrowserProps, "onAddToCart"> & {
  layout: PosLayout;
  // Feature 18.2 — hosts receive the chosen selections alongside the item.
  // Omitted for a product with no modifier groups, so existing callers that
  // ignore the second argument keep working unchanged.
  onAddToCart: (menuItem: MenuItem, selections?: CartModifierSelection[]) => void;
};

// Feature 12.3 lint fix — react-hooks/static-components flagged the previous
// getProductBrowser(layout) helper: it returned a *component type* computed
// during EditorPreview's render, so each render could hand React a
// differently-identitied function for the same layout, which React treats as
// an unmount/remount of the whole subtree (losing useProductCategories'
// active-category state, cart focus, etc.) rather than a normal update.
//
// This module-level component fixes that: ProductBrowser itself is declared
// once, so its identity never changes across renders. Only the static JSX it
// returns varies by `layout`, which is plain conditional rendering — the
// same pattern React already treats as a stable update, not a remount.
export default function ProductBrowser({
  layout,
  ...props
}: ProductBrowserSwitchProps) {
  // Feature 18.2 — the single shared interception point.
  //
  // Every layout below calls the same onAddToCart, and only two components
  // render this switch (PosRuntime, which serves both the owner runtime and the
  // paired device, and EditorPreview for the Builder). Intercepting here means
  // one implementation covers all three surfaces and all three layouts, with no
  // per-template modifier logic anywhere.
  //
  // A product with no modifier groups takes the original path untouched.
  const [pendingItem, setPendingItem] = useState<MenuItem | null>(null);

  const pendingGroups = normalizeModifierGroups(pendingItem?.modifierGroups);

  function handleAddToCart(menuItem: MenuItem) {
    const groups = normalizeModifierGroups(menuItem.modifierGroups);

    if (groups.length === 0) {
      // Unchanged behavior: tap adds straight to the cart.
      props.onAddToCart(menuItem);
      return;
    }

    setPendingItem(menuItem);
  }

  const layoutProps = { ...props, onAddToCart: handleAddToCart };

  const browser = (() => {
    switch (layout) {
      case "product-grid":
        return <ProductGridBrowser {...layoutProps} />;
      case "service-grid":
        return <ServiceGridBrowser {...layoutProps} />;
      case "menu-grid":
      default:
        return <MenuGridBrowser {...layoutProps} />;
    }
  })();

  if (pendingItem === null || pendingGroups.length === 0) {
    return browser;
  }

  // `relative` anchors the selector overlay, which fills the product panel
  // rather than the whole screen — the cart stays visible beside it.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {browser}
      <ModifierSelector
        item={pendingItem}
        groups={pendingGroups}
        currencySymbol={props.currencySymbol}
        accentColor={props.branding.accentColor}
        onCancel={() => setPendingItem(null)}
        onConfirm={(selections) => {
          props.onAddToCart(pendingItem, selections);
          setPendingItem(null);
        }}
      />
    </div>
  );
}
