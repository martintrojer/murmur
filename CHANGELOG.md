# Changelog

Notable changes per release. Written for someone deciding whether to upgrade,
so it says what changed for a user rather than listing every commit.

## 0.2.1

**Agents are named by their tmux session, not by whatever process tmux found
running in the window.** The picker's `agent` column showed `Python`, `node` and
`zsh` for real agents — pi's own interpreter, labelled "agent".

tmux's `automatic-rename` is on by default, which makes a window name simply the
foreground command, and murmur preferred that name over the session name. So any
agent without a mu agent name or a pi `/name` was listed under a process name,
and `hacking/murmur` — the string you actually search for — was hidden. A window
name is now recorded only when someone chose it, which means a window you renamed
yourself still wins, as does mu's own naming.

A row also no longer prints one string twice: the name and the stream column both
fell back to the session name, so an unnamed agent read `hacking/murmur
hacking/murmur` and spent thirteen columns saying nothing new.

Upgrading does not retroactively fix agents that are already running. The name is
recorded by the pane's own owner, so each agent's row is corrected when its pi
process next starts. A pi `/reload` is not enough — it re-runs the extension
inside the same process, which has the old code cached.

## 0.2.0

**murmur now stores current state instead of an event log, and every node
publishes one complete snapshot of it.** This is a rewrite of the model, and it
is not compatible with 0.1.4 or anything before it. Upgrade every node together.

The old design appended events and folded them into a state per agent at read
time. It was the right shape for a tool that needed history, and murmur never
did: nothing replays events, the picker's preview is a live `capture-pane`, and
the only question anyone asks is "what is happening right now". The fold paid
for that flexibility in bugs, and they were not small ones.

What replaces it is three independent facts, each with exactly one writer:

- **activity** -- is a process working in this pane. Written only by that
  process.
- **attention** -- does someone need to look at this pane: `done`, `blocked` or
  `crashed`. Written by the owner, by an external notifier, or by local
  reconciliation, and addressed by pane rather than by agent.
- **freshness** -- how recently we reached the node that reported. Known only by
  the reader.

They are never collapsed into one value, and that is the fix for the worst bug
this project has had. `murmur notify` followed by a tmux focus hook used to
replace a running agent's state with `blocked` and then null its name, workstream
and driver -- on three live panes, with all three processes running. It happened
because everything was one enum in one table, so an attention writer could
overwrite an agent's state simply by writing the row it was allowed to write.
Attention now lives in its own table with no column an agent field could go in.
It is not that murmur checks; it is that there is nothing to check.

**A second agent in one pane is refused by the database, not by an environment
variable.** A pane holds at most one instrumented agent, enforced by a `UNIQUE`
constraint plus one liveness probe. A nested pi -- a subagent, or `pi` typed by
hand inside an agent's pane -- registers no handlers, writes nothing and paints
no badge. The previous mechanism passed a marker through the environment, which a
process launched in an unusual way could drop.

**Focus can no longer damage an agent.** `murmur clear` is one delete against the
attention table. The whitelist of clearable states, the "is this agent still
working" lookup and the metadata copy-forward are all gone, along with the
possibility of getting any of them wrong.

**A peer's whole state is replaced in one write, or not at all.** `murmur export`
takes no options and prints one JSON document describing every pane on that node.
A collect is one ssh round trip per peer, and the answer either replaces that
peer's cache entirely or leaves it untouched. Watermarks, epochs, `--since`, the
refetch-from-zero path and the wipe-detection machinery are all deleted -- none
of them are needed once a document is complete, because absence from it means
absence. A wiped node is no longer invisible to its peers for the same reason,
with nothing added to detect the wipe.

**A snapshot that does not validate is rejected before it is stored**, and the
peer is reported as reachable-but-broken with the reason on it, rather than
silently stale. That includes a version mismatch: fields are no longer carried
through unrecognised, because a reader that guesses about state a human acts on
is worse than one that says it cannot read the answer. `murmur peer list` shows
each peer's version so a bad pairing is visible before you debug it.

**A jump that fails changes nothing.** Pressing enter on a pane that has gone
away reports it and leaves every row alone. Only the node that owns a pane
retires it, on its next reconciliation. The picker's delete key is gone with the
per-agent replica rows it evicted, and its history preview is gone with the
history.

Breaking changes, in the order you will hit them:

- **`state.db` replaces `events.db`.** The old file is not migrated and is
  deleted on first open. Peer names and targets survive; nothing else does.
