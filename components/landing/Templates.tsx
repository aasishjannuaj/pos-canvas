import TemplateCard from "./TemplateCard";

export default function Templates() {
  return (
    <section>
      <h2
        style={{
          textAlign: "center",
          marginBottom: "30px",
        }}
      >
        Popular Templates
      </h2>

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: "20px",
          flexWrap: "wrap",
        }}
      >
        <TemplateCard
          icon="🍔"
          title="Restaurant"
        />

        <TemplateCard
          icon="☕"
          title="Cafe"
        />

        <TemplateCard
          icon="🛍"
          title="Retail"
        />

        <TemplateCard
          icon="🍺"
          title="Liquor Store"
        />
      </div>
    </section>
  );
}
