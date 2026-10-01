"use client";

import { useState } from "react";
import type { PosLayout } from "@/lib/posLayout";
import type { MenuItem } from "@/lib/projectConfig";
import type { CartModifierSelection } from "@/lib/cart";
import { normalizeModifierGroups } from "@/lib/modifiers";
import ModifierSelector from "@/components/runtime/ModifierSelector";
import { LIQUOR_STORE_TEMPLATE_ID, RETAIL_STORE_TEMPLATE_ID } from "./shared";
import type { ProductBrowserProps } from "./shared";
import LiquorStoreBrowser from "./LiquorStoreBrowser";
import MenuGridBrowser from "./MenuGridBrowser";
import ProductGridBrowser from "./ProductGridBrowser";
import RetailStoreBrowser from "./RetailStoreBrowser";
import ServiceGridBrowser from "./ServiceGridBrowser";

type ProductBrowserSwitchProps = Omit<ProductBrowserProps, "onAddToCart"> & {
  layout: PosLayout;
  /**
   * v1.3 Lane 2 Task 2 — the project's template identity, used to pick a
   * PRESENTATION variant within a layout family.
   *
   * Already carried by GeneratedPosConfig.project.templateId and already a prop
   * on EditorShell, so nothing new is fetched, stored or persisted to obtain
   * it — and deliberately NOT a new PosLayout value, because layout is part of
   * the generated config's canonical hash and a new one would change the hash
   * of every existing liquor-store project for a purely visual change.
   *
   * Optional so an omitting caller keeps today's exact layout-only behavior.
   */
  templateId?: string;
  /**
   * v1.3 Feature 1E-B — the resolved barcode capability, forwarded only to the
   * browser that presents it.
   *
   * REQUIRED, so the compiler makes every host resolve it rather than letting
   * an omission silently become a default — a default here would be a second
   * copy of lib/projectFeatures.ts's compatibility rule.
   *
   * Deliberately NOT on ProductBrowserProps: Menu Grid, Product Grid and
   * Service Grid must not gain a barcode concept just because one variant has
   * one, so it is passed beside the shared spread instead of inside it.
   */
  barcodeScanningEnabled: boolean;
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
  templateId,
  barcodeScanningEnabled,
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
    // v1.3 Lane 2 Task 2 — presentation variants are chosen BEFORE the layout
    // family, and only ever add a branch; the switch below is untouched, so
    // retail (also product-grid) still resolves to ProductGridBrowser and an
    // unknown or legacy templateId simply falls through to today's behavior.
    if (templateId === LIQUOR_STORE_TEMPLATE_ID) {
      return (
        <LiquorStoreBrowser
          {...layoutProps}
          barcodeScanningEnabled={barcodeScanningEnabled}
        />
      );
    }

    // v1.3 Lane 2 Retail Store — the same mechanism, one branch later. retail
    // is still layout: "product-grid", so the switch below is still the generic
    // product-grid presentation for any template without a dedicated variant.
    if (templateId === RETAIL_STORE_TEMPLATE_ID) {
      return (
        <RetailStoreBrowser
          {...layoutProps}
          barcodeScanningEnabled={barcodeScanningEnabled}
        />
      );
    }

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
