# Changelog

Notable changes per release. Written for someone deciding whether to upgrade,
so it says what changed for a user rather than listing every commit.

## Unreleased

**The pane preview keeps its colours.** `murmur dash` and the `pick` preview
capture with `capture-pane -e`, locally and over ssh, so a previewed pane looks
the way it does on its own screen -- red failures, green diffs, inverse
selections, and the rest of the cell styling. Only SGR survives: cursor
movement, erases, window titles, clipboard writes, and image payloads are
stripped, and each line is reset at its boundary so a half-drawn progress bar
cannot bleed into the dashboard's own chrome. Card summaries and the `/` filter
stay plain text, so search and column widths are unaffected.

## 0.5.0

**Not wire-compatible with 0.4.x. Every node must be upgraded together.** The
snapshot format is now version 3. Every pane carries its tmux server identity,
so panes on private servers such as `tmux -L coop` are not confused with the
same pane id on the default server. Version 2 snapshots are rejected with the
expected and actual protocol versions rather than defaulting the missing server.

Peer jump templates now support `{attach}`, a shell-quoted complete tmux attach
command that includes `-L` or `-S` for private servers. Generated defaults
migrate automatically. Custom `{pane}` templates remain valid for the default
server and refuse private-server jumps with a pasteable migration command.
`murmur jump-command --host H --agent A` renders the exact cached attach command
without connecting, including hidden crew agents; `--json` returns its address.

coop 0.1.2 supplies crew metadata to its job shell by default, so a real pi
launched through coop appears as `coop-<job-id>` on server label `coop` and
survives export liveness. Use `coop run --human` for an ad-hoc agent.

**The dashboard handles larger fleets without becoming a wall of cards.** Press
`/` to filter by agent, workstream, session, host, or rendered state. The filter
is literal, transient, and never saved. Press `c` for persisted compact rows
that fit about five times as many agents, or `?` for the full shortcut panel.
The footer now shows only actions relevant to the current mode, including
`esc clear` for an active filter.

**Routine polling costs less.** Non-dashboard commands no longer load Ink, which
cuts measured `murmur --version` startup from 0.22s to 0.04s. Ambient collection
backs off unreachable peers to a five-minute cap while explicit collects still
retry immediately.

**The dashboard follows a replaced state database.** A schema rebuild can unlink
`state.db` while the dashboard is mounted. It now detects the replacement and
reopens it instead of remaining attached to a deleted inode.

## 0.4.4

Wire-compatible with 0.4.x: the snapshot format is unchanged at version 2.

**The dashboard now shows total crew size.** Its header includes the same
separate crew count as the tmux agent pill, even when healthy crew cards are
hidden. Urgent crew still appear in the crashed and blocked counts.

**Fixed: `PREFIX G` failed after a remote jump through zsh.** The destination
shell treated the indexed tmux hook name as a glob, discarded the marker setup,
and left `murmur dash --goto` unable to identify its client. The hook name is
now quoted across the remote shell boundary. Reusing an existing wrapper no
longer arms a hook that cannot fire and could mark a later unrelated login.

## 0.4.3

Wire-compatible with 0.4.x: the snapshot format is unchanged at version 2.

**The tmux status protocol now reports total crew size.** Attention-needing crew
remain in the crashed and blocked rollups, while a final `crew\t<count>` record
includes every orchestrated agent. The record is absent at zero. Consumers can
therefore show both what needs a human and how much supervised work exists.

**Every murmur surface now uses one state-glyph alphabet.** `status`, `pick`,
and `dash` share the stable `nf-fa-*` state map. The re-auth notice uses the
same blocked glyph, and dash uses the same preferred `nf-md-robot` as the tmux
agent-attention pill.

**Dashboard navigation is safer and easier to leave.** `murmur dash --goto`
returns to a running dashboard from local or remote agents, preserving terminal
state across jumps. Remote probe failures retain their real exit status, and
one dash cannot clear another dash's marker.

**Crew headers now match the visible dashboard.** When crew mode is enabled,
the header counts all visible crew states rather than retaining the default
attention-only totals.

## 0.4.2

Wire-compatible with 0.4.x: the snapshot format is unchanged at version 2.

**Fixed: `murmur dash` grew without bound and had to be restarted.** Reported at
2GB after five and a half hours of being left open, and reproduced at roughly
200MB an hour.