- **`murmur export --since N` is gone.** The command takes no options.
- **`murmur status --json` has a new shape:** `{counts, orchestrated_counts,
  panes, peers}`, where `counts` is keyed by the word a surface paints
  (`crashed`, `blocked`, `done`, `running`, `idle`) and `panes` is a list of
  panes rather than agents. `murmur status` without `--json` is unchanged.
- **Old and new nodes cannot federate.** An older peer serves the event format,
  which this version rejects as an invalid document. It shows up as broken, with
  a message saying so.
- **The SDK surface changed with the model.** The store's log methods, the fold
  module and the wire envelope types are gone; `Store`, `Snapshot`, `PaneView`
  and the pure `parseSnapshot` / `paneViews` / `renderState` replace them.

What this costs, stated so it is design rather than surprise: there is no history
of any kind, no incremental sync (each collect transfers a whole snapshot, which
is bounded by live pane count), no nested agents, and no inference about whether
a remote process is alive -- a remote pane's activity is whatever its own node
last said, and a stale node keeps its last-known values beside a warning.
ARCHITECTURE.md lists all eight accepted limitations.

Tests went 134 to 239 across 28 files, and they changed character with the model:
the ones that matter now assert what is *impossible* -- a notifier cannot touch
an agent row, a focus hook cannot change activity, no read path carries a pid --
several of them structurally, over the whole returned object graph rather than by
reading a type. Every new test was verified by breaking the code it covers. Test
processes are also now guaranteed not to touch the developer's own state, which
is not hypothetical: writing the contract for this rewrite corrupted the author's
live state three separate times, through the very bug being fixed.

## 0.1.4

A review pass over the peer-collection code, and the bugs it found.

Collection is driven by tmux re-running `murmur status` on a tick, and the peer
loop was serial: every peer paid the ssh timeout of every peer ahead of it, so
three sleeping laptops froze the status bar for thirty seconds. Peers are now
fetched concurrently, with a bound on the whole collect rather than only on each
peer.

Fixed, each with a symptom you could have hit:

- **A large peer could never sync.** The ssh export ran into Node's default
  1 MiB output limit, about 2,600 events. Past that the collect failed, and it
  failed permanently: the watermark only advances on success, so every retry
  re-requested the same oversized range. A reachable peer sat stale forever.
- **Jumping to an agent claimed success even when it failed.** A failed
  new-window, ssh attach, or select-window all reported success, so the picker
  closed and nothing moved, with no message. Jump now reports the failure.
- **A recovered host could stay marked "no tmux".** The recovery check counted
  database inserts, which read zero on a retry after a partial write, so the
  host stayed marked dead until it happened to author a new event.
- **The pi extension leaked a database handle per failed write**, inside a
  process that can run for days.
- **ssh timeouts are sized to the status-bar tick** and deliberately
  aggressive. A slow node is now rejected rather than allowed to hold up the
  HUD; it shows stale until the next tick.
- **Retention ran only when peers were configured.** A single-machine node
  never pruned, so its event log grew without bound.

Internal, no behaviour change: one shared ssh option list instead of three
hand-rolled copies, `clear`'s queries moved behind `Store`, and `STALENESS_MS`
states its value instead of deriving it from a collect interval nothing
enforced.

Tests went 83 to 103. Four existing tests could not fail and were rewritten;
every new test was verified by breaking the code it covers.

## 0.1.3

Both fixes are about the peer columns being unreadable.

- `peer list` printed tab-separated fields with no header. Now a header and
  aligned columns.
- `murmur pick` showed the node's self-reported hostname, which can be a
  container id -- a string that appears nowhere else and cannot be typed at
  `peer remove`. It now shows the peer name you configured.

## 0.1.2

- **The picker had a doubled border inside a tmux popup.** `display-popup` draws
  its own, so fzf's sat one character inside it. The popup is the normal way to
  run the picker, so this was the common case.
- **Documented the focus-clear hooks**, which have to be wired by hand per node.
  Without them a finished agent stays marked `done` forever and the picker fills
  with rows that need nothing.

## 0.1.1

- A stale badge is now reconciled, and a shell pane no longer clears the badge
  of the agent pane next to it.
- Agents are searchable by tmux session, and typing matches substrings rather
  than scattered characters.
- The delete key drops a stuck row from the picker.
- `--version` reads the manifest instead of a hardcoded string.
- Only `$TMUX_PANE` decides whether we are inside tmux.

## 0.1.0

First release. Agent state across every machine you work on, in one view.
