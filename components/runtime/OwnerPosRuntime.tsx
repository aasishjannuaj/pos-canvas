"use client";

// Feature 16.4A — the OWNER host for the shared POS engine.
//
// PosRuntime used to import lib/orders.ts and lib/projects.ts directly. Those
// two imports are now here instead, so the engine stays transport-agnostic and
// a paired device can render it without dragging the cookie-backed owner
// client into its bundle.
//
// Behavior is deliberately unchanged: the same completeSaleOrderV2 call with
// the same arguments, the same getProjectConfig refresh with the same
// stock/trackInventory merge semantics, and the same Back to Dashboard link.
// This file adds no logic of its own — it only supplies what the engine
// previously imported.
import PosRuntime from "@/components/runtime/PosRuntime";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import { completeSaleOrderV2 } from "@/lib/orders";
import { getProjectConfig } from "@/lib/projects";
import type {
  PosRuntimeCompleteSale,
  PosRuntimeRefreshStock,
} from "@/lib/posRuntimeHost";

const completeSale: PosRuntimeCompleteSale = (input) =>
  completeSaleOrderV2({
    projectId: input.projectId,
    paymentMethod: input.paymentMethod,
    tipAmount: input.tipAmount,
    items: input.items,
    saleRequestId: input.saleRequestId,
  });

const refreshStock: PosRuntimeRefreshStock = async (projectId) => {
  const { config, error } = await getProjectConfig(projectId);

  if (error || !config) {
    return { menuItems: null, error: error ?? "Inventory could not be refreshed." };
  }

  return { menuItems: config.menuItems, error: null };
};

export default function OwnerPosRuntime({
  config,
}: {
  config: GeneratedPosConfig;
}) {
  return (
    <PosRuntime
      config={config}
      submitSale={completeSale}
      refreshStock={refreshStock}
      homeLink={{ href: "/dashboard", label: "← Back to Dashboard" }}
    />
  );
}