The retention is not murmur's own. It is native rather than JavaScript memory,
and it comes from the terminal UI library allocating a layout node per element
and freeing it on the next render -- work that is not returned to the operating
system. The same signature is reported against several other terminal agents
built on the same library.

What murmur controls is how much it asks of it, which is now considerably less.
The redraw tick is three seconds rather than one, since nothing on screen
needed a faster clock and peer data refreshes every thirty seconds anyway. The
pane glance is drawn as one block instead of one element per line. Glance and
card text is cut to the visible width before it is measured rather than when it
is painted.

The dash now settles at about 250MB and stays there; a ten-minute run moved 4MB
across its last seven minutes. This does not eliminate the underlying growth,
which is upstream, but it bounds it -- the practical difference being whether
you can leave the dashboard open all day.

## 0.4.1

Wire-compatible with 0.4.0: the snapshot format is unchanged at version 2, so no
coordinated upgrade is needed. Worth taking if you are on 0.4.0, because one of
these is a display bug you would eventually hit.

**Fixed: a line that merely mentions a pi status footer is no longer treated as
one.** The dashboard condenses pi's footer into `model · effort · context` for
an agent that does not report those fields itself. It recognised the footer by
searching anywhere in the line, so any output containing a percentage, a slash
and a model-shaped word read as a status footer -- a diff, a log line, or a test
assertion quoting one. The card then showed a plausible model name that no agent
was running. The match is now anchored: a real footer starts with its counters,
or with the percentage before the first turn.

Also fixed in the same area: a footer carrying a second parenthetical dropped
the condensing entirely and fell back to showing the raw token-counter line.

**Corrected documentation.** The README claimed murmur never reads pane output,
which is not true of the one fallback the dashboard still uses for agents that
report nothing. `ARCHITECTURE.md`'s snapshot example gave a version combination
no node can produce. Several code comments still described snapshot version 1
and an earlier, smaller field set.

**Internal.** The seven thinking levels were spelled out in four places -- the
type, the wire validator, the producer and the database constraint -- and now
come from one list, with a test that fails if a fifth spelling appears. Removed
a correlation helper that had had no caller since attachment detection changed.
Added the missing test for negative token and cost values, found by mutating the
validator and noticing nothing failed.

## 0.4.0

**Not wire-compatible with 0.3.x. Every node must be upgraded together.** The
snapshot format is now version 2, and murmur deliberately offers compatibility
in neither direction: a peer on a different version reads as reachable but
broken, naming the mismatch, rather than silently guessing at fields it does not
understand. Upgrade with `npm i -g @martintrojer/murmur` on every node, then
restart each agent so it re-reports.

**Agents report what they are running with, instead of murmur reading it off the
screen.** A pi agent now reports its model, provider, effort level, context
usage, token counts and cost, on the events that move each one — a model change,
an effort change, a completed turn. No polling.

The dashboard card shows `claude-opus-5 · medium · 11.7%`, and shows it for
**remote** agents as well as local ones, because the figures travel in the
snapshot the collector already fetches. No card runs a terminal capture to
display it. Agents without the extension keep the previous behaviour on the
selected card.

Token and cost figures are carried but not yet displayed anywhere. They are in
`murmur export` and `status --json` today, so a later display costs no
coordinated upgrade.

**Fixed: `peer list` would have called every correctly upgraded peer
incompatible.** The snapshot version existed as four separate literals, one of
them private to the peer-list renderer. It is now a single constant.

## 0.3.2

Wire-compatible with 0.3.x and 0.2.x: the snapshot format is unchanged at
version 1, so no coordinated upgrade is needed.

**Dashboard cards say which model is running, not how many tokens it spent.** A
pi status footer is the last line the pane prints, so it was always what the
card's one line showed — spent on token counters, cache-hit rate and spend. The
card now reads `claude-opus-5 · medium · 11.7%`: model, effort, and how full the
context is. Output that is not a pi footer is shown unchanged.

**The dashboard no longer mis-renders on pane output containing tabs.** A tab is
one character and up to eight columns, and the width check scored it as two — so
a line measured as fitting the glance box overflowed, wrapped, and pushed every
row below it down. Common in `git status` and `make` output. Tabs are now
expanded to the terminal's own 8-column stops, which keeps table-shaped output
aligned.

