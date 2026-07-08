import Link from "next/link";
import { Template } from "@/data/templates";

interface Props {
  template: Template;
}

export default function TemplateCard({ template }: Props) {
  return (
    <Link
      href={template.route}
      style={{
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div
        style={{
          border: "1px solid #ccc",
          borderRadius: "10px",
          padding: "20px",
          width: "220px",
          cursor: "pointer",
        }}
      >
        <h2>{template.icon}</h2>

        <h3>{template.name}</h3>

        <p>{template.description}</p>

        <button
          style={{
            marginTop: "10px",
            padding: "8px 12px",
          }}
        >
          Use Template
        </button>
      </div>
    </Link>
  );
}