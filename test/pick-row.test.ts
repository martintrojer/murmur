import { expect, test } from "vitest";
import { agentLabel } from "../src/agents.js";
import {
  FILTER_ALIASES,
  FILTER_KEYS,
  headerRow,
  isPopup,
  isVisible,
  pickerRow,
  sessionNotice,
} from "../src/cli/pick.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { tmux } from "../src/mux.js";
import type { Status } from "../src/status.js";
import { type PaneView, RENDER_PRIORITY } from "../src/view.js";

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
  // The question is asked of ATTENTION, independently of activity, so a crew
  // agent that is busy AND blocked is visible.
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

test("a row shows activity and attention at once, and says when the host is stale", () => {
  // The three facts are independent, so a row that paints one word hides two of
  // them. A running agent waiting on a human is the normal case, and a stale
  // node keeps its last-known fields -- which is only honest if the row says
  // those fields are old.
  const text = label(pickerRow({ ...base, freshness: "stale" }, true, false, false));
  expect(text).toContain("blocked");
  expect(text).toContain("running");
  expect(text).toContain("stale host");

  // A fresh host says nothing about freshness: a flag on every row is furniture.
  expect(label(pickerRow(base, true, false, false))).not.toContain("stale");
});

test("every filter key queries a render state that rows actually contain", () => {
  // `alt-w working` outlived the word it searched for. The filters type an
  // exact-prefix query against the visible row, and the row prints a
  // RenderState, so a filter naming a state that no longer exists narrows the
  // list to nothing -- silently, and indistinguishably from "nothing is running".
  const states = new Set<string>(RENDER_PRIORITY);
  for (const [, query] of [...FILTER_KEYS, ...FILTER_ALIASES]) {
    expect(states).toContain(query);
  }

  // And a query really does appear in a row painted in that state.
  const row = label(pickerRow({ ...base, attention: [], activity: "running" }, false, false, true));
  expect(row).toContain("running");
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

test("a row never spends two columns saying one thing", () => {
  // Both the name and the stream column fall back to the tmux session name, so
  // an unnamed pi -- no mu agent name, no `/name`, and a window tmux is
  // auto-renaming -- printed `hacking/murmur   hacking/murmur` and spent
  // thirteen columns saying nothing new.
  const unnamed = {
    ...base,
    agent_name: null,
    pi_session: null,
    window_name: null,
    workstream: null,
    session_name: "hacking/murmur",
  };
  const row = label(pickerRow(unnamed, false, false));
  const first = row.indexOf("hacking/murmur");
  expect(first).toBeGreaterThan(-1);
  expect(row.indexOf("hacking/murmur", first + 1)).toBe(-1);
});

test("a stream that adds a fact is still shown", () => {
  // The dedup must not swallow a real workstream. mu's stream and the agent
  // name are different facts and routinely both present.
  const row = label(
    pickerRow({ ...base, agent_name: "worker-1", workstream: "murmur" }, false, false),
  );
  expect(row).toContain("worker-1");
  expect(row).toContain("murmur");
});

test("a session name reads as a name, not a path", () => {
  // The row reached here far more often than it looked. `agent_name` is set only
  // by mu, `window_name` is null whenever tmux is auto-renaming (its default),
  // and `pi_session` is null for the whole life of an unnamed session -- pi's
  // auto-namer runs at CLOSE, so a LIVE agent, which is the one you are looking
  // at, has no session name yet. The common row for a hand-started pi therefore
  // printed `hacking/murmur`: a path, where a name belongs.
  const unnamed = {
    ...base,
    agent_name: null,
    pi_session: null,
    window_name: null,
    workstream: null,
    session_name: "hacking/murmur",
  };
  const row = label(pickerRow(unnamed, false, false));
  expect(row).toContain("murmur");
  // And the row is strictly richer than before: the stream column is blanked
  // only when it would REPEAT the name, so shortening the name is what lets the
  // full path back in. Same width, more information.
  expect(row).toContain("hacking/murmur");
});

test("a name someone chose is never shortened", () => {
  // Only the session name is a path by convention. A window name that survives
  // to the label is one a human set -- `chosenWindowName` drops tmux's own --
  // and mu's agent names and pi's session names are deliberate too. Shortening
  // any of those would be presumptuous.
  const windowNamed = { ...base, agent_name: null, pi_session: null, window_name: "feat/api" };
  expect(label(pickerRow(windowNamed, false, false))).toContain("feat/api");

  const piNamed = { ...base, agent_name: null, pi_session: "fix/the picker" };
  expect(label(pickerRow(piNamed, false, false))).toContain("fix/the picker");

  const muNamed = { ...base, agent_name: "murmur/worker-1" };
  expect(label(pickerRow(muNamed, false, false))).toContain("murmur/worker-1");
});

test("the row and the preview name a pane identically", () => {
  // Three call sites used to spell out the same precedence chain: this row, the
  // preview header, and `agentLabel` itself. Harmless only while all three
  // agreed -- and they did not survive one change to the chain, since shortening
  // the session name in `agentLabel` left the row printing the full path.
  //
  // Asserted against `agentLabel` directly, so a future copy of the chain fails
  // here rather than being noticed in a screenshot.
  const cases: Partial<PaneView>[] = [
    { agent_name: null, pi_session: null, window_name: null, session_name: "hacking/murmur" },
    { agent_name: null, pi_session: null, window_name: "nvim" },
    { agent_name: null, pi_session: "Fix the picker" },
    { agent_name: "worker-1" },
  ];
  for (const over of cases) {
    const agent = { ...base, ...over };
    // The NAME CELL, not the whole row, and compared exactly. `toContain` cannot
    // do this job: "hacking/murmur" contains "murmur", so a row that printed the
    // unshortened path would satisfy it -- which is precisely the regression this
    // test exists to catch. Verified by mutation: with toContain, restoring the
    // duplicated chain kept the suite green.
    const header = headerRow(false);
    const start = header.indexOf("agent");
    const width = header.indexOf("stream") - start;
    const cell = label(pickerRow(agent, false, false))
      .slice(start, start + width)
      .trimEnd();
    expect(cell, JSON.stringify(over)).toBe(agentLabel(agent));
  }
});

/** A peer in the shape a lapsed interactive session leaves behind. */
function gated(name: string, fetchedAt: number | null): Status["peers"][number] {
  return {
    name,
    display_name: null,
    fetched_at: fetchedAt,
    snapshot_at: fetchedAt,
    last_error: "Permission denied (keyboard-interactive).",
    stale: true,
    needs_session: true,
  };
}

test("no notice when nothing needs a session", () => {
  // The line must be absent, not empty: an always-present header row would be
  // furniture in the common case, and the picker's header is already three lines
  // inside a popup 60% of the screen tall.
  expect(sessionNotice([])).toBeNull();
  expect(sessionNotice([{ ...gated("dev", 1_000), needs_session: false }])).toBeNull();
});

test("the notice names the peer, its age, and the exact command", () => {
  // Three facts the operator acts on: WHICH peer, HOW STALE the rows on screen
  // are, and the command that fixes it. The age is what answers "do I care right
  // now" without murmur inventing a staleness threshold.
  const notice = sessionNotice([gated("dev", 1_000)], 1_000 + 3_600_000);

  expect(notice).toContain("dev");
  expect(notice).toContain("1h");
  expect(notice).toContain("ssh dev");
});

test("a peer never reached reads as never, not as an age", () => {
  // `fetched_at` is null before the first successful collect, and "0m ago" would
  // be a lie about data that does not exist.
  const notice = sessionNotice([gated("dev", null)], 5_000);

  expect(notice).toContain("never");
});

test("several gated peers collapse into one line, oldest first", () => {
  // One line, because the header cannot afford one per peer. Oldest first
  // because that is the one whose rows are most likely to mislead.
  const notice = sessionNotice(
    [gated("bubba", 900_000), gated("dev", 1_000), gated("macmini", 500_000)],
    1_000_000,
  );

  // The exact joined list, not `/dev.*macmini.*bubba/`. That pattern passes on
  // an UNSORTED notice too, because the remedy at the tail repeats the first
  // name -- verified by mutation: deleting the sort kept the loose regex green.
  expect(notice).toContain("dev, macmini, bubba");
  expect(notice?.split("\n")).toHaveLength(1);
});

test("the peer list is trimmed rather than counted", () => {
  // Trimmed with no counter, per the spec: a truncated list plus "+3 more" is
  // more furniture than the header can afford, and `murmur doctor` carries the
  // full list for anyone who wants it.
  const many = Array.from({ length: 6 }, (_, index) => gated(`peer-${index}`, 1_000));

  const notice = sessionNotice(many, 5_000);

  expect(notice).not.toMatch(/\+\d|more|\(\d/);
  expect(notice?.length).toBeLessThan(120);
  // Trimmed, asserted by NAME. The length bound alone does not catch it: six
  // short fixture names fit inside 120 columns, so an untrimmed notice passed
  // it -- verified by mutation on `slice(0, NOTICE_PEERS)`.
  expect(notice).toContain("peer-2");
  expect(notice).not.toContain("peer-3");
});
