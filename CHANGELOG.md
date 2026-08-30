# Changelog

Notable changes per release. Written for someone deciding whether to upgrade,
so it says what changed for a user rather than listing every commit.

## Unreleased

**An agent that finishes while you are looking elsewhere now says so.**
`blocked` is the state this tool exists to deliver, and nothing produced it.
The extension listened to `agent_start` and `agent_end`; the event that means
"the agent is done and waiting on a human" is `agent_settled`, and murmur was
not subscribed to it. So the highest-attention state in the model was carried by
the picker, the status bar and the clear whitelist, and never arrived.

An agent that settles while its pane is unfocused now reports `blocked`, which
is exactly "it wants you and you are not looking". If you are already in the
pane there is nothing to request and nothing is written. Orchestrated crew
agents are unchanged: mu placed the work and mu consumes the result, so a
finishing worker is not a human's problem.

Expect the status bar to show attention where it previously showed nothing. That
is the fix working, not a new alarm.

**A second pi in an agent's pane no longer corrupts that agent's row.** Starting
a pi inside a pane that already had one — a nested run, a subagent, or just
`pi` typed by hand — made it report *as* the existing agent, because the pane id
is inherited and the extension is installed globally. One pane collected six
different reporting processes, of which one was alive, and the real agent read
as idle while it was working. Doubled `cleared` events came from the same cause:
two processes each correctly reporting once, about an agent only one of them
was.

Only a pane's own agent reports for it now. A nested pi writes nothing at all
rather than writing something wrong. This also affects anything that launches pi
from inside an agent, including test suites.

**A node whose database is wiped is no longer invisible to its peers.** Peers
track "everything after sequence N", and a node's identity deliberately survives
losing its event log — so a wiped node restarted counting at 1, a peer asked for
anything after 3, and was told there was nothing new. Blocked agents could sit
unseen indefinitely with no way to notice. Exports now carry an epoch
identifying which incarnation of the log the sequence numbers belong to, and a
peer that sees a new one re-reads from the start. Older peers that send no epoch
still work.

**`peer list` shows each peer's murmur version.** Two nodes can agree on the
wire format and still run different code with different behaviour, which was
previously invisible and is a thing worth seeing before debugging a
disagreement. A genuine wire incompatibility is now called out as such rather
than showing up as a peer that mysteriously reports nothing.

**`npm test` builds first.** Several tests execute the built output, so a stale
`dist/` could pass while testing code you had not written — it cost a maintainer
ten minutes on a failure that looked like a formatting bug and was a stale
build. Running vitest directly still works and now fails loudly instead of
quietly, with `test:only` as the escape hatch.

**Harnesses other than pi can ask for attention again.** `murmur notify` is the
path for codex and opencode, which have no in-process hook and can only run a
command when something happens. It replaces the `notify` subcommand of the
agent-attention script murmur superseded -- same flags, same stdin JSON form, so
the existing hook lines work with only the command name changed. Without it those
two harnesses never show `blocked`, and because the status bar keeps working for
pi agents the failure is invisible.

It is the one path where a process that does not own a pane may write about it,
and it is narrow by construction: it can only ever say `blocked`, and its row
carries no pid, so it makes no claim about any process being alive. working, done
and crashed stay the pane owner's alone.

Two fixes, both about telling two situations apart that used to look identical.

**Jumping to a remote agent no longer nests tmux in a way you can feel.** The
`ssh -t host tmux attach` used to run in a local tmux window, so the local
prefix and status bar stayed live on top of the remote's: `^b` went to the wrong
tmux and reaching the agent took `^b b`. It now runs in a local session of its
own with `status off` and `prefix None`, so the jump is full-screen and `^b`
goes straight to the remote. Leaving returns you to the exact window you jumped
from; a second jump to the same host reuses the one session.

While you are in that session the local tmux has no prefix and cannot be
reached. If you want a way out that does not involve the remote, the README
documents a one-line root-table binding.

