// Feature 14.2 — the browser-only mechanism that turns already-serialized
// JSON text into a local file download. Deliberately separate from
// lib/generatedPosConfig.ts, which must stay usable in a plain Node
// environment (and is unit-tested there) — Blob/URL.createObjectURL/
// document only exist in a browser, so this file is only ever called from
// client-side code (EditorShell's export handler), never imported by the
// Vitest suite. No third-party dependency; no DOM test environment is
// needed for this file — it's verified by hand in the browser instead,
// consistent with how this app already treats other browser-only glue
// (e.g. window.print() in Receipt.tsx/EditorPreview.tsx).
export function downloadJsonFile(filename: string, jsonText: string): void {
  // Feature 14.2 — if Blob/URL construction itself fails, that error
  // propagates straight to the caller (createGeneratedPosConfig's own
  // try/catch in EditorShell), rather than being swallowed here.
  const blob = new Blob([jsonText], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;

  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    // Feature 14.2 — the anchor is removed immediately regardless of
    // whether click() succeeded or threw, so a failed download attempt can
    // never leave a stray DOM node behind.
    document.body.removeChild(anchor);
  }

  // Feature 14.2 — revocation is deferred rather than run synchronously
  // right after click(): some browsers haven't necessarily finished
  // capturing the Blob reference for the download by the instant click()
  // returns, and revoking the object URL immediately can cause the
  // download to fail in those cases. Deferring to the next task (a 0ms
  // setTimeout, not a real delay) lets the current synchronous work
  // finish first while still revoking promptly rather than leaking the
  // object URL indefinitely.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