**The dashboard header ticks on a machine with no peers.** The age field was
derived from peer fetches alone, so an unconfigured peer list showed a constant
`local` and the dashboard looked frozen. It now reports how long ago its own
refresh completed.

## 0.3.1

Wire-compatible with 0.3.0 and 0.2.x: the snapshot format is unchanged at
version 1, so no coordinated upgrade is needed.

**Talk to local and remote agents without leaving `murmur dash`.** Press `i` to
open a one-line composer for the selected pane. Enter sends the whole prompt
through tmux locally or over the existing SSH connection remotely, then keeps
input mode open for follow-ups. `ctrl-e` sends Escape to stop the agent, and
escape returns to dashboard controls.

The selected pane stays locked while you type. Input mode uses a colored double
border and banner, reports delivery errors in place, and refreshes the pane
glance after input. Prompt text travels through stdin and a tmux buffer rather
than command arguments. The dashboard window title now reads `murmur` instead
of `node`.

**Dashboard activity is easier to scan.** Running agents now use a play glyph;
the moon remains the idle glyph.

## 0.3.0

Wire-compatible with 0.2.x: the snapshot format is unchanged at version 1, so
no coordinated upgrade is needed.

The theme is a live dashboard you can stay in, not only a popup jump list.

**`murmur dash` — cards + pane glance.** An ink TUI over the same view `status`
and `pick` already share: attention-sorted cards on the left, live
`capture-pane` glance on the right. Floored collect while it stays open; paints
from cache like pick. Needs a Nerd Font and a Catppuccin Mocha terminal.

Keys: `j`/`k` select, enter jump, `s` cycles sort (`priority` / `node` /
`age`), click selects, double-click jumps, wheel scrolls the card rail or the
glance, `q` quits. **node** sort is local cards first, then remotes A–Z.
Presentation prefs (sort, filters) persist across runs.

**`murmur pick` is jump-first again.** The popup is a narrow list: enter jumps,
typing narrows, `ctrl-a` / `--all` toggles crew. Dash owns the richer browse.

**Docs.** README is sell/usage with a dash screenshot; harness hooks, doctor,
and jump detail live in `docs/setup.md`. AGENTS points at the doc map.

## 0.2.6

Wire-compatible with 0.2.x: the snapshot format is unchanged at version 1, so
no coordinated upgrade is needed.

**Ambient collects no longer trigger a hardware-token prompt.** On a host whose
ssh config routes through a site wrapper (`ProxyCommand x2ssh ...`), every
collect that could not ride a warm master spawned that wrapper, which asks for
a Yubikey tap on whatever terminal it can find. `BatchMode=yes` does not
prevent this: it suppresses ssh's *own* prompts, and a ProxyCommand is a
separate program with its own terminal. Since tmux re-runs `murmur status` on
every `status-interval`, per attached client, the prompt recurred rather than
happening once.

`SSH_OPTIONS` now passes `ProxyCommand=none`, which is safe for the same reason
`ControlMaster=no` is: murmur only ever multiplexes over an existing master, so
the socket is already connected and no proxy is needed to reach the host.

One consequence worth knowing: a peer whose hostname resolves *only* through
the proxy is now unreachable when its master is down, and reports a DNS failure
instead of prompting. Open the master yourself — `ssh -MNf -S
~/.ssh/control/%r@%h:%p <host>` — which is where a 2FA tap belongs: once per
`ControlPersist` window, deliberately, with a terminal attached.

## 0.2.5

Wire-compatible with 0.2.x: the snapshot format is unchanged at version 1, so a
0.2.5 node federates with 0.2.0 upward and no coordinated upgrade is needed.

**Your local agent rows are discarded on first run, and murmur now tells you.**
The schema version moved 3 → 4, which rebuilds `state.db` keeping only peers —
documented behaviour, but previously silent, and silence made a routine upgrade
look like data loss. Agents already running claimed into the old file and cannot
re-claim until their extension reloads, so they stay invisible until you press
`/new` in each pane. Nothing else is affected: peers, their targets and their
identities survive, and the next collect refills everything remote.

The theme is the remote worker — seeing one, reaching one, and not being lied to
about either.

**Cursor CLI can notify on turn end.** A `stop` hook that pipes its stdin to
`murmur notify --source cursor` records `done` when `status` is `completed` and
`blocked` for `aborted`/`error` — attention only, same tier as codex.

