import type { PaneView } from "./view.js";

export function paneFingerprint(pane: PaneView): string {
  return JSON.stringify([
    pane.host_id,
    pane.pane,
    pane.updated_at,
    pane.activity,
    pane.attention.map(({ kind, message }) => [kind, message]),
    pane.freshness,
    pane.workstream,
  ]);
}

export function glanceNeedsRefresh(previous: string | null, next: string | null): boolean {
  return next !== null && next !== previous;
}
