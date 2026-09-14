import Navbar from "@/components/landing/Navbar";
import Hero from "@/components/landing/Hero";
import Templates from "@/components/landing/Templates";
import BusinessTypes from "@/components/landing/BusinessTypes";
import Features from "@/components/landing/Features";
import HowItWorks from "@/components/landing/HowItWorks";
import PlatformAvailability from "@/components/landing/PlatformAvailability";
import CTASection from "@/components/landing/CTASection";
import Footer from "@/components/landing/Footer";

// Lane 3 Task 2 — the page ground is the design system's cream rather than
// bg-neutral-50, so the gap under a short page and the seam at every section
// boundary are the site's own colour instead of a cool grey that belonged to
// no palette. The section ORDER is unchanged, and
// lib/platformDiscoverability.guards.test.ts asserts part of it:
// PlatformAvailability sits between HowItWorks and CTASection.
//
// The sections alternate deliberately — cream hero, white templates, cream
// explanation, white features, mint walkthrough, white platforms, teal call to
// action, cream footer — so a visitor can tell where one idea ends and the next
// begins without a rule between them.
export default function Home() {
  return (
    <main className="min-h-screen bg-brand-cream">
      <Navbar />
      <Hero />
      <Templates />
      <BusinessTypes />
      <Features />
      <HowItWorks />
      <PlatformAvailability />
      <CTASection />
      <Footer />
    </main>
  );
}
