export default function Navbar() {
  return (
    <header className="sticky top-0 z-50 border-b border-neutral-200 bg-white/80 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <span className="text-lg font-semibold tracking-tight text-neutral-900">
          POS Canvas
        </span>

        <nav className="hidden items-center gap-8 md:flex">
          <a
            href="#templates"
            className="text-sm text-neutral-600 transition-colors hover:text-neutral-900"
          >
            Templates
          </a>

          <a
            href="#features"
            className="text-sm text-neutral-600 transition-colors hover:text-neutral-900"
          >
            Features
          </a>

          <a
            href="#how-it-works"
            className="text-sm text-neutral-600 transition-colors hover:text-neutral-900"
          >
            How It Works
          </a>
        </nav>

        <button
          type="button"
          className="rounded-full bg-neutral-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Get Started
        </button>
      </div>
    </header>
  );
}
