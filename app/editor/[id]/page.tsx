import EditorShell from "@/components/editor/EditorShell";

const projectNames: Record<string, string> = {
  restaurant: "Classic Restaurant",
  cafe: "Cozy Cafe",
  retail: "Modern Retail",
  "liquor-store": "Liquor Store Essentials",
  "food-truck": "Street Food Truck",
  salon: "Salon & Spa",
};

function formatFallbackName(id: string): string {
  return id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export default async function EditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const projectName = projectNames[id] ?? formatFallbackName(id);

  return <EditorShell projectName={projectName} />;
}
