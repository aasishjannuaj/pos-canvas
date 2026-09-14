// The publish-and-pair architecture, drawn.
//
// INLINE SVG, NOT AN IMAGE FILE and not a screenshot. It illustrates a
// relationship rather than depicting a screen, so there is nothing here that
// could be mistaken for a picture of the product — which is what makes it safe
// to draw while no real screenshots are committed.
//
// role="img" with a title/desc pair: a screen reader gets one meaningful
// description instead of reading out two dozen unlabelled shapes. It scales
// with its container via viewBox and carries no animation.
export default function PublishAndPairDiagram() {
  return (
    <svg
      viewBox="0 0 760 250"
      role="img"
      aria-labelledby="publish-pair-title publish-pair-desc"
      className="h-auto w-full"
    >
      <title id="publish-pair-title">
        How a published configuration reaches a paired device
      </title>
      <desc id="publish-pair-desc">
        Your project in the browser produces a published configuration. The same
        POS Canvas application, downloaded identically by every business, pairs
        with that configuration to become your till.
      </desc>

      <defs>
        <marker
          id="pp-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-brand-teal-deep)" />
        </marker>
      </defs>

      {/* Your project */}
      <rect x="8" y="64" width="196" height="96" rx="18"
        fill="var(--color-surface-raised)" stroke="var(--color-hairline)" />
      <text x="106" y="100" textAnchor="middle" fontSize="15" fontWeight="600"
        fill="var(--color-ink)">Your project</text>
      <text x="106" y="124" textAnchor="middle" fontSize="12.5"
        fill="var(--color-ink-muted)">Products, prices, tax,</text>
      <text x="106" y="141" textAnchor="middle" fontSize="12.5"
        fill="var(--color-ink-muted)">receipt, branding</text>

      <line x1="212" y1="112" x2="266" y2="112" stroke="var(--color-brand-teal-deep)"
        strokeWidth="2" markerEnd="url(#pp-arrow)" />
      <text x="239" y="100" textAnchor="middle" fontSize="11" fontWeight="600"
        fill="var(--color-brand-teal-deep)">publish</text>

      {/* Published configuration */}
      <rect x="274" y="64" width="204" height="96" rx="18"
        fill="var(--color-surface-mint)" stroke="var(--color-hairline-teal)" />
      <text x="376" y="100" textAnchor="middle" fontSize="15" fontWeight="600"
        fill="var(--color-ink)">Published configuration</text>
      <text x="376" y="124" textAnchor="middle" fontSize="12.5"
        fill="var(--color-ink-muted)">Frozen until you</text>
      <text x="376" y="141" textAnchor="middle" fontSize="12.5"
        fill="var(--color-ink-muted)">publish again</text>

      <line x1="486" y1="112" x2="540" y2="112" stroke="var(--color-brand-teal-deep)"
        strokeWidth="2" markerEnd="url(#pp-arrow)" />
      <text x="513" y="100" textAnchor="middle" fontSize="11" fontWeight="600"
        fill="var(--color-brand-teal-deep)">pair</text>

      {/* Your till */}
      <rect x="548" y="64" width="204" height="96" rx="18"
        fill="var(--color-surface-raised)" stroke="var(--color-hairline)" />
      <text x="650" y="100" textAnchor="middle" fontSize="15" fontWeight="600"
        fill="var(--color-ink)">Your till</text>
      <text x="650" y="124" textAnchor="middle" fontSize="12.5"
        fill="var(--color-ink-muted)">A paired Android or</text>
      <text x="650" y="141" textAnchor="middle" fontSize="12.5"
        fill="var(--color-ink-muted)">Windows device</text>

      {/* The universal application, feeding the till from below. */}
      <rect x="548" y="186" width="204" height="52" rx="16"
        fill="var(--color-brand-cream)" stroke="var(--color-hairline-strong)"
        strokeDasharray="5 4" />
      <text x="650" y="208" textAnchor="middle" fontSize="12.5" fontWeight="600"
        fill="var(--color-ink)">The POS Canvas app</text>
      <text x="650" y="226" textAnchor="middle" fontSize="11.5"
        fill="var(--color-ink-subtle)">the same download for every business</text>
      <line x1="650" y1="186" x2="650" y2="166" stroke="var(--color-hairline-strong)"
        strokeWidth="2" markerEnd="url(#pp-arrow)" />
    </svg>
  );
}
