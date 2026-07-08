import TemplateCard from "@/components/dashboard/TemplateCard";
import { templates } from "@/data/templates";

export default function DashboardPage() {
  return (
    <main
      style={{
        padding: "40px",
        fontFamily: "Arial",
      }}
    >
      <h1>POS Canvas</h1>

      <p>Welcome to your dashboard.</p>

      <button
        style={{
          padding: "12px 24px",
          fontSize: "18px",
          marginBottom: "40px",
        }}
      >
        + Create New POS
      </button>

      <h2>Templates</h2>

      <div
        style={{
          display: "flex",
          gap: "20px",
          flexWrap: "wrap",
        }}
      >
        {templates.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
          />
        ))}
      </div>
    </main>
  );
}