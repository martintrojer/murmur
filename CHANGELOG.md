# Changelog

Notable changes per release. Written for someone deciding whether to upgrade,
so it says what changed for a user rather than listing every commit.

## Unreleased

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

**An idle agent now says whether it is still running.** `idle` covered both a pi
sitting between turns and a pane whose agent exited hours ago, and the picker
showed them identically — two live agents on the author's machine read as plain
idle for hours. Idle rows now carry a `live` or `exited` flag. Remote idle rows
show neither, because only an agent's own machine can check a pid.

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

An idle agent's `live` flag is also now bounded by pid age. Pids recycle in
about three hours on this machine, so a day-old pid was being reported as alive
when it may well have belonged to an unrelated process; past an hour the answer
is `unknown`.

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

Tests went 103 to 130, including a new file that drives a real tmux server on a
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
