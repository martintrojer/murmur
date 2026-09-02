# murmur

**Every coding agent you have running, on every machine, in one list.**

You have agents on your laptop, your desktop, and a box somewhere else. One is
blocked waiting on you. Which one?

Without murmur you walk the machines to find out. murmur answers in one
keystroke and jumps you to the agent, wherever it is running.

```
    state    agent                          stream        host           age / flags
  ! blocked  review the auth change         api           → devbox       4m
  ▶ running  Fix the picker filter          murmur          here
  ✓ done     migrate the fixtures           api           → devbox       12m
```

That is captured from `headerRow` and `pickerRow` rather than typed by hand, so
the column names are the ones the code prints. An idle `crew` row is deliberately
absent: orchestrated agents are hidden unless they are `blocked` or `crashed`,
since their supervisor consumes anything else. `M-a` or `--all` reveals them.

Pick a row, press enter. Local agents are a window switch; remote ones open over
ssh. The preview shows the last lines the agent printed, so you can tell "waiting
on me" from "still thinking" without going there.

## What it is

- **A state layer over tmux.** tmux owns your panes; murmur owns the answer to
  "what is every agent doing right now".
- **Reported state, not scraped.** A pi extension reports from inside the agent,
  so a crash is detected from a pid rather than guessed from output.
- **Current state only.** Each node publishes one complete snapshot. No history
  and nothing to replay, which is why a peer's answer is replaced in one write
  and absence means absence.
- **No daemon, no socket, no master.** Peers are pulled over ssh when you run a
  command. Every node aggregates; none is special.
- **Fast with one machine.** ~50 ms to first paint. Zero peers is the common
  case and nothing about it is degraded.

## What it is not

