import SectionHeading from "./SectionHeading";
import FeatureCard from "./FeatureCard";

// Lane 3 Task 2 — THIS SECTION WAS THE PAGE'S BIGGEST UNTRUTH.
//
// It shipped three cards, and the third ("Instant Download — Export your
// finished POS app and start using it right away") described the superseded
// architecture in which a project produced its own application. That has not
// been how the product works since Feature 22: publishing freezes a business
// CONFIGURATION, and the application is one universal build per platform that
// becomes a specific till by pairing. An owner who believed the old card would
// have been waiting for an app that is never generated.
//
// EVERY CARD BELOW IS RELEASED IN v1.2.0. The test for inclusion was not "is it
// built" but "can an owner use it today", and each maps to shipped code:
// products/categories/prices and modifier groups (lib/projectConfig.ts,
// lib/modifiers.ts), taxes and receipt settings (TaxSettings, ReceiptSettings),
// customer branding (BrandingSettings — the merchant's own logo and accent
// colour, which is a different thing from the POS Canvas identity in
// lib/brand.ts), per-item stock (MenuItem.trackInventory), the two native apps
// and pairing (lib/platformDownloads.ts, lib/devicePairing.ts), offline selling
// and its sync queue (lib/offlineCheckout.ts, lib/saleQueue.ts), and sales
// history (lib/salesHistoryView.ts).
//
// DELIBERATELY ABSENT: employee management, time clock, register sessions, cash
// movements, barcode catalogue and scanning. Those are v1.3 work that is not
// released, and a "coming soon" card for them would still be a promise this
// page has no business making yet. lib/homepageTruth.guards.test.ts fails if
// any of that vocabulary appears here.
const features = [
  {
    icon: "🧩",
    title: "Products, categories and add-ons",
    description:
      "Build the catalogue you actually sell: items, the categories they sit in, their prices, and the options and add-ons that change them at checkout.",
  },
  {
    icon: "🧮",
    title: "Taxes and receipts",
    description:
      "Set your tax rate and whether prices include it, then decide what your receipt says. Print it or hand it over on screen.",
  },
  {
    icon: "🎨",
    title: "Your business, not ours",
    description:
      "Your business name, your logo and an accent colour carry through to the screen your staff and customers actually look at.",
  },
  {
    icon: "📦",
    title: "Inventory tracking",
    description:
      "Turn on stock tracking for the items that need it and watch counts move as you sell. Leave it off for services.",
  },
  {
    icon: "📱",
    title: "Android and Windows",
    description:
      "Install the POS Canvas application on a device and pair it with your published configuration. The same application runs every business.",
  },
  {
    icon: "🛰️",
    title: "Selling when the network drops",
    description:
      "Keep taking sales while the connection is out. They queue on the device and sync once it returns, and your sales history holds the record.",
  },
];

export default function Features() {
  return (
    <section id="features" className="bg-surface-raised">
      <div className="pc-container pc-section">
        <SectionHeading
          eyebrow="Features"
          title="What you get the day you start"
          subtitle="Everything here works in the version you can download today."
        />

        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <FeatureCard
              key={feature.title}
              icon={feature.icon}
              title={feature.title}
              description={feature.description}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
