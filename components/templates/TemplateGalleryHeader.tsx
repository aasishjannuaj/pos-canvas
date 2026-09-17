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
      {/* Lane 3 Task 3A — two unsupported claims removed from one sentence.
          "for every kind of business" was a breadth-of-support claim (there
          are six templates, not one per trade) and the metadata on this route
          carried the same wording; both were corrected together, because
          fixing only the metadata would have corrected the half nobody reads
          and left the half they do. "start building in seconds" was a
          setup-duration claim, and no setup-time guarantee has been
          established. "available today" is the honest bound on the first and
          does not go stale when a seventh template is added. */}
      <p className="mx-auto max-w-xl text-base text-neutral-600 md:text-lg">
        Browse the ready-made POS templates available today, and choose a
        starting point for your POS.
      </p>

      {/* Feature 22 Phase 4 — the one thing a first-time owner does not know:
          choosing a template is not a commitment, it is the start of editing. */}
      <p className="mx-auto max-w-xl text-sm text-neutral-500">
        Choosing a template opens the editor with starter items and prices you
        can change, laid out the way that template lays them out.
      </p>
    </div>
  );
}