**Reaching a host that caps ssh sessions.** A peer now carries a jump command
alongside its target: `murmur peer set dev --jump-command 'et dev -c "tmux
attach -t {pane}"'`. murmur substitutes `{pane}` and runs the rest unparsed, so
the value can be a site wrapper with its own flags; the default reproduces
today's `ssh -t <target> tmux attach`. On a host with `MaxSessions 1` this is the
difference between a jump that blocks your own collector and one that costs
nothing.

**"Permission denied (keyboard-interactive)" now names the real cause.** On a
capped host, an interactive attach holds the only session channel, so the collect
that would show you the agent is blocked by the pane you opened to look at it —
and ssh reports it as an auth failure. `collect` and `peer list` now say
`ssh session limit reached -- pane %210 is your own attachment to this peer`,
found by matching a local pane against that peer's own jump command.

**A remote worker shows where it is already attached.** A row whose agent you
have open locally reads `attached here %N`, and enter focuses that pane instead
of opening a second connection — which on a capped host fails outright.

**Peer names no longer collide or wedge.** A name containing `:` produced an
unaddressable wrapper session, so the jump failed *and* left an orphan that every
later jump reused and failed on identically — permanent until killed by hand. The
whole name is now sanitised, and the wrapper is identified by the host it reaches
rather than the label you typed, so two peers whose names differ only in
punctuation no longer share one.

**A reused wrapper goes to the pane you picked.** Jumping to a second agent on a
host you already had open switched to the first one's pane and reported success.

**A peer that answers with nonsense says so.** `peer add` reported "identity
pending" — the right words for a sleeping laptop, a lie for a reachable host
serving a document murmur rejected. The reason is now printed and recorded, so
`peer list` and `doctor` agree without a second probe.

**A cached snapshot is validated, not just parsed.** A stored document that was
valid JSON of the wrong shape reached readers and could crash them mid-render.

Smaller: the window badge is recomputed rather than asserted, so a notification
on one pane can no longer erase a crashed agent's glyph in the same window, and
acknowledging a pane no longer clears a badge when the store cannot be read;
`@pane_agent` is retracted with the badge that set it; a whole-run collect
failure no longer prints `murmur: : ...`; and attachment detection reads process
arguments without the environment, which it had been pulling in wholesale.

## 0.2.4

Wire-compatible with 0.2.x: the snapshot format is unchanged at version 1, so a
0.2.4 node federates with 0.2.0 upward and no coordinated upgrade is needed.

The theme is what the picker tells you to look at first. Two of the three items
below are the same bug from opposite ends — murmur knew which agents wanted a
human and ordered them by the wrong clock, and for codex it had the wrong verb
entirely.

**If you use codex, update your notify hook.** The line this README documented
until now wraps murmur in `sh -lc`, which swallows the event payload, so murmur
cannot see which event fired:

```toml
# ~/.codex/config.toml
notify = ["murmur", "notify", "--source", "codex"]
```

Use an absolute path if `murmur` is not on the PATH your launcher gives the
hook, and drop `--title Codex` if you have it. The old line still records rows;
it just cannot tell a finished turn from a stuck one.

**A finished codex turn is `done`, not `blocked`.** `murmur notify` recorded
`blocked` on every call, and codex's notify hook fires exactly one event —
`agent-turn-complete`, meaning the turn ended and the agent is waiting for you.
So every completed codex turn asked for help: indistinguishable from an agent
genuinely stuck, and pinned to the top of the picker once `blocked` began
sorting oldest-first. The kind now comes from the event type the harness
reports. An event murmur does not recognise is still `blocked`, which is the
direction that cannot lose information.

**The codex payload is no longer discarded.** Codex appends the event JSON as a
trailing argv token with stdin set to null; murmur only read stdin. Two
consequences, both fixed: the event type never arrived, and every row's message
was whatever `--title` said instead of what the agent did. Rows now carry
`last-assistant-message`.

Why the wrapper matters, since it is the part that looks like it should be
harmless: `sh -lc '<script>' <arg>` assigns that argument to `$0`, not `$1`, so
the shell consumed the JSON and murmur was never passed it. The README has both
the direct form and a correct wrapped one if you need a login shell for PATH.

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
