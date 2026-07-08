export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-6 py-12 md:flex-row md:justify-between">
        <span className="text-base font-semibold tracking-tight text-neutral-900">
          POS Canvas
        </span>

        <nav className="flex items-center gap-6">
          <a
            href="#templates"
            className="text-sm text-neutral-600 transition-colors hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            Templates
          </a>

          <a
            href="#features"
            className="text-sm text-neutral-600 transition-colors hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            Features
          </a>
        </nav>

        <p className="text-sm text-neutral-500">
          © {year} POS Canvas. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
