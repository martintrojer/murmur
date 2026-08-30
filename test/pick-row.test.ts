import { expect, test } from "vitest";
import {
  FILTER_ALIASES,
  FILTER_KEYS,
  headerRow,
  isPopup,
  isVisible,
  pickerRow,
} from "../src/cli/pick.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { tmux } from "../src/mux.js";
import type { PaneView } from "../src/view.js";

const base: PaneView = {
  host_id: "H",
  host: "bubba",
  local: false,
  pane: asPaneId("%1"),
  session: asSessionId("$0"),
  window: asWindowId("@6"),
  session_name: "dev",
  window_name: "editor",
  activity: "running",
  attention: ["blocked"],
  freshness: "fresh",
  agent_id: "agent-1",
  agent_name: null,
  pi_session: null,
  workstream: "ws",
  role: null,
  cli: "pi",
  driver: "human",
  updated_at: null,
  snapshot_at: null,
  fetched_at: null,
};

/** The visible label: the row minus its two hidden key columns and the escapes. */
function label(row: string): string {
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return (row.split("\t")[2] ?? "").replace(ansi, "");
}

test("the state word is in the searchable label, not a hidden column", () => {
  // Regression: state used to live in a hidden third column with `--nth`
  // scoping the search to it. fzf's --with-nth re-indexes fields, so ANY --nth
  // that excluded the label broke plain text matching — typing an agent name
  // returned 0/5 while the ctrl-key state filters worked. Both now match the
  // one field set.
  const row = pickerRow(base, true, false, false);
  // Two hidden key columns -- host and pane -- then the label. The pane is the
  // address that jumps; the host says whose pane it is.
  expect(row.split("\t")).toHaveLength(3);
  expect(label(row)).toContain("blocked");
  expect(label(row)).toContain("bubba");
});

test("the richest available name wins", () => {
  // mu names agents, pi names sessions, tmux names windows. All three travel
  // on the event so a remote row reads like a local one.
  expect(label(pickerRow(base, false, false))).toContain("editor");
  expect(label(pickerRow({ ...base, pi_session: "Fix the picker" }, false, false))).toContain(
    "Fix the picker",
  );
  expect(
    label(
      pickerRow({ ...base, pi_session: "Fix the picker", agent_name: "worker-1" }, false, false),
    ),
  ).toContain("worker-1");
});

test("columns stay aligned when the name carries colour escapes", () => {
  // Padding must count VISIBLE characters. The name is wrapped in bold+reset
  // (9 escape bytes), so padEnd on the coloured string pads 9 short and every
  // column after it shears. Compare a short name against a long one: the host
  // column must land in the same place, and at the width the label claims.
  const short = label(pickerRow({ ...base, window_name: "x" }, true, false, false));
  const long = label(pickerRow({ ...base, window_name: "a".repeat(20) }, true, false, false));
  expect(short.indexOf("bubba")).toBe(long.indexOf("bubba"));
  // And the position is the padded width, not the raw string length: glyph
  // column (4) + state (9) + name (31) + stream (14) + the arrow's two
  // columns.
  expect(short.indexOf("bubba")).toBe(60);
});

test("local and remote rows are distinguishable without knowing your hostname", () => {
  // Both hosts used to render as a dim hostname in one column, so reading the
  // list required knowing which machine you were on. The difference is not
  // cosmetic: a local row is a keystroke away, a remote one costs an ssh and a
  // nested tmux.
  const remote = label(pickerRow(base, true, false, false));
  const local = label(pickerRow(base, true, false, true));
  expect(remote).toContain("→ bubba");
  expect(local).toContain("here");
  expect(local).not.toContain("→");
});

test("here and the arrow start in the same column", () => {
  // The arrows should form one vertical run you can scan without reading a
  // word, which only works if both forms are indented alike.
  const remote = label(pickerRow(base, true, false, false));
  const local = label(pickerRow(base, true, false, true));
  expect(remote.indexOf("→")).toBe(local.indexOf("here") - 2);
});

test("the header lines up with the columns it names", () => {
  // Header and rows read one COLUMNS table, because they were literals in two
  // functions and had already drifted by a column. Assert the alignment rather
  // than the numbers, so the test survives a deliberate width change.
  const header = headerRow(true);
  const row = label(pickerRow(base, true, false, false));
  expect(header.indexOf("state")).toBe(row.indexOf("blocked"));
  expect(header.indexOf("stream")).toBe(row.indexOf("ws"));
  expect(header.indexOf("host")).toBe(row.indexOf("→"));
});

test("the header drops the host column when every agent is local", () => {
  expect(headerRow(false)).not.toContain("host");
  expect(headerRow(true)).toContain("host");
});

test("an over-long name is truncated so the grid stays aligned", () => {
  // pad() only ever grew a string, so a name wider than its column pushed every
  // column after it to the right and broke the grid for that row alone. Long pi
  // session names are the normal case: "Gchatui 2026 Rebaseline Finalization"
  // is 36 characters in a 30-wide column.
  const long = { ...base, window_name: "Gchatui 2026 Rebaseline Finalization" };
  const short = { ...base, window_name: "x" };
  const a = label(pickerRow(long, true, false, false));
  const b = label(pickerRow(short, true, false, false));
  expect(a.indexOf("→")).toBe(b.indexOf("→"));
  expect(a).toContain("…");
});

