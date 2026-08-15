// Feature 22 Phase 4 — the search box and the category filter row were removed.
// Neither was wired to anything: typing filtered nothing and every chip was a
// <button> with no onClick, so the gallery silently ignored both. This page sits
// on the first-run path (dashboard -> Create Project -> template -> editor), and
// a filter that appears to do nothing reads as a broken product at exactly the
// moment an owner is deciding whether to trust it. Six templates fit on one
// screen; filtering them is a feature to build when there are enough to need it,
// not a control to leave dead in the meantime.
export default function TemplateGalleryHeader() {
  return (
    <div className="flex flex-col gap-2 text-center">
      <h1 className="text-4xl font-semibold tracking-tight text-neutral-900">
        Template Gallery
      </h1>
      <p className="mx-auto max-w-xl text-base text-neutral-600 md:text-lg">
        Browse ready-made POS templates for every kind of business, and
        start building in seconds.
      </p>

      {/* Feature 22 Phase 4 — the one thing a first-time owner does not know:
          choosing a template is not a commitment, it is the start of editing. */}
      <p className="mx-auto max-w-xl text-sm text-neutral-500">
        Choosing a template opens the editor with starter items, prices and a
        layout you can change.
      </p>
    </div>
  );
}