**Three fixes for agents that stopped reporting.** Found by chasing the case
above, and each one silently dropped events while the tmux badge kept painting:

- **Concurrent agents lost events to database lock contention.** With eight
  agents appending at once, five failed outright. WAL allows one writer, and
  `append` reads the max sequence number before writing, so two appends at once
  failed the loser with `SQLITE_BUSY_SNAPSHOT` -- which no timeout can fix,
  because waiting cannot refresh a stale snapshot. Writes now take the lock up
  front. Eight concurrent writers: 5 failures before, 0 after.
- **One failed write silenced an agent for the rest of its life.** The
  extension cached "murmur is not installed, stop trying" and "that write
  failed, let go of the handle" as the same value, so a single transient failure
  -- one lock contention was enough -- stopped all further reporting until the
  agent was restarted.
- **Moving a pane between windows broke its agent.** tmux keeps the pane id and
  changes the window id, but the extension resolved its window once at startup.
  The badge was left on the window the agent had left, later events recorded the
  wrong window so jumps went to the wrong place, and closing the old window
  deleted the agent as dead.

**The picker's filter keys work, and `M-a` shows crew instead of clearing.**
`^b` was the filter for blocked and could never have worked: `C-b` is tmux's
default prefix, and tmux consumes the prefix before any pane, including the
popup the picker runs in. The filters are Alt chords now -- `M-b`, `M-w`, `M-d`,
`M-x` -- because murmur cannot know a user's prefix and any ctrl-letter is a
gamble. The safe ctrl spellings still work.

`M-a` was labelled "all" and cleared the filter, which collided with the `--all`
flag that shows orchestrated agents: pressing it emptied the query rather than
revealing the crew rows the header names two lines below. It now toggles crew in
and out of the list, and `^u` -- fzf's own binding, which always existed --
clears.

**Jumping to an agent whose pane has moved no longer deletes it.** Pressing
enter on a healthy agent could report `is gone -- its window no longer exists.
Cleared.` and remove it from the picker. The jump decided the agent was dead by
asking whether the WINDOW on its last event still existed, and a pane keeps its
id when it moves between windows while the window it left stops existing --
`move-pane` and `break-pane` do exactly that, and closing the old window is
enough. One keypress, on a working agent, with a message that said the opposite
of the truth.

Both halves now ask about the pane: locally through `list-panes`, and remotely
by probing the peer with `tmux list-panes -a -F '#{pane_id}'` instead of
`list-windows`. For a local agent this mattered more than for a replica, because
nothing brought it back: a deleted replica returns when its peer is next
collected, but a local agent has no peer to re-read and had to report again.

**Agents whose tmux window is gone clean themselves up.** A dead agent's final
`cleared` event was immortal: retention keeps the newest event per agent so a
long-idle agent does not vanish, and the dead-window sweep only ever converted a
LIVE row to `cleared` -- an already-cleared row had nothing to supersede, so it
was skipped. Two correct rules, and between them a row that nothing could
remove. Four crew rows on the author's machine had outlived their windows
indefinitely, and the only way to clear them was the manual `del` key.

The sweep now deletes those rows, and runs from `collect` rather than only from
`export` -- export happens when a peer asks over ssh, so a single-machine node
never swept at all. `blocked`, `done` and `crashed` on a dead window are still
superseded rather than deleted: those are facts a human has not seen, and
sweeping them away would hide the failures this tool exists to surface.

**Blocked and crashed crew agents are no longer hidden.** Orchestrated agents
are hidden by default because their supervisor consumes the result, but that was
applied to every state. An orchestrator cannot answer a question meant for a
human, and it may never retry a worker that died, so those two rows were the
ones a human needed and could not see -- hidden from the picker behind `--all`
and missing from the status-bar counts entirely.

