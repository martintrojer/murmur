# Changelog

Notable changes per release. Written for someone deciding whether to upgrade,
so it says what changed for a user rather than listing every commit.

## Unreleased

**The longest wait now leads the list.** A request for a human starves: an
agent blocked forty minutes ago has been waiting forty minutes. One age rule
served every state, and it was newest-first, so that agent sat below one blocked
thirty seconds ago and sank further every time a newer request arrived — the
list you open to unblock things put the longest wait at the bottom. `crashed`
and `blocked` now sort oldest first. `done` still sorts newest first, because a
result is news rather than a wait.

**A row is aged by the fact it shows.** Attention requests now carry their own
timestamps, so a pane that crashed an hour ago and printed a `done` a second ago
is ranked as an hour-old crash rather than a one-second-old one.

**Rows nearer to hand rank sooner, within a state.** A pane wanting two kinds of
attention leads one wanting a single kind; the workstream you are sitting in
leads one you are not; a local pane leads an identical remote one. The pane your
cursor is already in drops to the bottom of its state, and a stale host's rows
fall below every fresh row — its fields are last-known and may be hours dead.

Nothing crosses a state boundary and nothing is configurable: a busy pane never
outranks a crashed one, and every signal above is already in the snapshot.

**A busy session channel is no longer mistaken for an auth wall.** Some hosts
cap session channels per connection (`MaxSessions 1`), so a collect that
overlaps another command on the same master is refused with `Session open
refused by peer`. ssh then retries on a fresh connection and dies at the auth
wall, so the error text ends in `Permission denied` — and murmur read that as
"a human must authenticate", parking a healthy peer behind a `re-auth needed`
notice that named a master which was already running. The two cases are now
classified apart and contention simply retries on the next tick.

This also corrects the reasoning published in 0.2.3, which claimed `-M` was the
remedy for `Session open refused by peer` because a plain `ssh` leaves a socket
that forwards but has never authenticated a session. That was wrong: the error
reproduces against a fully authenticated master built by the recommended
command. `ssh -MNf -S <ControlPath> <host>` is still the right thing to run, for
a different reason — OpenSSH defaults to `ControlMaster no` and `ControlPath
none`, so on a machine with no ssh_config of its own a bare `ssh` leaves no
socket where murmur looks.

**The suggested command no longer blocks the peer it unblocks.** It gained `-N`
(and `-f`): the old form opened an interactive shell, and on a host capping
sessions per connection that shell held the only slot, so following the picker's
advice left murmur unable to collect for as long as the terminal stayed open
— with the notice still up, naming the command that was doing the blocking.

**Eternal Terminal is now documented as the companion, not the exception.** On a
session-capped host, ET is the right place for your own work: it holds no ssh
session, so the capped slot stays free for murmur. The previous text framed ET
purely as something that cannot serve murmur, which is true and buries the
useful half.

## 0.2.3

Wire-compatible with 0.2.x: the snapshot format is unchanged at version 1, so a
0.2.3 node federates with 0.2.0 upward and no coordinated upgrade is needed.

The theme is peers that cannot be reached unattended, and a store that survives
being damaged. Both came out of running murmur against a devserver that demands
a second factor per connection — a case the design had named as out of scope and
never handled.

**A peer that needs an interactive login is skipped, not dialled and failed.**
Some hosts refuse an unattended connection — a second factor, a token, a
password — and murmur never prompts, so it cannot reach them alone. Such a peer
used to cost the full auth exchange to fail on every status tick and every
picker launch: measured at 1.5s per collect against a real one, now 0.23s for
the whole fleet. Its cached rows still list with their real age, so the agents
stay visible while the peer waits.

