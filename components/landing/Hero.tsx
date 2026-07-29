import Link from "next/link";
import { LANDING_ROUTES, LANDING_SECTION_ANCHORS } from "@/lib/landingNav";

// Navigation fix — "Start Building" was a <button type="button"> with no
// onClick and no href, so it silently did nothing. It is now a real Link to
// /templates (the public template gallery), which is the correct entry point
// for starting a build regardless of auth state: /templates is not
// proxy-protected, so a visitor can browse before being asked to sign in at
// the /editor step.
export default function Hero() {
  return (
    <section className="mx-auto flex max-w-4xl flex-col items-center gap-6 px-6 py-24 text-center md:py-32">
      <h1 className="text-4xl font-semibold tracking-tight text-neutral-900 md:text-6xl">
        Build your own POS system
        <br className="hidden md:block" /> without writing code
      </h1>

      <p className="max-w-2xl text-lg text-neutral-600 md:text-xl">
        Choose a template, customize it for your business, and download a
        point-of-sale app that&apos;s ready to run.
      </p>

      <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row">
        <Link
          href={LANDING_ROUTES.templates}
          className="inline-flex items-center justify-center rounded-full bg-blue-600 px-8 py-3 text-base font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Start Building
        </Link>

        <a
          href={LANDING_SECTION_ANCHORS.templates}
          className="text-base font-medium text-neutral-700 underline underline-offset-4 transition-colors hover:text-neutral-900"
        >
          See Templates
        </a>
      </div>
    </section>
  );
}
