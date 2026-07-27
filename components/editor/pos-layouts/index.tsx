"use client";

import type { PosLayout } from "@/lib/posLayout";
import type { ProductBrowserProps } from "./shared";
import MenuGridBrowser from "./MenuGridBrowser";
import ProductGridBrowser from "./ProductGridBrowser";
import ServiceGridBrowser from "./ServiceGridBrowser";

type ProductBrowserSwitchProps = ProductBrowserProps & {
  layout: PosLayout;
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
  switch (layout) {
    case "product-grid":
      return <ProductGridBrowser {...props} />;
    case "service-grid":
      return <ServiceGridBrowser {...props} />;
    case "menu-grid":
    default:
      return <MenuGridBrowser {...props} />;
  }
}
