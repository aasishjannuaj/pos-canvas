import Hero from "@/components/landing/Hero";
import Templates from "@/components/landing/Templates";
import HowItWorks from "@/components/landing/HowItWorks";

export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        fontFamily: "Arial, sans-serif",
        padding: "40px",
      }}
    >
      <Hero />
      <Templates />
      <HowItWorks />
    </main>
  );
}