**The picker names it, so a lapsed session is not silent.** A header line, only
when it applies, in bold amber above the key legend: `dev: re-auth needed (last
seen 2h) — ssh -M -S ~/.ssh/control/%r@%h:%p dev`. The `-M` is the whole
remedy — a plain `ssh` leaves a socket that can forward but has never
authenticated a session, which `ssh -O check` reports as a healthy master right
up until a command over it fails. With a real master, collects cost ~10ms. `doctor` carries the
full list where the header trims to three. Note an Eternal Terminal session does
not work here — it bootstraps over ssh and exposes no socket to attach to.

**`doctor` separates three states it used to blur.** A peer contacted and never
once successful ("never answered") is usually a wrong target or a missing remote
install, and neither resolves by waiting — previously visible only as a blank
LAST SEEN column, indistinguishable from a switched-off box. A peer refused on
auth now gets one diagnosis naming the cause and the fix, instead of appearing
in three sections of the same report. Both are observations rather than
problems: they are correctly configured, not broken.

**A corrupt `state.db` no longer takes every command down with it.** A database
damaged past its header — a full disk, a killed write — made every murmur
invocation exit with a SQLite stack trace, including the status bar on every
tick and every tmux focus hook, and the only way out was deleting the file by
hand. The version-reset path already existed for a file murmur cannot use; it
just never ran for this case, because the check that decides answered "fine" for
any file it could not read. Nothing in the store is history, so it is rebuilt.

**Opening the store is safe when several processes do it at once.** A schema
bump used to race: after an upgrade the status-bar tick, every focus hook and
every pi extension reopen together, all saw a stale version, all tried to create
the schema, and the losers failed with `table agents already exists`. Worse, the
rebuild could delete the database another process was mid-way through writing,
which lost peer names and targets — the only rows in murmur that no collect can
re-derive, because a person typed them. Measured at 6 of 12 concurrent upgrades
losing a peer before the fix, 0 of 30 after.

**Enter in the picker lands on the agent's pane, not its window.** Selecting an
agent that shares a window with a shell put the cursor on whichever pane was
last active, which was often the shell. The same change fixes a jump to an agent
whose pane has moved between windows since it was recorded: that used to report
`could not attach` for a perfectly healthy agent.

**A remote jump lands on the agent's pane, and is no longer killed after ten
seconds.** Two separate faults on the same path. Jumping to a peer addressed the
recorded *window*, so you arrived at whichever pane that window last had active
— often a shell sitting beside the agent — and a pane that had moved windows
since the peer's last export failed outright while being perfectly alive. And
the outside-tmux ssh attach shared a timeout with murmur's bounded probes, so a
working remote session was terminated mid-use and reported as a failed attach.

**`murmur init --name ''` is refused instead of producing a node no peer will
accept.** An empty display name satisfied the writer and failed the snapshot
validator, so the node read as healthy locally while every peer that collected
it classed it reachable-but-broken — over a field the operator could not see was
wrong.

**The picker paints from cache and fetches behind it.** The popup no longer
waits on an ssh fan-out before showing anything — measured at 1.5s on a fleet
with one unreachable peer, against 0.06s now. The consequence is that the first
frame can be one refresh stale; `^r` forces a fetch, and rows carry `stale host`
and a `said` age so the staleness is visible rather than implied. A peer whose
last fetch failed is also no longer dialled for the preview, which cost ~1.5s
every time the cursor crossed that row.

**A peer the collect deadline never reached is reported as unknown, not
failed.** `peer list` and `status --json` used to show an error and a fresh
attempt timestamp for a host murmur had not contacted at all, which also
deferred the next attempt and suppressed that peer's preview.

## 0.2.2

**The picker's name column shows `murmur`, not `hacking/murmur`.** 0.2.1 fixed
*which* source a name comes from; this fixes how the session name is rendered
once it gets there. Session names are conventionally paths — that is how `tms`
and similar tools name them — and the last segment is the part that identifies
the work, so that is what the name column shows now.

That fallback is hit more often than it looks: an agent has no name from a richer
source unless mu set one or you ran pi's `/name`, because pi's own auto-namer runs
when a session closes. So a live hand-started pi — exactly the agent you are
looking at — fell through to the session name. The full path is not lost; it is
still in the stream column beside the name, so the row is strictly more
informative than before at the same width. Names you or mu chose are never
shortened.

