import Link from "next/link";
import type { ReactNode } from "react";

// Lane 3 Task 4 — the closing call to action shared by the SEO landing pages.
//
// SHARED BECAUSE THE STRUCTURE IS, NOT THE WORDS. Each page ends on a teal band
// with a heading, a sentence and one or two actions, the same way the homepage
// does; what each page asks the reader to do next is its own, so the heading,
// the body and the destinations are all passed in. The homepage's CTASection is
// not reused because its sentence is written for the homepage.
//
// A server component with no client JavaScript: the actions are links.

type LandingAction = {
  href: string;
  label: string;
};

type LandingClosingProps = {
  title: string;
  children: ReactNode;
  primary: LandingAction;
  secondary?: LandingAction;
};

export default function LandingClosing({
  title,
  children,
  primary,
  secondary,
}: LandingClosingProps) {
  return (
    <section className="pc-surface-teal">
      <div className="pc-container pc-section flex flex-col items-center gap-6 text-center">
        <h2 className="max-w-pc-narrow text-pc-title font-semibold text-balance text-ink">
          {title}
        </h2>

        <p className="max-w-pc-prose text-pc-lead text-pretty text-ink">
          {children}
        </p>

        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          <Link href={primary.href} className="pc-button pc-button--inverse pc-button--lg">
            {primary.label}
          </Link>

          {secondary ? (
            <Link href={secondary.href} className="pc-button pc-button--secondary pc-button--lg">
              {secondary.label}
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}