- **Not an orchestrator.** It observes and connects, never places work. That is
  [`mu`](https://github.com/martintrojer/mu)'s job.
- **Not a remote terminal.** Glance at a pane or jump to it; there is no frame
  streaming or resize negotiation. That deferral is most of why murmur is small.
- **Not a multiplexer.** tmux stays. See
  [ARCHITECTURE.md](ARCHITECTURE.md#why-not-something-else) for how murmur
  relates to adjacent tools.

## Requirements

tmux, [pi](https://github.com/earendil-works/pi-coding-agent), `fzf`, and Node
20+. For more than one machine: ssh access, and murmur installed on each.

**Agents must run inside tmux**, on every machine. A tmux pane is how murmur
addresses an agent, so a pi started in a plain terminal records nothing and
never appears in the picker. That is deliberate: there would be no way to jump
to it. Remote agents need tmux on the remote too, since the jump is
`ssh -t <host> tmux attach`.

## Install

On every node that runs agents:

```bash
npm install -g @martintrojer/murmur
murmur init      # this node's identity
murmur link pi   # install the agent-side extension
```

`link pi` writes a one-line extension into `~/.pi/agent/extensions/` that
re-exports this installation, so `npm install -g` is the whole upgrade and
there is nothing to re-run. Running agents keep the old code until they
restart, which is true of any extension change.

Re-run `link pi` only if the install path itself moves. `link pi --copy`
inlines the extension instead, which pins it to the version that wrote it and
does need re-linking after every upgrade — use it only if the extension has to
keep working when the murmur install is gone.

Order matters: without `murmur init` the extension loads and records nothing,
because a node with no identity has nothing to publish state as. `link pi` says
so if you skip it.

Also on every node, in `.tmux.conf`, so a finished agent stops asking for
attention once you look at it:

```tmux
set-hook -g after-select-pane      "run-shell -b 'murmur clear --pane #{pane_id}'"
set-hook -g after-select-window    "run-shell -b 'murmur clear --pane #{pane_id}'"
set-hook -g client-session-changed "run-shell -b 'murmur clear --pane #{pane_id}'"
```

These are per node and not optional. `murmur clear` is the only thing that
acknowledges an attention request, and a node's own snapshot is what every peer
reads — so a node without these hooks leaves its finished agents marked `done` in
*every* peer's picker, not only its own status bar. Verify with `tmux show-hooks
-g`: `set-hook` accepts a hook name your tmux does not have and exits 0, so a
wrong name fails silently.

Focus can only ever cancel a request for attention. It cannot stop a running
agent or alter anything the agent reported about itself, so there is no way to
wire these hooks such that looking at a pane damages the agent in it.

The pane id is passed explicitly because hooks run in the tmux server, where
`$TMUX_PANE` is unset, and because the badge belongs to the window while "you
looked at it" is true of one pane. Without it, a window holding an agent and a
shell clears when you focus the shell.

### Harnesses other than pi

pi reports from inside itself, through the extension. codex and opencode have no
such hook -- they can only run a command when something happens -- so they use
`murmur notify`, which records an attention request for the pane it runs in:

```toml
# ~/.codex/config.toml
notify = ["/bin/sh", "-lc", "murmur notify --source codex --event-type notify --title Codex"]
```

The same four fields may arrive as a JSON object on stdin instead, which is
opencode's plugin form; flags win over the payload, so the line above behaves
identically either way.

**A hook is not an interactive shell, so check that `murmur` resolves in it.**
A notify hook inherits the PATH of whatever launched the harness, and `sh -l`
does not fix that -- `/bin/sh` is not your login shell and does not read your
zsh profile. A harness started from a terminal inherits a PATH with your npm
prefix on it and works; one started by a launcher, a daemon or a GUI may not,
and the failure is silent because a notify hook's output goes nowhere. Verify
from inside the harness, not from your terminal:

```bash
murmur notify --source probe --message reachable && murmur status
# then undo it, or the pane stays badged:
murmur clear --pane "$TMUX_PANE"
```

The probe is a real attention request: it records `blocked` and badges the
window, which is what makes it a genuine test of the path. `murmur clear` is
what takes it back, and focusing the pane does the same if you have the hooks
above installed.

If `murmur` is not reachable there, give the hook the absolute path
(`command -v murmur` from your shell) rather than relying on PATH.

`notify` is the one path where a process that does not own a pane may write
about it, and it is narrow by construction rather than by convention: an
attention request has no field for an agent id, a pid, an activity or any owner
metadata, so it cannot make a claim about a process even by mistake. It says
`blocked` and nothing else; running, done and crashed stay the pane owner's and
murmur's own reconciliation's. Outside tmux it records nothing and exits 0, so it
cannot break the caller's own exit code.

A pane reached only this way — a codex agent murmur never instrumented — is a
full row in the list: it shows up, it is filterable, and enter jumps to it.

Then, on whichever machine you want to watch from, add the peers and bind the
picker to a key:

```bash
murmur peer list         # your peers, and when each was last seen
murmur peer list --all   # also ssh hosts that could become peers
murmur peer add devbox   # an ssh target; identity is discovered
murmur doctor            # survey each peer over ssh: what only a fleet view shows
murmur doctor --topology # also probe who can reach whom, and compute hub options
```

`peer list` reads local state: what you configured, and when you last heard from
it. `doctor` dials out and asks each peer about *itself* — the only way to see
what no local surface can: **membership is per node, so peering a machine does
not mean it peers you.** If it does not, its picker cannot see your agents.

`doctor` writes nothing and repairs nothing; it prints the commands. Exit 0 for
observations, 1 only for a real problem, so it is safe in a script.

```
$ murmur doctor
Surveyed 4 peers, 4 answered.
5 observations, nothing broken.

Not visible to the fleet
  mtrojer-mac  none of the 4 surveyed peers can see this node

One-way peering
  These do not peer this node, so their pickers cannot see its agents.
  bubba     does not peer mtrojer-mac
  gardenpc  does not peer mtrojer-mac

Do this
  ssh bubba murmur peer add mtrojer-mac
  ssh gardenpc murmur peer add mtrojer-mac
```

Suggestions name this node as it calls itself, and that name may not resolve from
the peer's side — hence "check", not "run for you". `peer add` accepts a target
that does not answer yet and discovers identity on the first collect, so trying
costs nothing.

`--topology` is opt-in: it costs one dial per ordered pair (4 peers is 20) where
the survey costs one per peer. Plain `doctor` answers "is my fleet mutual?";
`--topology` answers "what shapes are possible here?", which you ask once while
setting up.

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

Which node *can* hub is arithmetic on that matrix, not a preference. When none
qualifies, nothing is recommended and the partition is reported — a hub half the
fleet cannot reach is worse than no hub. A pair whose target was not
demonstrably up reads `unknown`, not unreachable: a sleeping laptop and a
firewall need different fixes.

A star also costs something the output states every time it names one: spokes see
the hub and the hub sees every spoke, but **spokes do not see each other**, since
`export` publishes local panes only.

Nodes being asleep or switched off is the normal state of a fleet, so nothing
warns about it on a polling path: `murmur status` and `murmur pick` stay silent
whatever the peers are doing. `murmur peer list` has a LAST SEEN column, and
`murmur collect` -- which you run deliberately -- prints one line per peer it
could not reach.

```tmux
bind -N "agent state picker" a display-popup -E -w 80% -h 60% "murmur pick"
```

In the picker: `^r` refreshes, `^p` cycles the preview, and fzf's own `^u` clears
the filter. `M-b` / `M-w` / `M-d` / `M-x` filter to blocked, running, done or
crashed, with `^w` / `^d` / `^x` as aliases for three of them; `M-a` toggles
orchestrated agents. There is no `^b`: that is tmux's default prefix, which tmux
consumes before a popup ever sees it, so the one filter that cannot have a ctrl
alias is `blocked`. Typing matches agent name, workstream or tmux session, and
host, as literal substrings.

`murmur status` prints per-state counts for a status bar. Everything else is
`--help`.

## Jumping to a remote agent

A remote jump runs `ssh -t <host> tmux attach` in its own local tmux session,
named after the peer with a trailing `~`. That session sets two options on
itself, which is why it does not feel like nested tmux:

- `status off` — the remote's bar is the only one on screen.
- `prefix None` — `^b` goes straight to the remote. No `^b b` to learn.

Both are per-session, so your other sessions are unaffected. Leaving the remote
(inner `^b d`, the session ending, or the ssh dropping) returns you to the window
you jumped from and destroys the wrapper. Jumping to the same host twice reuses
one session.

The tradeoff: inside the wrapper the local tmux has no prefix, so you cannot
reach it. For an escape hatch, bind one key in the root table:

```tmux
# Alt-Escape detaches out of a murmur wrapper session, and does nothing
# elsewhere. Deliberately not M-b or another Alt letter: a root-table binding
# is consumed before any pane, so it would eat the picker's own M-b / M-w /
# M-d / M-x filters -- the same class of collision that made ^b useless there.
bind -n M-Escape if-shell -F '#{m:*~,#{session_name}}' detach-client
```

Outside tmux none of this applies: `murmur pick` runs the ssh directly, which is
already full-screen, and you land back at your shell prompt on exit.

## Status

**0.2.3.** In daily use on one machine and verified across a five-peer fleet
over real ssh, including a host that demands a second factor per connection. It
is new and not battle-tested. The known gaps and the accepted limitations are
listed at the end of [ARCHITECTURE.md](ARCHITECTURE.md#known-gaps).

**A host that demands interactive auth needs a master session open.** Some
machines refuse an unattended login — a second factor per connection, a
hardware token, a password. murmur never prompts (every ssh it runs sets
`BatchMode=yes`, so a background collect cannot block on a human), which means
such a peer is only collectable while an authenticated connection already
exists.

Open one and leave it running:

```sh
ssh -M -S '~/.ssh/control/%r@%h:%p' dev    # answer the second factor once
```

`-M` is the part that matters, and a plain `ssh dev` is **not** enough: that
attaches as a client to whatever socket exists, or — behind a `ProxyCommand` —
leaves a socket that can forward ports but has never authenticated a *session*.
`ssh -O check` reports `Master running` either way, so the difference is
invisible until a command over it fails with `Session open refused by peer`.
`-M` makes the session you just authenticated the master, so murmur's channel
rides a connection that has already cleared the second factor.

While that master lives, collects cost ~10ms. While it does not, the peer is
skipped rather than dialled on every tick, its cached rows still list with their
real age, and the picker header names it with the command:

```
! dev: re-auth needed (last seen 2h) — ssh -M -S ~/.ssh/control/%r@%h:%p dev
```

`murmur doctor` carries the full list where the header trims.

An **Eternal Terminal** session does not work for this, which is worth stating
because it looks like it should: ET bootstraps over ssh, so opening one hits the
same auth wall, and it exposes no multiplexing socket for another process to
attach to. A plain `ssh -M` alongside it is what murmur can use.

**All nodes must speak the same snapshot format.** The format is versioned and a
mismatch is rejected rather than guessed at, so a node on a different snapshot
version is reported as reachable-but-broken with the reason on it. Patch versions
interoperate freely — 0.2.0 and 0.2.3 both speak snapshot 1 — and `murmur peer
list` shows each peer's version, so a bad pairing is visible before you start
debugging it. Upgrading the fleet together is still the simplest way to stay out
of it.

## Documentation

[ARCHITECTURE.md](ARCHITECTURE.md): the three independent facts the model rests
on, the design choices and what they cost, what murmur deliberately cannot do,
and what is unfinished.

---

*A murmuration: many independent agents, no leader, coherent from a distance.*