**`murmur status` no longer reaches your peers on every status-bar repaint.**
Collection was driven by the tmux status bar — `status` collects, and tmux re-runs
it every `status-interval` — so fetch rate was tied to redraw rate. On a
four-peer node `murmur status` took 1.08s; it now takes 0.05s. If your status bar
felt sluggish, or you saw a lot of ssh processes on a machine doing nothing in
particular, that is this.

An ambient collect now skips a peer attempted in the last 30s (±10s of jitter, so
a fleet does not converge on hitting one machine at the same instant). Commands
you run yourself are unaffected: `murmur collect` fetches every peer, and so does
the picker, including its `^r` refresh. The visible trade is that a peer's data
can be up to ~40s old in the status bar rather than one tick old; the staleness
threshold is well above that, so a reachable peer still reads as fresh.

**New: `murmur doctor` reports what only a fleet-wide view can see.** Membership
is per node, so peering a machine does not mean it peers you — and if it does
not, its picker cannot see your agents. No local surface could tell you that,
because from your node everything reads healthy. `doctor` surveys each peer over
ssh and names it, along with duplicate hosts configured twice, snapshot-version
skew, one machine known under different names, and peers it could not survey at
all.

```
$ murmur doctor
Surveyed 4 peers, 4 answered.
5 observations, nothing broken.

One-way peering
  These do not peer this node, so their pickers cannot see its agents.
  bubba     does not peer mtrojer-mac
  gardenpc  does not peer mtrojer-mac

Do this
  ssh bubba murmur peer add mtrojer-mac
  ssh gardenpc murmur peer add mtrojer-mac
```

It is read-only — nothing is written to the store and there is no `--fix`, since
every repair runs on another machine. Repairs are printed for you to run. Exit
status is 0 for observations and 1 only for a real problem, so it is safe in a
script, and asymmetry is an observation: reachability is *meant* to be
one-directional in places, and a check that failed on the normal case would be a
check you learn to ignore. `--json` gives the finding list with machine-readable
severity.

Worth knowing before you act on its advice: the suggested commands name your node
by the name it calls itself, and that name may not resolve from the peer's side.
On the author's fleet none of them could resolve it, so each suggestion needed an
address the far host can reach.

**New: `murmur doctor --topology` computes which fleet shapes are actually
possible.** Opt-in, because it costs one ssh dial per ordered pair (4 peers is
20) where the survey costs one per peer.

```
$ murmur doctor --topology
Reachability  20 ordered pairs probed across 5 nodes
               REACHES                 CANNOT REACH
  mtrojer-mac  all 4                   -
  bubba        -                       mtrojer-mac gardenpc linuxpc macmini
  linuxpc      gardenpc macmini        mtrojer-mac bubba
  macmini      bubba gardenpc linuxpc  mtrojer-mac

Hub  linuxpc  serves {linuxpc, macmini}, leaves out mtrojer-mac, bubba, gardenpc
```

When no node can hub the fleet it recommends nothing and reports the partition,
which is the useful half — a hub half the fleet cannot reach is worse than no
hub. When one exists it prints the commands to build it, and states what a star
costs: spokes see the hub and the hub sees everyone, but spokes do not see each
other. A pair whose target was not demonstrably up is `unknown` rather than
unreachable, so a sleeping laptop is never reported as a firewall.

**The doctor report is tables, not prose.** Findings are grouped by kind with the
shared consequence stated once per group instead of once per row, and every
suggested command is collected under one deduplicated `Do this` block rather than
scattered through the text. The widest line went 129 columns to 78.

No upgrade coordination needed for any of this: the snapshot format is unchanged,
and `doctor` works against peers running 0.2.1. A peer too old for `peer list
--json` is reported as needing an upgrade rather than as broken.

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