test("truncation never cuts inside an escape sequence", () => {
  // A cut mid-sequence leaks the colour into the rest of the line and loses the
  // reset that closes it, so the whole row after the cell renders bold.
  const row = pickerRow({ ...base, window_name: "y".repeat(60) }, true, false, false);
  const escapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  // Every escape byte in the row belongs to a complete, well-formed sequence.
  const escapeBytes = (row.match(escapePattern) ?? []).join("").length;
  const rawEscapeChars = [...row].filter((c) => c === String.fromCharCode(27)).length;
  expect(escapeBytes).toBeGreaterThan(0);
  expect((row.match(escapePattern) ?? []).length).toBe(rawEscapeChars);
});

test("currentWindow is null outside tmux, even when a server is running", () => {
  // The extension no-ops on a null location, so this is what keeps a pi started
  // outside tmux out of the log. Asking tmux directly does not work: on a
  // machine with a running server, `display-message` answers from any process
  // and names whichever pane the server thinks is active — so a bare ssh login
  // or a cron job would have recorded itself in an unrelated agent's pane and
  // overwritten that agent's state.
  const saved = process.env.TMUX_PANE;
  try {
    delete process.env.TMUX_PANE;
    expect(tmux.currentWindow()).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = saved;
  }
});

test("the session name fills the stream column when there is no workstream", () => {
  // Only mu-spawned agents have a workstream, so this column was empty for most
  // human agents — and the session name is what the tms picker shows and what
  // you search by. A session called `hacking/murmur` holding a pi whose window
  // is named `Python` was unfindable by typing `murmur`.
  const withStream = label(pickerRow(base, false, false, true));
  expect(withStream).toContain("ws");

  const noStream = { ...base, workstream: null, session_name: "hacking/murmur" };
  expect(label(pickerRow(noStream, false, false, true))).toContain("hacking/murmur");
});

test("an agent with neither leaves the column empty rather than printing null", () => {
  const neither = { ...base, workstream: null, session_name: null };
  const text = label(pickerRow(neither, false, false, true));
  expect(text).not.toContain("null");
  expect(text).not.toContain("undefined");
});

test("a popup is tmux without a pane", () => {
  // display-popup draws its own border, so fzf's is a second one just inside
  // it — and the popup is the normal way to run the picker, via prefix+a, so
  // the doubled frame was the common case. tmux exports TMUX to a popup but
  // not TMUX_PANE, since a popup is not a pane.
  expect(isPopup({ TMUX: "/tmp/tmux-501/default,123,0" })).toBe(true);
  expect(isPopup({ TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%1" })).toBe(false);
  expect(isPopup({})).toBe(false);
});

test("crew agents are hidden unless they need a human", () => {
  // `driver` exists to separate "an agent you are talking to" from "an agent an
  // orchestrator placed", and the picker hides the latter because its supervisor
  // consumes the result. Applied wholesale that was wrong in two cases: an
  // orchestrator cannot answer a question meant for a human, and it may never
  // retry a worker that died. Those rows needed a human and were the ones a
  // human could not see.
  //
  // The question is asked of ATTENTION now, not of a folded state, so a crew
  // agent that is busy AND blocked is visible -- which the old single-state
  // version could not express.
  const crew = (attention: PaneView["attention"]) =>
    isVisible({ ...base, driver: "orchestrated", attention });
  const human = (attention: PaneView["attention"]) =>
    isVisible({ ...base, driver: "human", attention });

  expect(crew(["blocked"])).toBe(true);
  expect(crew(["crashed"])).toBe(true);
  expect(crew(["done"])).toBe(false);
  expect(crew([])).toBe(false);
  // Busy and blocked at once: one fact does not hide the other.
  expect(
    isVisible({ ...base, driver: "orchestrated", activity: "running", attention: ["blocked"] }),
  ).toBe(true);

  // A human-driven pane is always visible, whatever it is doing.
  for (const attention of [["blocked"], ["crashed"], ["done"], []] as PaneView["attention"][]) {
    expect(human(attention)).toBe(true);
  }
});

test("the filter keys do not include a clear, which fzf already has", () => {
  // "all" meant two things and the wrong one was bound to M-a: clearing the
  // state filter, when the picker uses --all for the POPULATION -- the flag,
  // and the "crew hidden (--all)" notice. Pressing it emptied the query instead
  // of revealing the crew rows named two lines below, which read as broken.
  //
  // Clearing is fzf's own ctrl-u, a standard readline binding that needs no
  // --bind, so the redundant spelling cost the word for nothing.
  for (const [, query] of [...FILTER_KEYS, ...FILTER_ALIASES]) {
    expect(query).not.toBe("");
  }
});

test("no filter key can collide with tmux's default prefix", () => {
  // `ctrl-b` was the filter for `blocked` and could never fire: C-b is tmux's
  // DEFAULT prefix, and tmux consumes the prefix before delivering to any pane,
  // including the display-popup the picker runs in. So the filter reached for
  // most was dead on exactly the setup the README tells people to configure.
  //
  // The general rule this pins: murmur cannot know a user's prefix, so a single
  // ctrl-letter is always a gamble. The primary keys are alt chords, which are
  // not prefix candidates.
  for (const [key] of FILTER_KEYS) {
    expect(key.startsWith("alt-")).toBe(true);
  }
  for (const [key] of FILTER_ALIASES) {
    expect(key).not.toBe("ctrl-b");
  }
});
