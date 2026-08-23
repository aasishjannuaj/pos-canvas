"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import EditorTopBar from "./EditorTopBar";
import EditorSidebar from "./EditorSidebar";
import EditorPreview from "./EditorPreview";
import EditorPropertiesPanel from "./EditorPropertiesPanel";
import { saveNewProject, updateProject, getProjectConfig } from "@/lib/projects";
import { completeSaleOrderV3 } from "@/lib/orders";
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
  CONFIGURATION_DOWNLOAD_FAILED_MESSAGE,
  createGeneratedPosConfig,
  createGeneratedPosConfigFilename,
  createRuntimeUrl,
  getGeneratedPosExportEligibility,
} from "@/lib/generatedPosConfig";
import { downloadJsonFile } from "@/lib/downloadJson";
import {
  getModifierSaveBlockerMessage,
  normalizeConfigModifiers,
} from "@/lib/modifierAuthoring";
import {
  calculateCartSummary,
  canAddItemQuantity,
  createCartItem,
  getItemQuantityInCart,
} from "@/lib/cart";
import type {
  CartItem,
  CartModifierSelection,
  CartSummary,
  CheckoutStatus,
  CompletedOrder,
  PaymentMethod,
  SaleSaveStatus,
} from "@/lib/cart";
import type { CompletedSaleReceipt } from "@/lib/completedSale";
import { isSubmitBlocked } from "@/lib/saleRequest";
import type { SaleRequestState } from "@/lib/saleRequest";
import {
  SALE_UNCONFIRMED_MESSAGE,
  planSaleSubmission,
  toCompletedOrder,
} from "@/lib/saleSubmission";
import {
  downloadBuildArtifact,
  requestBuildJob,
  refreshBuildJobStatus,
  startBuildProcessing,
} from "@/lib/buildJobs.actions";
import { isTerminalBuildStatus, needsBuildProcessing } from "@/lib/buildJobs";
import { PUBLISH_POLL_INTERVAL_MS, resolvePublishProgress } from "@/lib/publishProgress";
import type {
  BuildJobSummary,
  BuildProcessingState,
  BuildRequestStatus,
  BuildTarget,
} from "@/lib/buildJobs";
import DeviceManagementPanel from "@/components/devices/DeviceManagementPanel";
import { uploadProjectLogoAction } from "@/lib/logoUpload.actions";
import type { UploadLogoActionResult } from "@/lib/logoUpload.actions";
import type { LogoUploadStatus } from "./BrandingLogoField";

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
  | "Devices"
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

