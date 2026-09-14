// The customer journey the public homepage describes: the STEPS, declared once.
//
// WHY THIS MODULE EXISTS. The hero and the "How It Works" section each carried
// their own list of steps, and they disagreed — the hero showed four beats
// while the section was headed "From template to launch in three steps" and
// listed three. A visitor reading down the page met two different products.
// Two lists of the same thing drift; there is now one list and two renderings
// of it.
//
// WHAT LIVES HERE AND WHAT DOES NOT. This module owns the journey's SHAPE: how
// many steps there are, their order, and what each one is called. It does NOT
// own the sentence that explains each step — that copy stays in
// components/landing/HowItWorks.tsx, the only place it is rendered.
//
// That split is deliberate rather than tidy-minded. lib/publishTerminology.
// guards.test.ts asserts against HowItWorks.tsx that the landing page still
// says "Install POS Canvas" and "pair it with your published configuration",
// because those phrases are what replaced the superseded "a project produces
// an app" model. Moving that copy behind this module would leave that guard
// passing while pointing at a file that no longer contains any copy — a guard
// that cannot fail is worse than no guard, so the copy stays where it renders
// and where it is checked.
//
// WHAT THE STEPS ARE ALLOWED TO SAY. Every step describes something a v1.2.0
// owner can do today. No employee, workforce, time-clock, cash-movement,
// barcode or scanning step appears, because none of that is released. No
// infrastructure either — an owner does not need to know what publishing
// writes or where it is stored.
//
// Dependency-free (no React, no Supabase, no node builtins) so both renderers
// and the guards can import it anywhere.

export type JourneyStep = {
  /** Display order, zero-padded, as the section renders it. */
  number: string;
  /** Two or three words, for the hero's compact strip. */
  short: string;
  /** The step, as a heading. */
  title: string;
};

export const LANDING_JOURNEY: readonly JourneyStep[] = [
  { number: "01", short: "Create", title: "Create your POS" },
  { number: "02", short: "Choose a template", title: "Choose a template" },
  { number: "03", short: "Customize", title: "Customize" },
  { number: "04", short: "Publish", title: "Publish" },
  { number: "05", short: "Download & pair", title: "Download and pair" },
  { number: "06", short: "Start selling", title: "Run your business" },
] as const;

/** The hero's compact strip. Same steps, same order, fewer words. */
export const LANDING_JOURNEY_SHORT: readonly string[] = LANDING_JOURNEY.map(
  (step) => step.short
);