**A sleeping node is no longer noisy.** The collector wrote two lines of ssh
diagnostics for every peer it could not reach -- the full ssh invocation plus
ssh's own message, over 200 characters -- and it runs from `murmur status` on
every tmux status-bar tick and from `murmur pick` inside a popup. One laptop
asleep meant stderr several times a minute, forever, and a corrupted popup.
Nodes being off or asleep is the normal state of a fleet, not a fault.

`status` and `pick` are now silent whatever the peers do. `murmur collect`,
which you run deliberately, prints one line per unreachable peer -- `linuxpc:
unreachable (Host is down)` rather than the whole ssh command line -- and exits
0, because a sleeping node is not a failure. A peer that is reachable but broken
still exits 1. `murmur collect --quiet` says nothing at all.

**`peer list` and `peer discover` are one command.** They answered two halves of
one question, and `discover`'s output was a bare `[x]` / `[ ]` per host with no
header, which never said what was being checked (a warm ssh control socket -- a
speed hint, not a requirement). `peer list` now shows each peer, what it calls
itself, when it was last seen, and whether its ssh connection is warm.
`peer list --all` adds the ssh hosts that are not peers yet, which is the
question `discover` existed to answer.

**Switching back to an agent's pane no longer wipes its state.** The tmux focus
hooks call `murmur clear`, which cleared whatever state it found -- including
`working`. So looking at a busy agent marked it idle. On the author's own agent
this hit 50 of 84 turns, several within seconds of the turn starting.

Focus now only cancels states that are asking for attention: `blocked`, `done`
and `crashed`. `working` is not a request, it is the agent saying what it is
doing, and only the agent can say it has stopped.

This is the bug behind most of the "agent reads idle while it is working"
symptoms in this release. The other fixes below are real, but this was the one
doing the damage day to day.

**`/reload` no longer kills reporting.** pi fires `session_shutdown` for
`/reload` -- and for session switch, resume and fork -- then rebinds and keeps
using the same extension instance. The extension treated that event as "the
process is exiting" and shut itself down permanently, so the first `/reload`
stopped all reporting for the life of the agent. Silently: events kept firing,
every one was dropped, and the tmux badge still painted, so the agent looked
fine while recording nothing.

It now follows pi's documented contract -- clean up in `session_shutdown`,
reestablish in `session_start`. A reload also re-arms an extension that had
given up because murmur was missing or the node had no identity, so installing
murmur or running `murmur init` and reloading now takes effect without
restarting the agent.

**Upgrading murmur now upgrades the pi extension.** `link pi` used to copy the
whole extension into `~/.pi/agent/extensions/`, which made it a snapshot of the
version that wrote it: upgrading murmur left the old extension running, with no
warning and nothing to compare against. This was not hypothetical -- the
author's machine was running an extension missing two committed fixes, which is
exactly the silently-wrong state report the extension exists to prevent.

The installed file is now a one-line re-export of the install, so `npm install
-g` is the whole upgrade. Re-run `link pi` only if the install path moves.
`link pi --copy` keeps the old inlining behaviour for an extension that must
survive murmur being moved or removed, and re-linking over an old copy says
what it replaced.

`link pi` also warns when the node has no identity. The extension deliberately
does not create one -- an agent should not decide what a machine is called --
but the consequence was invisible: it loaded, ran, and recorded nothing while
the tmux badge still painted.

A `live` / `exited` flag on idle rows was built during this work and then
removed before release. It answered `unknown` for every agent on a real
machine: the pid-age bound that kept it honest rejected the same old idle rows
it existed to describe, and `clearDeadWindows` already prunes agents whose
window is gone. The `clear` fix above removed the reason it seemed necessary.

Tests went 103 to 134, including a new file that drives a real tmux server on a
private socket: every other test fakes the multiplexer, so two malformed tmux
targets passed the whole suite. Every new test was verified by mutating the code
it covers. One new test was itself flaky (a timer standing in for a barrier) and
was rewritten to wait on an observable effect.

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
