import SectionHeading from "./SectionHeading";
import { LANDING_JOURNEY } from "@/lib/landingJourney";

// Lane 3 Task 2 — the step-count mismatch is fixed here, structurally.
//
// This section was headed "From template to launch in three steps" and listed
// three, while the hero above it showed four different beats. A visitor
// reading down the page met two versions of the same product. The set of steps
// now comes from lib/landingJourney.ts, which the hero also renders, so the
// two cannot disagree again — and the heading no longer states a count, which
// is the other half of how the old mismatch survived a step being added.
//
// WHY THE SENTENCES LIVE HERE AND NOT IN THAT MODULE. This is the only place
// they render, and lib/publishTerminology.guards.test.ts asserts against THIS
// FILE that the landing page says "Install POS Canvas" and "pair it with your
// published configuration" — the phrases that replaced the superseded model in
// which a project produced its own application. Moving the copy behind a module
// would leave that guard passing while reading a file with no copy in it.
//
// THE OWNER'S EXPERIENCE, NOT THE SYSTEM'S. No step mentions what publishing
// writes, where it is stored, or what builds anything. Step 05 is the one that
// carries the architecture, and it says the true thing plainly: you install the
// application, and pairing is what makes it yours.
const DESCRIPTIONS: Record<string, string> = {
  "01": "Start a project for your business. Everything you set up lives in one place you can come back to and change.",
  "02": "Pick the starting point closest to what you sell. You are choosing a set of products and a layout, not a different product.",
  "03": "Change items, categories, prices, taxes, add-ons and your business details until the screen matches the way you work.",
  "04": "Publish when it looks right. Your devices keep running the version you published until you publish another one.",
  "05": "Install POS Canvas on your Android or Windows device, then pair it with your published configuration. That is what turns the same application into your till.",
  "06": "Take payments in cash or card, hand over a receipt, and look back over what you sold. Selling keeps working if the connection drops.",
};

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="bg-surface-mint">
      <div className="pc-container pc-section">
        <SectionHeading
          eyebrow="How It Works"
          title="From an empty project to a working till"
          subtitle="Six steps, start to finish. No code at any point."
        />

        {/* An ordered list, because the order is the meaning. The numerals are
            decorative duplicates of that order, so they are hidden rather than
            read out before every heading. */}
        <ol className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {LANDING_JOURNEY.map((step) => (
            <li key={step.number} className="pc-card flex flex-col gap-3 p-6">
              <span
                aria-hidden="true"
                className="text-pc-meta font-bold tracking-widest text-brand-teal-deep"
              >
                {step.number}
              </span>

              <h3 className="text-lg font-semibold tracking-tight text-ink">
                {step.title}
              </h3>

              <p className="text-pc-meta leading-relaxed text-ink-muted">
                {DESCRIPTIONS[step.number]}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
