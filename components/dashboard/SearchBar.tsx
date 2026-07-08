export default function SearchBar() {
  return (
    <div className="relative w-full">
      <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-neutral-400">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </span>

      <input
        type="text"
        placeholder="Search templates, projects, and more..."
        className="w-full rounded-full border border-neutral-200 bg-white py-3 pl-12 pr-5 text-sm text-neutral-900 placeholder-neutral-400 transition-colors focus:border-blue-600 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      />
    </div>
  );
}
