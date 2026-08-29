# Changelog

Notable changes per release. Written for someone deciding whether to upgrade,
so it says what changed for a user rather than listing every commit.

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
