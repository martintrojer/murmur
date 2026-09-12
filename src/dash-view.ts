import type { DashPrefs } from "./dash-prefs.js";
import { isVisible } from "./paint.js";
import { type PaneView, RENDER_PRIORITY, type RenderState, renderState, viewSort } from "./view.js";

/**
 * Which rows the dash paints, and in what order.
 *
 * Presentation only, and separate from `paint.ts` on purpose: `isVisible` is the
 * one rule every surface shares about crew rows, while everything here is the
 * dash reader's own preference, persisted in `dash.toml`. Folding the two
 * together would have made a toggle in one surface silently change the status
 * bar's counts.
 */

const ORDER = new Map<RenderState, number>(RENDER_PRIORITY.map((state, index) => [state, index]));

/**
 * Whether one row survives the reader's filters.
 *
 * Three independent gates, ANDed, and the first delegates rather than restates:
 * with `crew` off the answer is exactly `isVisible`, so the dash cannot disagree
 * with the picker about which orchestrated rows need a human. `crew` on widens
 * the list; it does not bypass the other two.
 *
 * `hidden_states` is keyed on `renderState`, the word the row actually paints,
 * not on `activity` -- a running pane marked `done` reads `done`, so hiding
 * `running` must leave it alone.
 */
export function dashVisible(agent: PaneView, prefs: DashPrefs): boolean {
  if (!prefs.crew && !isVisible(agent)) return false;
  if (prefs.hide_stale && agent.freshness === "stale") return false;
  return !prefs.hidden_states.includes(renderState(agent));
}

/**
 * The reader's chosen order. Never mutates the input.
 *
 * `priority` is `viewSort` verbatim -- the attention-first ordering every
 * surface uses -- and the other two exist because it is not always the question
 * being asked: `node` is "what is happening on that machine" with here first,
 * then remotes A-Z; `age` is "what moved most recently". Both stay TOTAL for
 * the same reason `viewSort` is, with `pane` as the final key: an unbroken tie
 * hands the position back to whatever order SQLite and the peer loop produced,
 * and a row that moves under a keypress is worse than any ordering.
 */
export function dashSort(views: PaneView[], prefs: DashPrefs, now = Date.now()): PaneView[] {
  if (prefs.sort === "node") {
    return [...views].sort((left, right) => {
      const byLocal = Number(right.local) - Number(left.local);
      if (byLocal !== 0) return byLocal;
      const byHost = left.host.localeCompare(right.host);
      if (byHost !== 0) return byHost;
      const byState = (ORDER.get(renderState(left)) ?? 99) - (ORDER.get(renderState(right)) ?? 99);
      return byState !== 0 ? byState : left.pane.localeCompare(right.pane);
    });
  }

  if (prefs.sort === "age") {
    return [...views].sort((left, right) => {
      // Null sorts last in both directions: a row that never said when is not
      // new, and reading it as 0 would have buried it under an epoch timestamp.
      if (left.updated_at === null || right.updated_at === null) {
        const byNull = Number(left.updated_at === null) - Number(right.updated_at === null);
        if (byNull !== 0) return byNull;
      } else if (left.updated_at !== right.updated_at) {
        return right.updated_at - left.updated_at;
      }
      return left.pane.localeCompare(right.pane);
    });
  }

  return viewSort(views, { now });
}

/** The dash's row list: the reader's filters, then the reader's order. */
export function dashRows(views: PaneView[], prefs: DashPrefs, now = Date.now()): PaneView[] {
  return dashSort(
    views.filter((view) => dashVisible(view, prefs)),
    prefs,
    now,
  );
}
