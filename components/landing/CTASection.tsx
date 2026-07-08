export default function CTASection() {
  return (
    <section className="bg-blue-600">
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-6 px-6 py-20 text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">
          Ready to build your POS?
        </h2>

        <p className="max-w-xl text-base text-blue-100 md:text-lg">
          Pick a template, make it yours, and start taking orders today.
        </p>

        <button
          type="button"
          className="rounded-full bg-white px-8 py-3 text-base font-medium text-blue-600 transition-colors hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          Start Building
        </button>
      </div>
    </section>
  );
}
