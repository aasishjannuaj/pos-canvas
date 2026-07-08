import Navbar from "@/components/landing/Navbar";
import Hero from "@/components/landing/Hero";
import Templates from "@/components/landing/Templates";
import BusinessTypes from "@/components/landing/BusinessTypes";
import Features from "@/components/landing/Features";
import HowItWorks from "@/components/landing/HowItWorks";
import CTASection from "@/components/landing/CTASection";
import Footer from "@/components/landing/Footer";

export default function Home() {
  return (
    <main className="min-h-screen bg-neutral-50">
      <Navbar />
      <Hero />
      <Templates />
      <BusinessTypes />
      <Features />
      <HowItWorks />
      <CTASection />
      <Footer />
    </main>
  );
}
