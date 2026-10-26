// Batch B (Inventory corrections) — adopting the SERVER's catalog version
// without blessing a stale editor snapshot.
//
// The editor sends its catalog version as base_catalog_version; the database
// refuses a structural save whose base is not current. If the editor simply
// copied whatever newer version a response carried, a tab that had missed an
// item added or removed elsewhere would acquire a "current" base for a stale
// item list — and its next structural save would silently delete or resurrect
// items. So a newer version is adopted only when this tab's own snapshot is
// provably current; otherwise the tab keeps its old base (the server will keep
// refusing structural saves) and is marked stale until it reloads.

export type VersionDecision = { version: number; stale: boolean };

/**
 * After an owner stock/tracking action.
 *
 * `before` is the version the server held when it authorized this action
 * (null for a replay); `after` is the current version after it.
 */
export function afterAction(local: number, before: number | null, after: number): VersionDecision {
  if (before !== null && before === local) return { version: after, stale: false };
  if (after === local) return { version: local, stale: false };
  return { version: local, stale: true };
}

/**
 * After a successful save.
 *
 * `structural` = this save added or removed items relative to the last saved
 * item list. A structural save only succeeds when its base was current, so the
 * new server version belongs to this snapshot. A non-structural save succeeds
 * even from a stale base: adopt only if nothing structural happened elsewhere.
 */
export function afterSave(sentBase: number, structural: boolean, serverVersion: number): VersionDecision {
  if (structural) return { version: serverVersion, stale: false };
  if (serverVersion === sentBase) return { version: sentBase, stale: false };
  return { version: sentBase, stale: true };
}

/** Did this save add or remove items relative to the last saved id set? */
export function isStructuralChange(savedIds: ReadonlySet<string>, currentIds: readonly string[]): boolean {
  if (currentIds.length !== savedIds.size) return true;
  return currentIds.some((id) => !savedIds.has(id));
}