// Feature 18.2 Phase 5A — the Builder-preview sample tip is GONE, and this
// comment is the record of why, because deleting a number is the sort of change
// that gets quietly reinstated.
//
// Feature 14.3 introduced BUILDER_PREVIEW_SAMPLE_TIP = 3 so the preview cart
// kept showing a tip line. At the time that was cosmetic-adjacent: the Builder's
// checkout called complete_sale v1, which trusted every client amount anyway, so
// the sample tip was one invented number among several.
//
// Phase 5A migrates this checkout to complete_sale_v3, which recomputes
// subtotal, tax and totals from the authorized config and accepts exactly one
// client-supplied money value: the tip (v3 allows an owner tip because a real
// tip genuinely is a client input; it rejects any nonzero tip from a device).
// Passing 3 through that door would mean the ONE remaining trusted amount on the
// hardened path is a hardcoded sample — a phantom $3 of revenue on every preview
// sale, persisted to orders.tip_amount and counted by the Dashboard and Sales
// Report. It would also make the cart estimate disagree with the authoritative
// receipt, which would now correctly show what was actually charged.
//
// So the interactive preview cart passes a real tip amount of 0, exactly as
// components/runtime/PosRuntime.tsx has always done and for the same stated
// reason: there is no tip-entry UI in this MVP, so no nonzero tip may be
// fabricated. The Builder's EDIT-mode static mock is untouched — it keeps its
// own STATIC_TIP in EditorPreview.tsx, which is a design mock that completes no
// sale and persists nothing.
const BUILDER_PREVIEW_TIP = 0;

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

  // Feature 18.2 Phase 5A — the AUTHORITATIVE payload complete_sale_v3 returned
  // for the sale just completed in this session, kept alongside (not instead of)
  // completedOrders.
  //
  // Both are needed and neither is redundant: completedOrders is the Builder's
  // number-typed history model, seeded server-side at page load and used by
  // Recent Orders and every reporting panel, while this is the server's exact
  // answer for one sale — fixed two-decimal strings, rendered directly. Whenever
  // the receipt overlay is showing that sale, it renders THIS rather than the
  // projection, so the figures on screen are the ones the server charged.
  const [lastCompletedReceipt, setLastCompletedReceipt] =
    useState<CompletedSaleReceipt | null>(null);

  // One id per logical checkout attempt, reused across retries of an unchanged
  // cart so a lost response replays the original receipt instead of ringing up a
  // second sale. Identical in role to PosRuntime's own saleRequest state; both
  // are resolved by the shared planSaleSubmission.
  const [saleRequest, setSaleRequest] = useState<SaleRequestState | null>(null);

  // Feature 8.3/9.3 — persistence status for the current checkout attempt.
  // After a successful sale, saleSaveError may hold a non-blocking inventory
  // refresh WARNING even while saleSaveStatus stays "success" — it is not
  // reused to mean "the sale failed" in that case.
  const [saleSaveStatus, setSaleSaveStatus] = useState<SaleSaveStatus>("idle");
  const [saleSaveError, setSaleSaveError] = useState<string | null>(null);

  // Feature 19 — logo upload lifecycle. Deliberately its own pair of fields,
  // following exportStatus/buildRequestStatus rather than reusing saveStatus:
  // an upload is a separate operation from a save, and a failed upload must
  // never read as "your project failed to save".
  //
  // The governing rule this state exists to make visible: branding.logo is
  // reassigned ONLY on a confirmed successful upload, so every failure path
  // leaves the existing logo exactly as it was.
  const [logoUploadStatus, setLogoUploadStatus] =
    useState<LogoUploadStatus>("idle");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

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

  // Feature 15.4 — build-request state, independent of isDirty/saveStatus/
  // saveError and of exportStatus/exportError above. Requesting a build is
  // a pure server-side job request based on the already-saved project: it
  // never marks the project dirty, never touches save/export state, and
  // never modifies projectConfig.
  // Feature 22 Phase 2 — a constant, not state. The customer-facing platform
  // selector is gone (publishing produces a json_config snapshot, never a
  // platform binary), so nothing can change this value. It is retained because
  // requestBuildJob still sends a target and the worker contract is unchanged.
  const selectedBuildTarget: BuildTarget = "android";
  const [buildRequestStatus, setBuildRequestStatus] =
    useState<BuildRequestStatus>("idle");
  const [buildRequestError, setBuildRequestError] = useState<string | null>(null);
  const [latestBuildJob, setLatestBuildJob] = useState<BuildJobSummary | null>(
    null
  );
  const [latestBuildWasReused, setLatestBuildWasReused] = useState(false);
  // Feature 17.2 — whether a worker run was actually started for the displayed
  // build. Separate from buildRequestStatus because the request can succeed
  // (the build IS queued) while the trigger fails, and those two facts get
  // different copy. Never persisted and never read back from the server: it
  // describes the outcome of the last trigger attempt this session made.
  const [buildProcessing, setBuildProcessing] =
    useState<BuildProcessingState>("not_needed");
  // Feature 17.2 — guards a duplicate "Retry processing" click, kept distinct
  // from isRefreshingBuildStatus for the same reason that flag is distinct from
  // buildRequestStatus: three different actions, three different in-flight bits.
  const [isRetryingBuildProcessing, setIsRetryingBuildProcessing] =
    useState(false);
  // Feature 15.4 — the pending idempotency key for the *current* build
  // attempt. Generated only inside handleRequestBuild (never during
  // render), kept on a failed attempt so a retry reuses it, and cleared on
  // success so the next intentional request generates a fresh one.
  const [pendingRequestKey, setPendingRequestKey] = useState<string | null>(
    null
  );
  // Feature 15.4 — a small, separate flag guarding against a duplicate
  // "Refresh status" click while one is already in flight; kept distinct
  // from buildRequestStatus since refreshing and requesting are two
  // different actions that must never be conflated.
  const [isRefreshingBuildStatus, setIsRefreshingBuildStatus] = useState(false);
  /**
   * Feature 24.6 — guards the poll loop against overlapping itself.
   *
   * A ref rather than state on purpose: flipping it must not re-render, and it
   * must not be a dependency of the effect that reads it.
   */
  const pollInFlight = useRef(false);

  // Feature 15.7 — artifact download state, kept distinct from
  // buildRequestStatus and isRefreshingBuildStatus for the same reason
  // those two are distinct from each other: requesting a build, refreshing
  // its status, and downloading its artifact are three separate actions.
  // Deliberately only "idle" | "downloading" — there is no "success"
  // state to hold, because a successful download is an immediate browser
  // action with nothing left to display afterward, and no signed URL is
  // ever kept in React state (see handleDownloadArtifact).
  const [downloadStatus, setDownloadStatus] = useState<"idle" | "downloading">(
    "idle"
  );
  const [downloadError, setDownloadError] = useState<string | null>(null);

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

  // The tip is always BUILDER_PREVIEW_TIP (0) — see its declaration for why the
  // former tipsEnabled-conditional sample amount cannot survive the move to
  // complete_sale_v3. calculateCartSummary independently guards a non-finite or
  // negative value, but this literal is what guarantees the preview cart's
  // estimate matches the tip the server will actually record.
  const cartSummary = calculateCartSummary(
    cart,
    projectConfig.tax,
    BUILDER_PREVIEW_TIP
  );

  // Feature 18.2 Phase 5A — the receipt overlay shows the SERVER's payload
  // whenever the order being opened is the one completed in this session, and
  // falls back to the number-typed history model for anything older (those rows
  // are server data too — lib/orders.server.ts mapped them from order_items —
  // just without the fixed-decimal strings a live v3 response carries).
  //
  // Derived rather than stored: openReceipt keeps setting selectedReceiptId
  // alone, so there is no second piece of state that could name a different
  // order than the overlay is actually showing.
  const authoritativeReceipt =
    lastCompletedReceipt !== null && lastCompletedReceipt.orderId === selectedReceiptId
      ? lastCompletedReceipt
      : null;

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

  // Feature 19 — the logo handlers.
  //
  // ORDER IS THE WHOLE POINT of handleLogoUpload: the server action must
  // succeed first, and only its returned, server-computed BrandingLogo is
  // written into the draft. Nothing optimistic is applied, so an upload that
  // fails for any reason — bad format, oversized, corrupt, offline, revoked
  // session — leaves the existing logo untouched and still rendering.
  async function handleLogoUpload(file: File) {
    if (logoUploadStatus === "uploading") {
      return;
    }

    // A logo object is namespaced by project id, so there is nowhere to put one
    // for a project that has no database row yet.
    if (projectId === null) {
      setLogoUploadStatus("error");
      setLogoUploadError("Save this project before uploading a logo.");
      return;
    }

    setLogoUploadStatus("uploading");
    setLogoUploadError(null);

    let result: UploadLogoActionResult;

    try {
      result = await uploadProjectLogoAction({ projectId, file });
    } catch {
      // A transport-level failure (offline, aborted). The action itself returns
      // a controlled result for every error it can describe.
      setLogoUploadStatus("error");
      setLogoUploadError(
        "The logo could not be uploaded. Check your connection and try again."
      );
      return;
    }

    if (!result.ok) {
      setLogoUploadStatus("error");
      setLogoUploadError(result.message);
      return;
    }

    // Confirmed. Only now does the draft change — and through the same
    // handleBrandingChange every other Branding control uses, so the preview
    // updates immediately and the project is marked dirty for Save.
    handleBrandingChange({ logo: result.logo });
    setLogoUploadStatus("idle");
    setLogoUploadError(null);
  }

  // Clears the project's REFERENCE only. The stored object is never deleted:
  // an older build snapshot may still point at it, and a device pinned to that
  // build must keep rendering the logo it was built with. See
  // supabase/migrations/20260813120000_project_logo_storage.sql.
  function handleLogoRemove() {
    handleBrandingChange({ logo: undefined });
    setLogoUploadStatus("idle");
    setLogoUploadError(null);
  }

  /** A client-side rejection, shown without a pointless round trip. */
  function handleLogoReject(message: string) {
    setLogoUploadStatus("error");
    setLogoUploadError(message);
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

  function addToCart(menuItem: MenuItem, selections: CartModifierSelection[] = []) {
    setCart((prev) => {
      // Feature 18.2 — same line-identity rule as the runtime: a product with
      // two different selections is two lines, while stock is counted per
      // product across all of them.
      const line = createCartItem(menuItem, selections);
      const existing = prev.find((cartItem) => cartItem.lineKey === line.lineKey);

      // Feature 14.3 — shared with the runtime via lib/cart.ts, so both
      // ever only enforce one stock-limit rule. Equivalent to the previous
      // inline check (trackInventory && currentQuantity >= stockQuantity)
      // for a single-unit add.
      if (
        !canAddItemQuantity({
          item: menuItem,
          currentQuantity: getItemQuantityInCart(prev, menuItem.id),
          addQuantity: 1,
        })
      ) {
        return prev;
      }

      if (existing) {
        return prev.map((cartItem) =>
          cartItem.lineKey === line.lineKey
            ? { ...cartItem, quantity: cartItem.quantity + 1 }
            : cartItem
        );
      }

      return [...prev, line];
    });
  }

  function increaseQuantity(lineKey: string) {
    setCart((prev) =>
      prev.map((cartItem) => {
        if (cartItem.lineKey !== lineKey) {
          return cartItem;
        }

        const menuItem = projectConfig.menuItems.find((item) => item.id === cartItem.itemId);

        // Feature 14.3 — preserves the original fallthrough behavior for an
        // orphaned cart line with no matching menu item (always allowed to
        // increase, unchanged from before this extraction) — the shared
        // predicate is only consulted once a real menuItem is found.
        if (
          menuItem &&
          !canAddItemQuantity({
            item: menuItem,
            currentQuantity: getItemQuantityInCart(prev, cartItem.itemId),
            addQuantity: 1,
          })
        ) {
          return cartItem;
        }

        return { ...cartItem, quantity: cartItem.quantity + 1 };
      })
    );
  }

  function decreaseQuantity(lineKey: string) {
    setCart((prev) =>
      prev
        .map((cartItem) =>
          cartItem.lineKey === lineKey
            ? { ...cartItem, quantity: cartItem.quantity - 1 }
            : cartItem
        )
        .filter((cartItem) => cartItem.quantity > 0)
    );
  }

  function removeFromCart(lineKey: string) {
    setCart((prev) => prev.filter((cartItem) => cartItem.lineKey !== lineKey));
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

  // Feature 18.2 Phase 5A — the Builder Preview checkout, migrated from
  // complete_sale (v1) to complete_sale_v3.
  //
  // WHAT THIS PREVIEW ACTUALLY IS, since the name misleads: it completes a REAL
  // sale. It always has. Since Feature 8.3/9.2 it has written an orders row and
  // order_items rows, deducted inventory, recorded inventory_transactions, and
  // fed the Dashboard, Sales Report, Product Performance and Inventory Summary.
  // "Preview" describes the Builder surface it is driven from, not the
  // persistence. That is why this path is migrated rather than made simulated:
  // making it non-persistent would delete shipped, load-bearing behavior, and
  // would leave the same money defects standing until someone reinstated it.
  //
  // WHAT v1 GOT WRONG, and what v3 fixes here:
  //   - v1 trusted the client's subtotal, tax, tip, total, item names and unit
  //     prices. v3 accepts identifiers and quantities only and recomputes every
  //     amount from the authorized config.
  //   - Phase 3 made this cart modifier-bearing, so a preview line could carry
  //     modifier-adjusted money. v1 has no modifiers concept: it would have
  //     persisted the client's adjusted price with NO record of what was chosen,
  //     leaving order_items.modifiers empty. v3 revalidates the selection and
  //     writes the historical snapshot.
  //   - v1 took a client-generated order number derived from
  //     completedOrders.length, which two open tabs could collide on. v3
  //     allocates the number server-side.
  //   - v1 had no sale_request_id, so a lost response could ring up a second
  //     sale. v3 replays the original receipt for a repeated request id.
  //
  // The stock re-check, request-id decision and payload build are the SHARED
  // ones from lib/saleSubmission.ts — the same functions PosRuntime calls, not a
  // copy — so the Builder and the runtime cannot drift apart about what leaves
  // the browser.
  async function completeSale() {
    // Preserve the existing guards — unchanged from before Feature 8.3.
    if (cart.length === 0 || !selectedPaymentMethod || checkoutStatus === "success") {
      return;
    }

    // Double-submit guard, matching PosRuntime: a second click while a request
    // is in flight must never start a second attempt. The Builder previously
    // lacked this, relying on the disabled button alone.
    if (isSubmitBlocked(saleSaveStatus)) {
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

    const plan = planSaleSubmission({
      projectId,
      paymentMethod: selectedPaymentMethod,
      tipAmount: cartSummary.tip,
      cart,
      menuItems: projectConfig.menuItems,
      current: saleRequest,
    });

    if (!plan.ok) {
      setSaleSaveStatus("error");
      setSaleSaveError(plan.error);
      return;
    }

    setSaleRequest(plan.request);

    const { receipt, error } = await completeSaleOrderV3({
      projectId,
      paymentMethod: selectedPaymentMethod,
      tipAmount: cartSummary.tip,
      // Identifiers and quantities only — there is nowhere in this payload for
      // a client name, price, tax or total to sit.
      items: plan.items,
      saleRequestId: plan.request.id,
    });

    if (error || !receipt) {
      // The cart and the request id are both preserved, so pressing Complete
      // Sale again retries the SAME attempt. A transport failure may already
      // have committed server-side, so the message must not claim the sale
      // failed — the retry returns the original receipt if it did.
      setSaleSaveStatus("error");
      setSaleSaveError(error ?? SALE_UNCONFIRMED_MESSAGE);
      return;
    }

    // The sale is real and the server's payload is the record of it.
    // complete_sale_v3 has already revalidated the modifier selection, priced
    // every line from the authorized config, deducted inventory and written
    // inventory_transactions atomically; the client does none of that math.
    setLastCompletedReceipt(receipt);

    // A completed attempt must not reuse its id: the next sale is a new one.
    setSaleRequest(null);

    // Feature 11.1 — the exact confirmed order id for this sale, so the success
    // screen's "View Receipt" button can open it directly. It now comes from
    // the server rather than from a locally minted value.
    setLastCompletedOrderId(receipt.orderId);

    // The Builder's number-typed history model, projected from the SERVER's
    // answer rather than assembled from the cart that was submitted. Every
    // figure below therefore reflects what was actually charged, including any
    // modifier adjustment the server applied and any place its rounding differs
    // from the cart's estimate.
    const order: CompletedOrder = toCompletedOrder(receipt);

    setCompletedOrders((prev) => [order, ...prev]);

    // Feature 10.1/10.2/10.3 — so the Dashboard, Sales Report and Product
    // Performance all reflect this sale immediately, without a page reload or a
    // second fetch. This is a local append only; the server-side order totals
    // query is never re-run, so the sale cannot be double-counted there.
    //
    // lineTotal is now the server's own order_items.line_total rather than the
    // previous client-side price * quantity derivation, which could disagree
    // with the stored figure for a modifier-adjusted line.
    setOrderTotals((prev) => [
      {
        id: order.id,
        orderNumber: order.orderNumber,
        subtotal: order.subtotal,
        taxAmount: order.taxAmount,
        tip: order.tip,
        total: order.total,
        paymentMethod: order.paymentMethod,
        itemCount: receipt.items.reduce((sum, item) => sum + item.quantity, 0),
        items: receipt.items.map((item) => ({
          itemId: item.itemId,
          itemName: item.itemName,
          quantity: item.quantity,
          lineTotal: Number(item.lineTotal),
        })),
        createdAt: order.createdAt,
      },
      ...prev,
    ]);

    // Feature 10.4 — append one synthetic "sale" inventory transaction per
    // tracked line, so Inventory Summary (and the Inventory Activity panel,
    // which reads this same state) reflect this sale's stock deduction
    // immediately. Untracked items are skipped (no stock concept to record,
    // matching what complete_sale_v3's own inventory bookkeeping already does).
    //
    // Feature 18.2 Phase 5A — driven off the SERVER's line list, with a RUNNING
    // stock figure per product.
    //
    // complete_sale_v3 writes one inventory_transactions row per LINE, deducting
    // sequentially (10 -> 8 -> 6 for two lines of two). Since Phase 3 a cart can
    // hold two lines of the same product with different modifiers, so the
    // previous code — which read menuItem.stockQuantity fresh for every line —
    // would have shown the same quantityBefore twice and understated the
    // deduction. Tracking the running value reproduces the server's own numbers
    // exactly, and produces the same number of rows, so this session's Inventory
    // Activity matches what a page reload will show.
    //
    // (Before 18.2 the cart keyed on itemId and could not hold two lines of one
    // product, which is why reading the snapshot per line was correct then.)
    const runningStock = new Map<string, number>();

    const saleInventoryTransactions: InventoryTransaction[] = receipt.items
      .map((item, index): InventoryTransaction | null => {
        const menuItem = projectConfig.menuItems.find(
          (candidate) => candidate.id === item.itemId
        );

        if (!menuItem || !menuItem.trackInventory) {
          return null;
        }

        // The first line of a product starts from the pre-sale snapshot in
        // projectConfig.menuItems — nothing has decremented it locally yet, the
        // only update happens via the getProjectConfig() reload below.
        const quantityBefore = runningStock.get(item.itemId) ?? menuItem.stockQuantity;
        const quantityAfter = quantityBefore - item.quantity;

        runningStock.set(item.itemId, quantityAfter);

        return {
          id: `sale-${order.id}-${item.itemId}-${index}`,
          orderId: order.id,
          itemId: item.itemId,
          itemName: item.itemName,
          transactionType: "sale",
          quantityChange: -item.quantity,
          quantityBefore,
          quantityAfter,
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

    // Feature 18.2 Phase 5A — the modifier save boundary, blocked rather than
    // silently applied.
    //
    // Phase 4 warned per group ("Name this group so it can be saved") and then
    // let Save succeed anyway, normalizing the unsaveable group away. An owner
    // who missed the amber line lost work with no confirmation and no undo. This
    // uses the identical mechanism as the empty-name check directly above — the
    // long-standing way this editor refuses a save — so it introduces no new
    // blocking concept, and it deliberately fires only on LOSSY normalization
    // (a group that would vanish, or options that would be dropped). The
    // harmless maxSelections clamp still saves silently and keeps its notice.
    const modifierSaveBlocker = getModifierSaveBlockerMessage(projectConfig);

    if (modifierSaveBlocker !== null) {
      setSaveStatus("error");
      setSaveError(modifierSaveBlocker);
      return;
    }

    // Nothing to persist and no failed attempt to retry — skip the network
    // request entirely rather than silently re-saving identical data.
    if (!isDirty && saveStatus !== "error") {
      return;
    }

    setSaveStatus("saving");
    setSaveError(null);

    // Feature 18.2 Phase 4 — the save boundary for authored modifiers.
    //
    // The Builder writes every keystroke straight into projectConfig, which is
    // the long-standing behavior for item name, price and category and is left
    // alone. That means a half-typed modifier group IS in the draft, and before
    // this line it would have been written verbatim into projects.config and
    // then silently dropped by normalizeProjectConfig on the next load.
    //
    // Normalizing here — with the same lib/modifiers.ts function that runs at
    // load and at build, never a second implementation — keeps typing free-form
    // while guaranteeing the persisted config only ever holds sellable groups.
    // Deliberately only modifierGroups: running the whole normalizeProjectConfig
    // on save would change behavior for every unrelated field.
    const configToPersist = normalizeConfigModifiers(projectConfig);

    if (projectId === null) {
      const { project, error } = await saveNewProject({
        name: trimmedName,
        templateId,
        config: configToPersist,
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
      config: configToPersist,
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

  // Feature 14.4 — a plain derived value, not state: Launch POS is a pure
  // navigation action (a real link), so there is nothing to store beyond
  // what's already computed here on every render. Reuses exportEligibility
  // as-is (unrenamed) for Launch readiness too, since both actions require
  // exactly the same thing — a saved, clean, not-currently-saving project.
  const runtimeUrl = projectId === null ? null : createRuntimeUrl(projectId);

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
    } catch {
      // Feature 22 Phase 4 — the exception is deliberately not bound. It used
      // to be rendered verbatim, and the fix is not "render it more carefully"
      // but "have nothing to render": with no binding there is no path from a
      // caught throw to this component's output at all. Only the fixed message
      // below can reach the screen.
      //
      // Nothing else in this handler changes — the same eligibility check, the
      // same generation call, the same filename, the same download, and the
      // same exportStatus/exportError state. Only the text of the failure.
      setExportStatus("error");
      setExportError(CONFIGURATION_DOWNLOAD_FAILED_MESSAGE);
    }
  }

  // Feature 15.4 — requests (or reuses) a queued build job for the
  // selected target. Reuses exportEligibility exactly as Launch POS does
  // (unrenamed, per the approved plan) — layering buildRequestStatus ===
  // "submitting" on top as the one build-specific readiness rule. Never
  // touches isDirty/saveStatus/saveError/exportStatus/exportError/
  // onboarding/projectConfig — the only state this function ever writes is
  // its own build-request state declared above.
  async function handleRequestBuild() {
    if (!exportEligibility.canExport || projectId === null) {
      return;
    }

    if (buildRequestStatus === "submitting") {
      return;
    }

    // Feature 15.4 — reuse the pending key from a previous failed attempt
    // (a retry of the same intentional request) or generate a fresh one
    // for a genuinely new attempt. Generated here, inside the handler,
    // never during render. createId() is the same crypto.randomUUID()
    // (with its existing defensive fallback) already used elsewhere in
    // this file for menu item ids.
    const requestKey = pendingRequestKey ?? createId();

    if (pendingRequestKey === null) {
      setPendingRequestKey(requestKey);
    }

    setBuildRequestStatus("submitting");
    // Only the error is cleared here — latestBuildJob/latestBuildWasReused
    // deliberately stay in place while submitting, so the previously shown
    // result doesn't blank out while a new request is in flight.
    setBuildRequestError(null);

    const result = await requestBuildJob({
      projectId,
      target: selectedBuildTarget,
      requestKey,
    });

    if (!result.ok) {
      setBuildRequestStatus("error");
      setBuildRequestError(result.message);
      return;
    }

    setPendingRequestKey(null);
    setLatestBuildJob(result.job);
    setLatestBuildWasReused(result.reusedExisting);
    setBuildRequestStatus("success");
    setBuildRequestError(null);
    // Feature 17.2 — the build is queued either way; this only decides whether
    // the panel says processing has started or offers "Retry processing".
    setBuildProcessing(result.processing);
  }

  // Feature 17.2 — retries the GitHub trigger for the build that is ALREADY
  // displayed. Never calls requestBuildJob, so it cannot create a second
  // build_jobs row; the id it sends is the one the server itself returned.
  async function handleRetryBuildProcessing() {
    if (latestBuildJob === null || isRetryingBuildProcessing) {
      return;
    }

    setIsRetryingBuildProcessing(true);

    const result = await startBuildProcessing(latestBuildJob.id);

    if (!result.ok) {
      // Surfaced through buildRequestError, which the panel already renders
      // inside the job card. buildProcessing stays "unavailable", so the retry
      // button remains available.
      setBuildRequestError(result.message);
      setIsRetryingBuildProcessing(false);
      return;
    }

    // The action re-read the job, so this also picks up a build that finished
    // while the notice was on screen.
    setLatestBuildJob(result.job);
    setBuildProcessing(result.processing);
    setBuildRequestError(null);
    setIsRetryingBuildProcessing(false);
  }

  // Feature 15.4 — a manual, one-shot refresh of the currently displayed
  // job's status only — no polling, no interval, no router.refresh(). Kept
  // fully separate from buildRequestStatus: refreshing and requesting are
  // two different actions and must never be conflated.
  async function handleRefreshBuildStatus() {
    if (latestBuildJob === null || isRefreshingBuildStatus) {
      return;
    }

    setIsRefreshingBuildStatus(true);

    const result = await refreshBuildJobStatus(latestBuildJob.id);

    if (!result.ok) {
      setBuildRequestError(result.message);
      setIsRefreshingBuildStatus(false);
      return;
    }

    setLatestBuildJob(result.job);
    setBuildRequestError(null);
    setIsRefreshingBuildStatus(false);
  }

  // Feature 15.7 — the artifact download handler. Requests a fresh
  // short-lived signed URL on every click (never reuses one, never keeps
  // one in state), then triggers the download with a temporary anchor
  // click — the same mechanism lib/downloadJson.ts already uses for the
  // manual JSON export, minus the Blob/object-URL bookkeeping that a real
  // remote URL doesn't need.
  //
  // Never calls window.open (popup-blocker risk) and never assigns
  // window.location (which would navigate the Builder away if attachment
  // handling ever behaved unexpectedly). Never marks the project dirty and
  // never touches save/export/build-request state — downloadStatus and
  // downloadError are the only state this function writes.
  async function handleDownloadArtifact() {
    if (latestBuildJob === null || latestBuildJob.status !== "succeeded") {
      return;
    }

    if (downloadStatus === "downloading") {
      return;
    }

    setDownloadStatus("downloading");
    setDownloadError(null);

    try {
      const result = await downloadBuildArtifact(latestBuildJob.id);

      if (!result.ok) {
        // result.message is already a first-party sanitized string from
        // lib/buildJobs.download.ts's approved message table — never a raw
        // Supabase/Storage error — so it is displayed as-is.
        setDownloadError(result.message);
        return;
      }

      // Feature 15.7 — the signed URL is used immediately and never stored
      // in React state, a ref, localStorage, or a log. `download` is set
      // from the server-trusted filename as a courtesy, but the signed
      // URL's own Content-Disposition header (set by Supabase Storage via
      // the `download` option server-side) is the authoritative source of
      // the saved filename.
      const anchor = document.createElement("a");
      anchor.href = result.url;
      anchor.download = result.filename;
      anchor.rel = "noopener noreferrer";

      try {
        document.body.appendChild(anchor);
        anchor.click();
      } finally {
        // Removed regardless of whether click() threw, so a failed attempt
        // can never leave a stray anchor (holding a live signed URL) in
        // the DOM.
        anchor.remove();
      }
    } finally {
      setDownloadStatus("idle");
    }
  }

  // Feature 13.2 — warn only while there's something unsaved to lose; the
  // listener is added/removed as isDirty flips, so it's never registered
  // for a clean project and never lingers after a successful save.
  /**
   * Feature 24.6 — watches a publish that is still running.
   *
   * WHY THIS EXISTS. Until now the only way to see a publish advance was to
   * press Refresh status: there was no timer anywhere in the editor, so an owner
   * who published and waited watched a screen that never changed and could not
   * tell a working queue from a stuck one. The stepper is only honest if it
   * actually moves.
   *
   * ONE LOOP, BY CONSTRUCTION. It reschedules with setTimeout AFTER each read
   * completes rather than running on an interval, so a slow response can never
   * stack a second request behind the first. The effect keys on the job id and
   * its STATUS, so a poll that returns the same status does not tear the loop
   * down and restart it, and a status change re-runs the effect — which is what
   * stops it, because a terminal status returns before scheduling anything.
   *
   * IT ONLY EVER READS. refreshBuildJobStatus re-reads the job this panel is
   * already showing; there is no path from here to requestBuildJob, so polling
   * cannot create a second publish however long it runs.
   *
   * A HIDDEN TAB IS NOT POLLED. A backgrounded editor left open all afternoon
   * should not keep asking, so a hidden document skips its turn, and becoming
   * visible again reads immediately rather than waiting out the remaining delay.
   */
  useEffect(() => {
    const job = latestBuildJob;

    if (job === null || isTerminalBuildStatus(job.status)) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delayMs: number) => {
      if (cancelled) return;
      timer = setTimeout(() => void tick(), delayMs);
    };

    const tick = async () => {
      if (cancelled || pollInFlight.current) return;

      // Hidden tab: keep the loop alive but ask nothing.
      if (typeof document !== "undefined" && document.hidden) {
        schedule(PUBLISH_POLL_INTERVAL_MS);
        return;
      }

      pollInFlight.current = true;

      try {
        const result = await refreshBuildJobStatus(job.id);

        if (cancelled) return;

        if (result.ok) {
          setLatestBuildJob(result.job);

          // Terminal: stop here rather than scheduling a tick the effect
          // re-run would only have to cancel.
          if (isTerminalBuildStatus(result.job.status)) return;
        }
        // A failed read is not surfaced as an error: the owner did not ask for
        // this one, and Refresh status is still there if they want to know.
      } finally {
        pollInFlight.current = false;
      }

      schedule(PUBLISH_POLL_INTERVAL_MS);
    };

    const onVisibility = () => {
      if (cancelled || document.hidden) return;
      if (timer !== null) clearTimeout(timer);
      schedule(0);
    };

    schedule(PUBLISH_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestBuildJob?.id, latestBuildJob?.status]);

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
        ) : editorMode === "edit" && editorSection === "Devices" ? (
          /* Feature 16.4B — self-contained: the panel loads its own devices
             and builds through existing server actions, so only the project
             id crosses this boundary. */
          <DeviceManagementPanel
            projectId={projectId}
            onGoToBuild={() => handleEditorSectionChange("Settings")}
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
            authoritativeReceipt={authoritativeReceipt}
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
          logoUploadStatus={logoUploadStatus}
          logoUploadError={logoUploadError}
          onLogoUpload={handleLogoUpload}
          onLogoRemove={handleLogoRemove}
          onLogoReject={handleLogoReject}
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
          runtimeUrl={runtimeUrl}
          exportEligibility={exportEligibility}
          exportStatus={exportStatus}
          exportError={exportError}
          onExport={handleExport}
          buildRequestStatus={buildRequestStatus}
          buildRequestError={buildRequestError}
          latestBuildJob={latestBuildJob}
          latestBuildWasReused={latestBuildWasReused}
          // Feature 17.2 — derived, not stored: a job that has since finished
          // needs no processing notice at all, so "Retry processing" disappears
          // by itself as soon as a Refresh shows the build succeeded or failed.
          // Deriving it here rather than writing state in an effect keeps this
          // a pure function of the job that is actually on screen.
          buildProcessing={
            latestBuildJob !== null && needsBuildProcessing(latestBuildJob.status)
              ? buildProcessing
              : "not_needed"
          }
          isRetryingBuildProcessing={isRetryingBuildProcessing}
          onRetryBuildProcessing={handleRetryBuildProcessing}
          onRequestBuild={handleRequestBuild}
          onRefreshBuildStatus={handleRefreshBuildStatus}
          // Feature 24.6 — derived, never stored. One function decides what
          // the stepper shows, so the panel cannot disagree with the job.
          publishProgress={resolvePublishProgress({
            requestStatus: buildRequestStatus,
            job: latestBuildJob,
          })}
          isRefreshingBuildStatus={isRefreshingBuildStatus}
          downloadStatus={downloadStatus}
          downloadError={downloadError}
          onDownloadArtifact={handleDownloadArtifact}
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
