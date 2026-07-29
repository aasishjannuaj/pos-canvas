"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import EditorTopBar from "./EditorTopBar";
import EditorSidebar from "./EditorSidebar";
import EditorPreview from "./EditorPreview";
import EditorPropertiesPanel from "./EditorPropertiesPanel";
import { saveNewProject, updateProject, getProjectConfig } from "@/lib/projects";
import { completeSaleOrder } from "@/lib/orders";
import { restockInventory, adjustInventory } from "@/lib/inventory";
import type { InventoryTransaction } from "@/lib/inventory.types";
import type { OrderTotal } from "@/lib/dashboard.types";
import ProjectDashboard from "@/components/dashboard/ProjectDashboard";
import SalesReport from "@/components/dashboard/SalesReport";
import ProductPerformance from "@/components/dashboard/ProductPerformance";
import InventorySummary from "@/components/dashboard/InventorySummary";
import ReceiptPreview from "./ReceiptPreview";
import {
  CURRENCY_SYMBOLS,
  defaultProjectConfig,
  normalizeProjectConfig,
} from "@/lib/projectConfig";
import type {
  MenuItem,
  Currency,
  TaxSettings,
  ReceiptSettings,
  BrandingSettings,
  BusinessProfile,
  ProjectConfig,
} from "@/lib/projectConfig";
import { DEFAULT_POS_LAYOUT } from "@/lib/posLayout";
import type { PosLayout } from "@/lib/posLayout";
import OnboardingChecklist from "./onboarding/OnboardingChecklist";
import {
  useOnboardingProgress,
  sectionToOnboardingStepId,
} from "./onboarding/useOnboardingProgress";
import type { OnboardingStepId } from "./onboarding/useOnboardingProgress";
import {
  createGeneratedPosConfig,
  createGeneratedPosConfigFilename,
  getGeneratedPosExportEligibility,
} from "@/lib/generatedPosConfig";
import { downloadJsonFile } from "@/lib/downloadJson";
import { calculateCartSummary, canAddItemQuantity } from "@/lib/cart";
import type {
  CartItem,
  CartSummary,
  CheckoutStatus,
  CompletedOrder,
  PaymentMethod,
  SaleSaveStatus,
} from "@/lib/cart";

// Feature 12.1 — ProjectConfig and its nested types/defaults now live in the
// neutral lib/projectConfig.ts (so the template registry in data/templates.ts
// can reference them without depending on this "use client" component, and
// without a circular import back to it). Re-exported here unchanged so every
// existing `import ... from "@/components/editor/EditorShell"` call site
// elsewhere in the app keeps working exactly as before.
//
// Feature 12.2 — MENU_CATEGORIES/MenuCategory are gone: category is now a
// plain string (see lib/projectConfig.ts), and category tabs/sections are
// derived per-project in EditorPreview.tsx instead of from a fixed list.
//
// Feature 14.3 — CartItem/CartSummary/PaymentMethod/CheckoutStatus/
// SaleSaveStatus/CompletedOrder now live in the neutral lib/cart.ts (so
// components/runtime/PosRuntime.tsx can share them without depending on
// this "use client" component), re-exported here the same way ProjectConfig
// has been since Feature 12.1, so every existing
// `import ... from "@/components/editor/EditorShell"` call site keeps
// working unchanged.
export { CURRENCY_SYMBOLS };
export type { MenuItem, Currency, ProjectConfig };
export type {
  CartItem,
  CartSummary,
  CheckoutStatus,
  CompletedOrder,
  PaymentMethod,
  SaleSaveStatus,
};

export type EditorSection =
  | "Menu"
  | "Branding"
  | "Business"
  | "Taxes"
  | "Settings"
  | "Dashboard"
  | "Sales Report"
  | "Product Performance"
  | "Inventory Summary";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

// Feature 14.2 — fully separate from SaveStatus/isDirty above. Export never
// reuses or mutates the save-state model: it only ever reads projectId/
// isDirty/saveStatus (via getGeneratedPosExportEligibility) to decide
// whether it's allowed to run.
export type ExportStatus = "idle" | "exporting" | "success" | "error";

export type EditorMode = "edit" | "preview";

export type RestockStatus = "idle" | "saving" | "success" | "error";

export type AdjustStatus = "idle" | "saving" | "success" | "error";

// Feature 14.3 money safeguard — a Builder-preview-only sample tip amount.
// Deliberately NOT part of lib/cart.ts and never reaches the runtime: it
// exists solely so the Builder's own preview cart keeps showing the same
// sample tip line it always has (previously hardcoded inside
// calculateCartSummary itself as STATIC_TIP). components/runtime/
// PosRuntime.tsx always passes a real tip amount (0 in this MVP, since no
// tip-entry UI exists yet) and never references this constant.
const BUILDER_PREVIEW_SAMPLE_TIP = 3;

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  // Fallback for environments without crypto.randomUUID (still collision-resistant enough for local state).
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type EditorShellProps = {
  // Feature 13.2 — this is only the *initial* project name (the DB's
  // `projects.name` for a saved project, or the template's display name for
  // a brand-new one). It seeds local state below; the Builder's own rename
  // input is the source of truth from then on, never this prop again.
  initialProjectName: string;
  templateId: string;
  initialConfig?: ProjectConfig;
  initialProjectId?: string | null;
  initialCompletedOrders?: CompletedOrder[];
  initialInventoryTransactions?: InventoryTransaction[];
  initialInventoryTransactionsError?: string | null;
  initialOrderTotals?: OrderTotal[];
  initialOrderTotalsError?: string | null;
  // Feature 12.3 — the POS preview layout, resolved by app/editor/[id]/
  // page.tsx from the template registry (derived from templateId, never
  // stored in ProjectConfig). Optional/defaulted here as a defensive
  // fallback only — the page component always resolves and passes a value.
  layout?: PosLayout;
};

