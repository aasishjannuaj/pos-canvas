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
        <button
          type="button"
          className="rounded-full bg-blue-600 px-8 py-3 text-base font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Start Building
        </button>

        <a
          href="#templates"
          className="text-base font-medium text-neutral-700 underline underline-offset-4 transition-colors hover:text-neutral-900"
        >
          See Templates
        </a>
      </div>
    </section>
  );
}
