import PageContainer from "@/components/common/PageContainer";
import TemplateDetailHeader from "@/components/template-detail/TemplateDetailHeader";
import TemplatePreview from "@/components/template-detail/TemplatePreview";
import TemplateFeatures from "@/components/template-detail/TemplateFeatures";
import TemplateActionPanel from "@/components/template-detail/TemplateActionPanel";

type TemplateDetail = {
  icon: string;
  name: string;
  category: string;
  description: string;
  features: string[];
};

const templateDetails: Record<string, TemplateDetail> = {
  restaurant: {
    icon: "🍔",
    name: "Classic Restaurant",
    category: "Restaurant",
    description:
      "A complete table-service setup with menus, orders, and kitchen tickets built in.",
    features: [
      "Table and order management",
      "Menu categories with modifiers",
      "Kitchen ticket printing",
      "Split-check support",
    ],
  },
  cafe: {
    icon: "☕",
    name: "Cozy Cafe",
    category: "Cafe",
    description:
      "A quick-service layout built for fast checkout on drinks, pastries, and loyalty perks.",
    features: [
      "Quick-tap drink and food menu",
      "Loyalty and rewards tracking",
      "Tip prompts at checkout",
      "Daily sales summary",
    ],
  },
  retail: {
    icon: "🛍",
    name: "Modern Retail",
    category: "Retail",
    description:
      "An inventory-friendly layout designed for shelves full of products.",
    features: [
      "Barcode-ready product lookup",
      "Inventory count tracking",
      "Category and variant support",
      "Discount and promo codes",
    ],
  },
  "liquor-store": {
    icon: "🍺",
    name: "Liquor Store Essentials",
    category: "Liquor Store",
    description:
      "Fast bottle lookups with age-check reminders built into checkout.",
    features: [
      "Age-verification checkout prompt",
      "Fast bottle and case lookup",
      "Inventory by category and size",
      "End-of-day cash reconciliation",
    ],
  },
  "food-truck": {
    icon: "🚚",
    name: "Street Food Truck",
    category: "Food Truck",
    description:
      "A simple, fast-tap menu built for a small window and a moving line.",
    features: [
      "Simplified single-screen menu",
      "Fast order-to-kitchen flow",
      "Offline-friendly checkout",
      "Daily sales summary",
    ],
  },
  salon: {
    icon: "💇",
    name: "Salon & Spa",
    category: "Salon",
    description:
      "Service menus with add-ons and easy tipping for appointment-based businesses.",
    features: [
      "Service and add-on menu",
      "Appointment-friendly checkout",
      "Built-in tipping prompts",
      "Stylist or staff tracking",
    ],
  },
};

const defaultTemplate: TemplateDetail = {
  icon: "🧾",
  name: "General POS Template",
  category: "General",
  description:
    "A flexible starting point you can customize for your business.",
  features: [
    "Customizable item and category list",
    "Simple checkout flow",
    "Basic sales summary",
  ],
};

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const template = templateDetails[id] ?? defaultTemplate;

  return (
    <main className="min-h-screen bg-neutral-50">
      <PageContainer>
        <div className="flex flex-col gap-10">
          <TemplateDetailHeader
            name={template.name}
            category={template.category}
            description={template.description}
          />

          <div className="grid grid-cols-1 gap-10 lg:grid-cols-3">
            <div className="flex flex-col gap-10 lg:col-span-2">
              <TemplatePreview icon={template.icon} />
              <TemplateFeatures features={template.features} />
            </div>

            <div className="lg:col-span-1">
              <TemplateActionPanel />
            </div>
          </div>
        </div>
      </PageContainer>
    </main>
  );
}