export default function EditorShell({
  initialProjectName,
  templateId,
  initialConfig,
  initialProjectId,
  initialCompletedOrders,
  initialInventoryTransactions,
  initialInventoryTransactionsError,
  initialOrderTotals,
  initialOrderTotalsError,
  layout = DEFAULT_POS_LAYOUT,
}: EditorShellProps) {
  const router = useRouter();

  const [projectConfig, setProjectConfig] = useState<ProjectConfig>(() =>
    normalizeProjectConfig(initialConfig ?? defaultProjectConfig)
  );

  // Feature 13.2 — the project's own internal/dashboard label, kept
  // deliberately separate from ProjectConfig.businessProfile.businessName
  // (the customer-facing name). Lives in its own local state, seeded once
  // from initialProjectName, so the Builder's rename input is the single
  // source of truth for the rest of the session.
  const [projectName, setProjectName] = useState(initialProjectName);

  // UI-only state — not part of the saved project, so it stays outside projectConfig.
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [editorSection, setEditorSection] = useState<EditorSection>("Menu");

  // Feature 7.1 — edit/preview mode (UI-only, does not affect saved data)
  const [editorMode, setEditorMode] = useState<EditorMode>("edit");

  // Feature 7.2 — preview-only cart (never saved with the project)
  const [cart, setCart] = useState<CartItem[]>([]);

  // Feature 7.3 — preview-only checkout (never saved with the project)
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] =
    useState<PaymentMethod | null>(null);
  const [checkoutStatus, setCheckoutStatus] = useState<CheckoutStatus>("idle");

  // Feature 11.1 — the exact order id the success screen's "View Receipt"
  // button should open. Set alongside setCompletedOrders in completeSale(),
  // so it always names the order that RPC call actually confirmed — never
  // inferred from completedOrders[0], which would be fragile if that array's
  // update ordering ever changed.
  const [lastCompletedOrderId, setLastCompletedOrderId] = useState<
    string | null
  >(null);

  // Feature 8.3/9.3 — persistence status for the current checkout attempt.
  // After a successful sale, saleSaveError may hold a non-blocking inventory
  // refresh WARNING even while saleSaveStatus stays "success" — it is not
  // reused to mean "the sale failed" in that case.
  const [saleSaveStatus, setSaleSaveStatus] = useState<SaleSaveStatus>("idle");
  const [saleSaveError, setSaleSaveError] = useState<string | null>(null);

  // Feature 9.6 — restock status for the current restock attempt.
  const [restockStatus, setRestockStatus] = useState<RestockStatus>("idle");
  const [restockError, setRestockError] = useState<string | null>(null);
  const [restockSuccessMessage, setRestockSuccessMessage] = useState<
    string | null
  >(null);

  // Feature 9.7B — manual inventory adjustment status for the current attempt.
  const [adjustStatus, setAdjustStatus] = useState<AdjustStatus>("idle");
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustSuccessMessage, setAdjustSuccessMessage] = useState<
    string | null
  >(null);

  // Feature 7.4/8.4 — completed orders & receipts. Seeded from server-loaded
  // history when available (newest first); new sales are prepended so the
  // ordering convention stays consistent throughout.
  const [completedOrders, setCompletedOrders] = useState<CompletedOrder[]>(
    initialCompletedOrders ?? []
  );
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(null);

  // Feature 9.4/10.4 — inventory activity log (newest first), seeded from
  // server-loaded history. Unlike its original design, this now *does* need
  // local updates: a sale, restock, or adjustment made this session must
  // show up in both the Inventory Activity panel and Inventory Summary
  // immediately, without a page reload. completeSale/handleRestock/
  // handleInventoryAdjustment each append a locally-confirmed entry below —
  // never a re-fetch, so nothing here risks double-counting.
  const [inventoryTransactions, setInventoryTransactions] = useState<
    InventoryTransaction[]
  >(initialInventoryTransactions ?? []);

  // Same rationale as orderTotalsError: no client-side retry for this
  // read-only reporting query, so a load failure (if any) is fixed for the
  // session.
  const inventoryTransactionsError = initialInventoryTransactionsError ?? null;

  // Feature 10.1 — dashboard order totals, seeded from server-loaded history.
  // Unlike inventoryTransactions, this *does* need a local update: a sale
  // completed in the current session must show up on the Dashboard tab
  // immediately, without a page reload. completeSale() appends the newly
  // confirmed order's totals below — it never refetches from the server, so
  // there is no risk of double-counting the same sale.
  const [orderTotals, setOrderTotals] = useState<OrderTotal[]>(
    initialOrderTotals ?? []
  );

  // The initial load either succeeded (possibly with zero orders, a real
  // "no sales yet" state) or failed outright. There is no client-side retry
  // for this read-only reporting query, so the error — if any — is fixed
  // for the session, same as the other server-seeded history above.
  const orderTotalsError = initialOrderTotalsError ?? null;

  // Feature 6.4/6.5.2/6.5.3/13.2 — save state. isDirty and saveStatus are
  // deliberately two independent fields rather than one overloaded value:
  // isDirty answers "is there anything to save right now" (starts false on
  // mount, for both a saved project and a brand-new template session — see
  // markDirty below), while saveStatus tracks only the lifecycle of the most
  // recent save *request* itself ("saving" while in flight, "saved"/"error"
  // once it resolves). The Builder's displayed status label and Save button
  // state are both derived from the combination of the two in
  // EditorTopBar, not stored redundantly here.
  const [projectId, setProjectId] = useState<string | null>(initialProjectId ?? null);
  const [isDirty, setIsDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Feature 14.2 — export state, independent of saveStatus/saveError above.
  // "success" is left in place indefinitely (no timer) until either another
  // export attempt runs or a new persisted edit makes isDirty true again —
  // at which point the Settings UI's own display priority naturally shows
  // "Save your latest changes before exporting" instead, with no separate
  // reset needed here.
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [exportError, setExportError] = useState<string | null>(null);

  // Feature 13.3 — entirely separate from the isDirty/saveStatus save-state
  // model above: onboarding never marks the project dirty, never touches
  // saveStatus/saveError, and never calls handleSave. See
  // useOnboardingProgress for the auto-open/persistence/completion rules.
  // Correction: the hook no longer takes editorSection/editorMode — step
  // completion is now recorded directly from user actions below (sidebar
  // clicks, the Preview toggle, onboarding's own navigation), never from an
  // effect watching this state.
  const onboarding = useOnboardingProgress({
    initialProjectId: initialProjectId ?? null,
    projectId,
  });

  // Feature 13.3 correction — the single place that records a section as
  // visited, used both for normal EditorSidebar clicks and (via
  // handleOnboardingNavigate below) for the checklist's own section steps.
  // Always forces editorMode back to "edit" alongside setEditorSection,
  // since a section is only rendered while editorMode === "edit"
  // (EditorPreview renders unconditionally in "preview" mode regardless of
  // editorSection) — this also means clicking a sidebar section while in
  // preview mode now correctly switches back to edit mode, matching what a
  // user would expect. sectionToOnboardingStepId returns null for the
  // reporting sections (Dashboard/Sales Report/Product Performance/
  // Inventory Summary), which are intentionally not onboarding steps.
  function handleEditorSectionChange(section: EditorSection) {
    setEditorMode("edit");
    setEditorSection(section);

    const stepId = sectionToOnboardingStepId(section);
    if (stepId) {
      onboarding.markStepVisited(stepId);
    }
  }

  // Feature 13.3 — the single dispatcher the checklist calls for its six
  // navigable steps ("save" is observational-only and never reaches here —
  // see OnboardingChecklist). The five section steps delegate to
  // handleEditorSectionChange above so the "force edit mode + record the
  // visit" logic isn't duplicated. Preview is handled directly (setting
  // editorMode straight to "preview" rather than through
  // handleToggleEditorMode's toggle), so clicking this step is idempotent
  // even if already in preview mode.
  function handleOnboardingNavigate(stepId: OnboardingStepId) {
    switch (stepId) {
      case "business":
        handleEditorSectionChange("Business");
        return;
      case "menu":
        handleEditorSectionChange("Menu");
        return;
      case "branding":
        handleEditorSectionChange("Branding");
        return;
      case "taxes":
        handleEditorSectionChange("Taxes");
        return;
      case "receipt":
        handleEditorSectionChange("Settings");
        return;
      case "preview":
        setEditorMode("preview");
        onboarding.markStepVisited("preview");
        return;
      case "save":
        return;
    }
  }

  const selectedItem =
    projectConfig.menuItems.find((item) => item.id === selectedItemId) ?? null;

  const cartSummary = calculateCartSummary(
    cart,
    projectConfig.tax,
    projectConfig.receipt.tipsEnabled ? BUILDER_PREVIEW_SAMPLE_TIP : 0
  );

  // Feature 13.2 — the single call every persisted-data mutation makes.
  // Marks the project dirty and clears any stale error from a previous save
  // attempt, so a fresh edit after a failed (or successful) save always
  // reads as "Unsaved changes" rather than lingering on "Save failed" or
  // "Saved" for content that no longer matches what was last persisted.
  function markDirty() {
    setIsDirty(true);
    setSaveStatus("idle");
    setSaveError(null);
  }

  function handleProjectNameChange(name: string) {
    setProjectName(name);
    markDirty();
  }

  // Feature 13.3 correction — records the Preview step directly from this
  // existing user action (the EditorTopBar Preview/Back-to-Edit button),
  // rather than from an effect watching editorMode. Computed from the
  // current editorMode value (not a functional setEditorMode updater) since
  // calling another state setter — onboarding.markStepVisited, which itself
  // calls setVisitedSteps — from inside a setState updater function would
  // be an impure side effect React explicitly warns against. Returning to
  // edit mode never un-marks the step: it's a one-way completion signal
  // like every other onboarding step.
  function handleToggleEditorMode() {
    const nextMode: EditorMode = editorMode === "edit" ? "preview" : "edit";
    setEditorMode(nextMode);

    if (nextMode === "preview") {
      onboarding.markStepVisited("preview");
    }
  }

  function handleUpdateItem(id: string, changes: Partial<MenuItem>) {
    markDirty();

    setProjectConfig((prev) => ({
      ...prev,
      menuItems: prev.menuItems.map((item) =>
        item.id === id ? { ...item, ...changes } : item
      ),
    }));

    // Feature 7.5 — if inventory fields changed, clamp/remove any cart
    // quantity that now exceeds the new stock level (simple, no extra effects).
    if ("stockQuantity" in changes || "trackInventory" in changes) {
      setCart((prev) => {
        const oldItem = projectConfig.menuItems.find((item) => item.id === id);
        if (!oldItem) {
          return prev;
        }

        const updatedItem: MenuItem = { ...oldItem, ...changes };

        if (!updatedItem.trackInventory) {
          return prev;
        }

        return prev
          .map((cartItem) =>
            cartItem.itemId === id
              ? {
                  ...cartItem,
                  quantity: Math.min(cartItem.quantity, updatedItem.stockQuantity),
                }
              : cartItem
          )
          .filter((cartItem) => cartItem.quantity > 0);
      });
    }
  }

  function handleAddItem() {
    markDirty();

    // Feature 12.2 — a new item joins whatever category the project already
    // uses (already-normalized by normalizeProjectConfig at load time), so
    // it lands in an existing, visible tab instead of spawning an orphan
    // one. Falls back to "General" only when the menu is empty.
    const newItem: MenuItem = {
      id: createId(),
      name: "New Item",
      price: 0,
      category: projectConfig.menuItems[0]?.category ?? "General",
      trackInventory: true,
      stockQuantity: 0,
    };

    setProjectConfig((prev) => ({
      ...prev,
      menuItems: [...prev.menuItems, newItem],
    }));
    setSelectedItemId(newItem.id);
  }

  function handleDuplicateItem() {
    if (!selectedItem) {
      return;
    }

    markDirty();

    const duplicatedItem: MenuItem = {
      ...selectedItem,
      id: createId(),
    };

    setProjectConfig((prev) => ({
      ...prev,
      menuItems: [...prev.menuItems, duplicatedItem],
    }));
    setSelectedItemId(duplicatedItem.id);
  }

  function handleDeleteItem() {
    if (!selectedItem) {
      return;
    }

    markDirty();

    setProjectConfig((prev) => ({
      ...prev,
      menuItems: prev.menuItems.filter((item) => item.id !== selectedItem.id),
    }));

    // A deleted menu item can't be left behind as an orphaned line in the
    // preview cart (no matching item to look up, no inventory to deduct from).
    setCart((prev) =>
      prev.filter((cartItem) => cartItem.itemId !== selectedItem.id)
    );

    setSelectedItemId(null);
  }

  function handleBrandingChange(changes: Partial<BrandingSettings>) {
    markDirty();
    setProjectConfig((prev) => ({
      ...prev,
      branding: { ...prev.branding, ...changes },
    }));
  }

  function handleBusinessProfileChange(changes: Partial<BusinessProfile>) {
    markDirty();
    setProjectConfig((prev) => ({
      ...prev,
      businessProfile: { ...prev.businessProfile, ...changes },
    }));
  }

  function handleTaxChange(changes: Partial<TaxSettings>) {
    markDirty();
    setProjectConfig((prev) => ({
      ...prev,
      tax: { ...prev.tax, ...changes },
    }));
  }

  function handleReceiptChange(changes: Partial<ReceiptSettings>) {
    markDirty();
    setProjectConfig((prev) => ({
      ...prev,
      receipt: { ...prev.receipt, ...changes },
    }));
  }

  function addToCart(menuItem: MenuItem) {
    setCart((prev) => {
      const existing = prev.find((cartItem) => cartItem.itemId === menuItem.id);
      const currentQuantity = existing?.quantity ?? 0;

      // Feature 14.3 — shared with the runtime via lib/cart.ts, so both
      // ever only enforce one stock-limit rule. Equivalent to the previous
      // inline check (trackInventory && currentQuantity >= stockQuantity)
      // for a single-unit add.
      if (
        !canAddItemQuantity({
          item: menuItem,
          currentQuantity,
          addQuantity: 1,
        })
      ) {
        return prev;
      }

      if (existing) {
        return prev.map((cartItem) =>
          cartItem.itemId === menuItem.id
            ? { ...cartItem, quantity: cartItem.quantity + 1 }
            : cartItem
        );
      }

      return [
        ...prev,
        {
          itemId: menuItem.id,
          name: menuItem.name,
          price: menuItem.price,
          quantity: 1,
        },
      ];
    });
  }

  function increaseQuantity(itemId: string) {
    setCart((prev) =>
      prev.map((cartItem) => {
        if (cartItem.itemId !== itemId) {
          return cartItem;
        }

        const menuItem = projectConfig.menuItems.find((item) => item.id === itemId);

        // Feature 14.3 — preserves the original fallthrough behavior for an
        // orphaned cart line with no matching menu item (always allowed to
        // increase, unchanged from before this extraction) — the shared
        // predicate is only consulted once a real menuItem is found.
        if (
          menuItem &&
          !canAddItemQuantity({
            item: menuItem,
            currentQuantity: cartItem.quantity,
            addQuantity: 1,
          })
        ) {
          return cartItem;
        }

        return { ...cartItem, quantity: cartItem.quantity + 1 };
      })
    );
  }

  function decreaseQuantity(itemId: string) {
    setCart((prev) =>
      prev
        .map((cartItem) =>
          cartItem.itemId === itemId
            ? { ...cartItem, quantity: cartItem.quantity - 1 }
            : cartItem
        )
        .filter((cartItem) => cartItem.quantity > 0)
    );
  }

  function removeFromCart(itemId: string) {
    setCart((prev) => prev.filter((cartItem) => cartItem.itemId !== itemId));
  }

  function clearCart() {
    setCart([]);
  }

  function openCheckout() {
    if (cart.length === 0) {
      return;
    }
    setCheckoutOpen(true);
  }

  function closeCheckout() {
    setCheckoutOpen(false);
    setSelectedPaymentMethod(null);
    setCheckoutStatus("idle");
    setSaleSaveStatus("idle");
    setSaleSaveError(null);
  }

  function selectPaymentMethod(method: PaymentMethod) {
    setSelectedPaymentMethod(method);
  }

  async function completeSale() {
    // Preserve the existing guards — unchanged from before Feature 8.3.
    if (cart.length === 0 || !selectedPaymentMethod || checkoutStatus === "success") {
      return;
    }

    setSaleSaveStatus("saving");
    setSaleSaveError(null);

    // A sale can only be persisted against a project that actually has a
    // database row. Fail fast with a clear, actionable message instead of
    // letting this surface as an opaque RPC error.
    if (projectId === null) {
      setSaleSaveStatus("error");
      setSaleSaveError("Save this project before completing a sale.");
      return;
    }

    const orderNumber = `${projectConfig.receipt.orderPrefix}${1001 + completedOrders.length}`;

    const { orderId, error } = await completeSaleOrder({
      projectId,
      orderNumber,
      paymentMethod: selectedPaymentMethod,
      subtotal: cartSummary.subtotal,
      taxAmount: cartSummary.taxAmount,
      tipAmount: cartSummary.tip,
      total: cartSummary.total,
      items: cart,
    });

    if (error || !orderId) {
      // RPC failed — the sale did not happen. Nothing local changes, so the
      // cashier can safely retry: cart, checkout, and inventory are untouched.
      setSaleSaveStatus("error");
      setSaleSaveError(error ?? "Something went wrong while completing the sale.");
      return;
    }

    // RPC succeeded — the sale is now real. complete_sale (9.2) already
    // validated and deducted inventory and recorded inventory_transactions
    // atomically; the client does none of that math anymore.
    const order: CompletedOrder = {
      id: orderId,
      orderNumber,
      items: [...cart],
      subtotal: cartSummary.subtotal,
      taxAmount: cartSummary.taxAmount,
      tip: cartSummary.tip,
      total: cartSummary.total,
      paymentMethod: selectedPaymentMethod,
      createdAt: new Date().toISOString(),
    };

    setCompletedOrders((prev) => [order, ...prev]);

    // Feature 11.1 — the exact confirmed order id for this sale, so the
    // success screen's "View Receipt" button can open it directly.
    setLastCompletedOrderId(order.id);

    // Feature 10.1/10.2/10.3 — reuse the same confirmed values used for the
    // receipt above (order.orderNumber/subtotal/taxAmount/tip/total/
    // paymentMethod/createdAt/items) so the Dashboard, Sales Report, and
    // Product Performance all reflect this sale immediately, without a page
    // reload or a second fetch. itemCount/items are computed from
    // order.items rather than the cart state directly since clearCart()
    // runs right after this. lineTotal is derived as price * quantity —
    // the real order_items.line_total isn't known client-side until the
    // next server reload, but this matches how the DB itself would compute
    // it for a plain per-unit price with no discounts. This is a local
    // append only; the server-side order totals query is never re-run, so
    // the sale can't be double-counted there.
    setOrderTotals((prev) => [
      {
        id: order.id,
        orderNumber: order.orderNumber,
        subtotal: order.subtotal,
        taxAmount: order.taxAmount,
        tip: order.tip,
        total: order.total,
        paymentMethod: order.paymentMethod,
        itemCount: order.items.reduce(
          (sum, item) => sum + item.quantity,
          0
        ),
        items: order.items.map((item) => ({
          itemId: item.itemId,
          itemName: item.name,
          quantity: item.quantity,
          lineTotal: item.price * item.quantity,
        })),
        createdAt: order.createdAt,
      },
      ...prev,
    ]);

    // Feature 10.4 — append one synthetic "sale" inventory transaction per
    // tracked cart line, so Inventory Summary (and the Inventory Activity
    // panel, which reads this same state) reflect this sale's stock
    // deduction immediately. quantityBefore is read from
    // projectConfig.menuItems as it stands right here — nothing has
    // decremented it locally yet, the only update happens later via the
    // getProjectConfig() reload below — so this is the exact pre-sale
    // snapshot, not an inferred value. Untracked items are skipped (no
    // stock concept to record, matching what complete_sale's own inventory
    // bookkeeping already does). This only runs after completeSaleOrder has
    // already succeeded above, so a failed sale never produces phantom
    // transactions. Each id is deterministic (orderId + itemId + line
    // index) so React keys and activity rows can't collide even if this
    // were ever called twice for the same order.
    const saleInventoryTransactions: InventoryTransaction[] = order.items
      .map((item, index): InventoryTransaction | null => {
        const menuItem = projectConfig.menuItems.find(
          (candidate) => candidate.id === item.itemId
        );

        if (!menuItem || !menuItem.trackInventory) {
          return null;
        }

        const quantityBefore = menuItem.stockQuantity;
        const quantityChange = -item.quantity;

        return {
          id: `sale-${order.id}-${item.itemId}-${index}`,
          orderId: order.id,
          itemId: item.itemId,
          itemName: item.name,
          transactionType: "sale",
          quantityChange,
          quantityBefore,
          quantityAfter: quantityBefore + quantityChange,
          createdAt: order.createdAt,
        };
      })
      .filter((transaction): transaction is InventoryTransaction => transaction !== null);

    if (saleInventoryTransactions.length > 0) {
      setInventoryTransactions((prev) => [...saleInventoryTransactions, ...prev]);
    }

    clearCart();

    // Lock the UI into the success view *before* attempting the reload, so
    // there is no window where Complete Sale could be clicked again for a
    // sale that already succeeded.
    setCheckoutStatus("success");

    const { config: latestConfig, error: reloadError } =
      await getProjectConfig(projectId);

    if (reloadError || !latestConfig) {
      // The sale already happened — this is a read-only refresh failure,
      // not a failed sale. Show a warning, not an error, and do not retry.
      setSaleSaveStatus("success");
      setSaleSaveError(
        "Sale completed, but inventory could not be refreshed. Reload the project to see the latest stock."
      );
      return;
    }

    // Merge only stockQuantity/trackInventory per matching item id from the
    // database-confirmed config — never overwrite unrelated unsaved local
    // edits (name/price/category, or branding/tax/receipt) with the whole
    // database config. No markDirty() here: this reconciles already-
    // persisted inventory, it is not a new local edit that needs saving.
    setProjectConfig((prev) => ({
      ...prev,
      menuItems: prev.menuItems.map((item) => {
        const dbItem = latestConfig.menuItems.find(
          (dbMenuItem) => dbMenuItem.id === item.id
        );

        if (!dbItem) {
          return item;
        }

        return {
          ...item,
          stockQuantity: dbItem.stockQuantity,
          trackInventory: dbItem.trackInventory,
        };
      }),
    }));

    // inventoryTransactions was already updated above (Feature 10.4), before
    // this reload — this reconciliation only concerns stockQuantity/
    // trackInventory on projectConfig.menuItems, not the transaction log.
    setSaleSaveStatus("success");
  }

  function openReceipt(orderId: string) {
    setSelectedReceiptId(orderId);
  }

  function closeReceipt() {
    setSelectedReceiptId(null);
  }

  // Feature 9.6 — restock an inventory-tracked item via the atomic
  // restock_inventory RPC. The RPC's returned quantityAfter is authoritative;
  // this handler never computes a new stock number itself.
  async function handleRestock(itemId: string, quantity: number) {
    if (restockStatus === "saving") {
      return;
    }

    if (projectId === null) {
      setRestockStatus("error");
      setRestockError("Save this project before restocking inventory.");
      setRestockSuccessMessage(null);
      return;
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      setRestockStatus("error");
      setRestockError("Quantity must be a positive whole number.");
      setRestockSuccessMessage(null);
      return;
    }

    setRestockStatus("saving");
    setRestockError(null);
    setRestockSuccessMessage(null);

    const { result, error } = await restockInventory({
      projectId,
      itemId,
      quantity,
    });

    if (error || !result) {
      // RPC failed — nothing local changes, so this can be retried freely.
      setRestockStatus("error");
      setRestockError(error ?? "Something went wrong while restocking.");
      return;
    }

    // Use the RPC's authoritative quantityAfter directly — no client math,
    // and no markDirty(): the database already persisted this change, so
    // there is nothing new for Save to do. Any other unsaved edits (or lack
    // thereof) are left exactly as they were.
    setProjectConfig((prev) => ({
      ...prev,
      menuItems: prev.menuItems.map((item) =>
        item.id === result.itemId
          ? { ...item, stockQuantity: result.quantityAfter }
          : item
      ),
    }));

    // Feature 10.4 — use the RPC's own transaction id and before/change/
    // after values directly (no client math), so Inventory Summary and the
    // Inventory Activity panel reflect this restock immediately.
    setInventoryTransactions((prev) => [
      {
        id: result.transactionId,
        orderId: null,
        itemId: result.itemId,
        itemName: result.itemName,
        transactionType: "restock",
        quantityChange: result.quantityChange,
        quantityBefore: result.quantityBefore,
        quantityAfter: result.quantityAfter,
        createdAt: new Date().toISOString(),
      },
      ...prev,
    ]);

    setRestockStatus("success");
    setRestockSuccessMessage(
      `${result.itemName} restocked by ${result.quantityChange}. New stock: ${result.quantityAfter}.`
    );
  }

  // Feature 9.7B — manually adjust an inventory-tracked item's stock to an
  // exact final value via the atomic adjust_inventory RPC. The RPC's
  // returned quantityAfter is authoritative; this handler never computes a
  // new stock number itself. Mirrors handleRestock's conventions.
  async function handleInventoryAdjustment(itemId: string, newQuantity: number) {
    if (adjustStatus === "saving") {
      return;
    }

    if (projectId === null) {
      setAdjustStatus("error");
      setAdjustError("Save this project before adjusting inventory.");
      setAdjustSuccessMessage(null);
      return;
    }

    if (!Number.isInteger(newQuantity) || newQuantity < 0) {
      setAdjustStatus("error");
      setAdjustError("New stock must be a whole number of 0 or more.");
      setAdjustSuccessMessage(null);
      return;
    }

    setAdjustStatus("saving");
    setAdjustError(null);
    setAdjustSuccessMessage(null);

    const { result, error } = await adjustInventory({
      projectId,
      itemId,
      newQuantity,
    });

    if (error || !result) {
      // RPC failed — nothing local changes, so this can be retried freely.
      setAdjustStatus("error");
      setAdjustError(error ?? "Something went wrong while adjusting inventory.");
      return;
    }

    // Use the RPC's authoritative quantityAfter directly — no client math,
    // and no markDirty(): the database already persisted this change, so
    // there is nothing new for Save to do. Any other unsaved edits (or lack
    // thereof) are left exactly as they were.
    setProjectConfig((prev) => ({
      ...prev,
      menuItems: prev.menuItems.map((item) =>
        item.id === result.itemId
          ? { ...item, stockQuantity: result.quantityAfter }
          : item
      ),
    }));

    // Feature 10.4 — use the RPC's own transaction id and before/change/
    // after values directly (no client math), so Inventory Summary and the
    // Inventory Activity panel reflect this adjustment immediately.
    setInventoryTransactions((prev) => [
      {
        id: result.transactionId,
        orderId: null,
        itemId: result.itemId,
        itemName: result.itemName,
        transactionType: "adjustment",
        quantityChange: result.quantityChange,
        quantityBefore: result.quantityBefore,
        quantityAfter: result.quantityAfter,
        createdAt: new Date().toISOString(),
      },
      ...prev,
    ]);

    setAdjustStatus("success");
    setAdjustSuccessMessage(
      `${result.itemName} adjusted from ${result.quantityBefore} to ${result.quantityAfter}.`
    );
  }

  async function handleSave() {
    // Feature 13.2 — re-entry guard: a save already in flight blocks any
    // further invocation, including a rapid repeat click during the
    // first-save request — this is what prevents a duplicate project row
    // from ever being created, mirroring the same guard already used by
    // handleRestock/handleInventoryAdjustment above.
    if (saveStatus === "saving") {
      return;
    }

    // Validate before touching network/save state at all, so a blank name
    // never reaches saveNewProject/updateProject. The typed value in
    // projectName is left exactly as the user entered it — only the value
    // sent to the database is trimmed, and only once validation passes.
    const trimmedName = projectName.trim();

    if (trimmedName === "") {
      setSaveStatus("error");
      setSaveError("Project name cannot be empty.");
      return;
    }

    // Nothing to persist and no failed attempt to retry — skip the network
    // request entirely rather than silently re-saving identical data.
    if (!isDirty && saveStatus !== "error") {
      return;
    }

    setSaveStatus("saving");
    setSaveError(null);

    if (projectId === null) {
      const { project, error } = await saveNewProject({
        name: trimmedName,
        templateId,
        config: projectConfig,
      });

      if (error || !project) {
        setSaveStatus("error");
        setSaveError(error ?? "Something went wrong while saving.");
        return;
      }

      // Feature 13.3 correction — write onboarding progress to the new
      // project's key synchronously, before anything else, rather than
      // relying on the hook's ordinary projectId-dependent effect to have
      // committed before router.replace below runs. That effect is only
      // guaranteed to fire on a future commit, and router.replace is not
      // guaranteed not to remount EditorShell before that commit happens —
      // this call removes the race entirely. A storage failure here is
      // caught and silently skipped inside the hook itself; it can never
      // fail or interrupt the project save that already succeeded above.
      onboarding.persistProgressForProject(project.id);

      setProjectId(project.id);
      setIsDirty(false);
      setSaveStatus("saved");
      setSaveError(null);

      // Feature 13.2 — identify the now-saved project in the URL so a
      // refresh reloads it as project-{id} (the branch in
      // app/editor/[id]/page.tsx that always loads the DB's own persisted
      // config) instead of re-entering the brand-new-template branch, which
      // would reset projectId to null and let a later Save create a second
      // row. A client-side transition, not a full navigation, so it never
      // triggers beforeunload and never discards the in-memory state above
      // (which already exactly matches what was just persisted).
      router.replace(`/editor/project-${project.id}`, { scroll: false });
      return;
    }

    const { project, error } = await updateProject({
      projectId,
      name: trimmedName,
      config: projectConfig,
    });

    if (error || !project) {
      setSaveStatus("error");
      setSaveError(error ?? "Something went wrong while saving.");
      return;
    }

    setIsDirty(false);
    setSaveStatus("saved");
    setSaveError(null);
  }

  // Feature 14.2 — the export handler. Fully synchronous/local: unlike
  // handleSave above, nothing here ever calls Supabase — it reads the
  // current in-memory projectConfig/projectName (already guaranteed to
  // match the persisted row whenever export is actually eligible, since
  // eligibility requires isDirty === false), builds the generated contract
  // with the exact same pure function tested in Feature 14.1, and triggers
  // a local file download. Never calls markDirty/setIsDirty/setSaveStatus/
  // setSaveError/handleSave — exportStatus/exportError are the only state
  // this function ever touches, so an export attempt (successful or not)
  // can never change what the Save button shows or silently re-save
  // anything.
  const exportEligibility = getGeneratedPosExportEligibility({
    projectId,
    isDirty,
    saveStatus,
  });

  function handleExport() {
    // Feature 14.2 — re-checked here (not just relied on via the disabled
    // button), so this function is safe to call from anywhere: it never
    // attempts generation or download while ineligible, and it never
    // creates/saves a project or retries a failed save to "fix" eligibility
    // itself — the user must use the existing Save button for that. The
    // `projectId === null` check is redundant with exportEligibility.canExport
    // at runtime (that can only be true when projectId is already known
    // non-null) but is what lets TypeScript narrow projectId to `string`
    // below, since it can't narrow it from a separate eligibility object.
    if (!exportEligibility.canExport || projectId === null) {
      return;
    }

    setExportStatus("exporting");
    setExportError(null);

    try {
      const generatedConfig = createGeneratedPosConfig({
        projectId,
        projectName,
        templateId,
        config: projectConfig,
      });

      const jsonText = `${JSON.stringify(generatedConfig, null, 2)}\n`;
      const filename = createGeneratedPosConfigFilename(
        projectName,
        generatedConfig.schemaVersion
      );

      downloadJsonFile(filename, jsonText);

      setExportStatus("success");
      setExportError(null);
    } catch (error) {
      setExportStatus("error");
      setExportError(
        error instanceof Error
          ? error.message
          : "Something went wrong while exporting."
      );
    }
  }

  // Feature 13.2 — warn only while there's something unsaved to lose; the
  // listener is added/removed as isDirty flips, so it's never registered
  // for a clean project and never lingers after a successful save.
  useEffect(() => {
    if (!isDirty) {
      return;
    }

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  return (
    <div className="flex h-screen flex-col bg-neutral-50">
      <EditorTopBar
        projectName={projectName}
        onProjectNameChange={handleProjectNameChange}
        onSave={handleSave}
        isDirty={isDirty}
        saveStatus={saveStatus}
        saveError={saveError}
        editorMode={editorMode}
        onToggleEditorMode={handleToggleEditorMode}
      />

      <div className="flex flex-1 overflow-hidden">
        <EditorSidebar
          editorSection={editorSection}
          setEditorSection={handleEditorSectionChange}
        />
        {editorMode === "edit" && editorSection === "Dashboard" ? (
          <ProjectDashboard
            orderTotals={orderTotals}
            orderTotalsError={orderTotalsError}
            menuItems={projectConfig.menuItems}
            currency={projectConfig.receipt.currency}
          />
        ) : editorMode === "edit" && editorSection === "Sales Report" ? (
          <SalesReport
            orderTotals={orderTotals}
            orderTotalsError={orderTotalsError}
            currency={projectConfig.receipt.currency}
          />
        ) : editorMode === "edit" && editorSection === "Product Performance" ? (
          <ProductPerformance
            orderTotals={orderTotals}
            orderTotalsError={orderTotalsError}
            currency={projectConfig.receipt.currency}
          />
        ) : editorMode === "edit" && editorSection === "Inventory Summary" ? (
          <InventorySummary
            menuItems={projectConfig.menuItems}
            inventoryTransactions={inventoryTransactions}
            inventoryTransactionsError={inventoryTransactionsError}
          />
        ) : editorMode === "edit" && editorSection === "Settings" ? (
          <ReceiptPreview
            businessProfile={projectConfig.businessProfile}
            receipt={projectConfig.receipt}
          />
        ) : (
          <EditorPreview
            menuItems={projectConfig.menuItems}
            selectedItemId={selectedItemId}
            onSelect={setSelectedItemId}
            branding={projectConfig.branding}
            businessProfile={projectConfig.businessProfile}
            tax={projectConfig.tax}
            receipt={projectConfig.receipt}
            editorMode={editorMode}
            cart={cart}
            cartSummary={cartSummary}
            onAddToCart={addToCart}
            onIncreaseQuantity={increaseQuantity}
            onDecreaseQuantity={decreaseQuantity}
            onRemoveFromCart={removeFromCart}
            onClearCart={clearCart}
            checkoutOpen={checkoutOpen}
            selectedPaymentMethod={selectedPaymentMethod}
            checkoutStatus={checkoutStatus}
            onOpenCheckout={openCheckout}
            onCloseCheckout={closeCheckout}
            onSelectPaymentMethod={selectPaymentMethod}
            onCompleteSale={completeSale}
            saleSaveStatus={saleSaveStatus}
            saleSaveError={saleSaveError}
            completedOrders={completedOrders}
            selectedReceiptId={selectedReceiptId}
            onOpenReceipt={openReceipt}
            onCloseReceipt={closeReceipt}
            lastCompletedOrderId={lastCompletedOrderId}
            layout={layout}
          />
        )}
        <EditorPropertiesPanel
          editorSection={editorSection}
          selectedItem={selectedItem}
          onUpdate={handleUpdateItem}
          onAdd={handleAddItem}
          onDuplicate={handleDuplicateItem}
          onDelete={handleDeleteItem}
          branding={projectConfig.branding}
          onBrandingChange={handleBrandingChange}
          businessProfile={projectConfig.businessProfile}
          onBusinessProfileChange={handleBusinessProfileChange}
          tax={projectConfig.tax}
          onTaxChange={handleTaxChange}
          receipt={projectConfig.receipt}
          onReceiptChange={handleReceiptChange}
          editorMode={editorMode}
          cartSummary={cartSummary}
          selectedPaymentMethod={selectedPaymentMethod}
          checkoutStatus={checkoutStatus}
          completedOrders={completedOrders}
          inventoryTransactions={inventoryTransactions}
          menuItems={projectConfig.menuItems}
          projectId={projectId}
          restockStatus={restockStatus}
          restockError={restockError}
          restockSuccessMessage={restockSuccessMessage}
          onRestock={handleRestock}
          adjustStatus={adjustStatus}
          adjustError={adjustError}
          adjustSuccessMessage={adjustSuccessMessage}
          onAdjust={handleInventoryAdjustment}
          exportEligibility={exportEligibility}
          exportStatus={exportStatus}
          exportError={exportError}
          onExport={handleExport}
        />
      </div>

      <OnboardingChecklist
        steps={onboarding.steps}
        isStepComplete={onboarding.isStepComplete}
        completedCount={onboarding.completedCount}
        totalCount={onboarding.totalCount}
        isOpen={onboarding.isOpen}
        projectId={projectId}
        onDismiss={onboarding.dismiss}
        onReopen={onboarding.reopen}
        onNavigateToStep={handleOnboardingNavigate}
      />
    </div>
  );
}
