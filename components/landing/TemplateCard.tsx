export default function TemplateCard({
    icon,
    title,
  }: {
    icon: string;
    title: string;
  }) {
    return (
      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: "12px",
          padding: "30px",
          width: "220px",
          textAlign: "center",
        }}
      >
        <h1>{icon}</h1>
  
        <h3>{title}</h3>
  
        <button>
          View Template
        </button>
  
      </div>
    );
  }
  