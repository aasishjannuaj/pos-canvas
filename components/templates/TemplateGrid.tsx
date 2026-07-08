import TemplateGalleryCard from "./TemplateGalleryCard";

const templates = [
  {
    icon: "🍔",
    name: "Classic Restaurant",
    category: "Restaurant",
    description: "Table orders, menus, and kitchen tickets built in.",
  },
  {
    icon: "☕",
    name: "Cozy Cafe",
    category: "Cafe",
    description: "Quick checkout for drinks, pastries, and loyalty perks.",
  },
  {
    icon: "🛍",
    name: "Modern Retail",
    category: "Retail",
    description: "Inventory-friendly layout for shelves full of products.",
  },
  {
    icon: "🍺",
    name: "Liquor Store Essentials",
    category: "Liquor Store",
    description: "Age-check reminders and fast bottle lookups.",
  },
  {
    icon: "🚚",
    name: "Street Food Truck",
    category: "Food Truck",
    description: "Simple menu, fast taps, built for a small window.",
  },
  {
    icon: "💇",
    name: "Salon & Spa",
    category: "Salon",
    description: "Service menus, add-ons, and easy tipping.",
  },
  {
    icon: "💈",
    name: "Barber Shop",
    category: "Barber",
    description: "Walk-in friendly checkout for quick services.",
  },
  {
    icon: "🏪",
    name: "Corner Convenience",
    category: "Convenience Store",
    description: "Fast scan-and-go for high-volume small purchases.",
  },
];

export default function TemplateGrid() {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
      {templates.map((template) => (
        <TemplateGalleryCard
          key={template.name}
          icon={template.icon}
          name={template.name}
          category={template.category}
          description={template.description}
        />
      ))}
    </div>
  );
}
