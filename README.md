# murmur

**Every coding agent you have running, on every machine, in one list.**

You have agents on your laptop, your desktop, and a box somewhere else. One of
them is blocked waiting on you right now. Which one?

Today you find out by walking the machines. Attach here, glance there, try to
remember where you left that session. murmur answers the question in one
keystroke, then jumps you to the agent on whichever machine it turns out to be.

```
     state    agent                          workstream    host           age / flags
   ! blocked  review the auth change          api           → devbox        4m
   ▶ working  Fix the picker filter           murmur          here
   ✓ done     migrate the fixtures            api           → devbox        12m
   · idle     worker-2                        infra           here          crew live
   · idle     glance-2                        murmur          here          exited
```

Pick a row and press enter. Local agents are a window switch away; remote ones
open over ssh. The preview beside the list shows the last few lines the agent
printed, so you can tell "waiting on me" from "still thinking" without going
there at all.

Idle means the agent wants nothing, which covers a pi sitting between turns and
a pane whose agent exited hours ago. `live` and `exited` separate those: one is
worth jumping to, the other is worth closing. Only the agent's own machine can
check a pid, so a remote idle row shows neither.

## Why it exists

The tools in this space are excellent at one machine and stop there.
[herdr](https://herdr.dev) is strictly one client to one server, and its
multi-client work is blocked behind an unfinished refactor. T3 Code has better
remote *access* than anything else here, but lists the aggregated view as
unbuilt in its own docs. Both infer agent state by matching terminal output.

murmur takes a different bet. The agent reports its own state from inside the
process, and the machines exchange nothing more complicated than "here is my
log since event N". Knowing what is happening is the hard part, and reporting
it from inside the agent is what makes it reliable.

## What it is

- **A state layer over tmux:** tmux keeps owning your panes. murmur owns the
  answer to "what is every agent doing right now".
- **Push-based state:** a pi extension reports from inside the agent. Nothing
  screen-scrapes, and a crash is detected from a pid rather than guessed from
  output.
- **No daemon, no listening socket, no master:** peers are pulled over ssh when
  you run a command. Every node can aggregate; none is special.
- **Fast with one machine:** it replaced a local-only script and got quicker
  doing it, 48 ms to first paint against 250 ms. Configuring zero peers is the
  common case, and nothing about it is degraded.

## What it is not

It does not orchestrate. It observes and connects, and never places work; that
is [`mu`](https://github.com/martintrojer/mu)'s job.

It is not a remote terminal. You can glance at a remote pane or jump to it, but
there is no frame streaming and no resize negotiation, which is most of why it
stays small.

It does not replace your multiplexer. See
[ARCHITECTURE.md](ARCHITECTURE.md#why-not-something-else) for the comparison
against herdr, T3 Code and `mu`.

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

`link pi` writes the extension into `~/.pi/agent/extensions/`, pinned to this
installation. Re-run it after upgrading murmur.

Also on every node, in `.tmux.conf`, so a finished agent stops asking for
attention once you look at it:

```tmux
set-hook -g after-select-pane      "run-shell -b 'murmur clear --pane #{pane_id}'"
set-hook -g after-select-window    "run-shell -b 'murmur clear --pane #{pane_id}'"
set-hook -g client-session-changed "run-shell -b 'murmur clear --pane #{pane_id}'"
```

These are per node and not optional. The `cleared` event they write replicates,
so a node without them leaves its agents marked `done` in *every* peer's picker,
not only its own status bar. Verify with `tmux show-hooks -g`: `set-hook`
accepts a hook name your tmux does not have and exits 0, so a wrong name fails
silently.

The pane id is passed explicitly because hooks run in the tmux server, where
`$TMUX_PANE` is unset, and because the badge belongs to the window while "you
looked at it" is true of one pane. Without it, a window holding an agent and a
shell clears when you focus the shell.

Then, on whichever machine you want to watch from, add the peers and bind the
picker to a key:

```bash
murmur peer add devbox   # an ssh target; identity is discovered
```

```tmux
bind -N "agent state picker" a display-popup -E -w 80% -h 60% "murmur pick"
```

In the picker: `^r` refreshes, `^p` cycles the preview, and `del` drops a stuck
row. `^b` / `^w` / `^d` / `^x` filter to blocked, working, done or crashed, and
`^a` clears the filter. Typing matches the agent name, its workstream or tmux
session, and its host, as literal substrings rather than scattered characters.

`murmur status` prints per-state counts for a status bar. Everything else is
`--help`.

## Jumping to a remote agent

A remote jump opens the `ssh -t <host> tmux attach` in a local tmux session of
its own, named after the peer with a trailing `~`. That session sets two options
on itself, and both are why the jump does not feel like nested tmux:

- `status off` — no local status bar, so the remote's own bar is the only one on
  screen and the jump reads as a full-screen ssh.
- `prefix None` — no local prefix at all, so `^b` goes straight to the remote.
  No `^b b`, and no second prefix to learn.

Both are per-session, so your other sessions keep their prefix and status bar.
When you leave the remote — inner `^b d`, the remote session ending, or the ssh
dropping — the wrapper returns you to the exact window you jumped from and
disappears. Jumping to the same host twice reuses the one session.

The tradeoff: while you are inside the wrapper, the local tmux has no prefix, so
you cannot reach it. If you want an escape hatch that does not involve the
remote, bind one key in the root table:

```tmux
# Alt-b detaches out of a murmur wrapper session, and does nothing elsewhere.
bind -n M-b if-shell -F '#{m:*~,#{session_name}}' detach-client
```

Outside tmux none of this applies: `murmur pick` runs the ssh directly, which is
already full-screen, and you land back at your shell prompt on exit.

## Status

**0.1.4.** In daily use on one machine and verified across two over real ssh.
It is new and not battle-tested. The known gaps are listed at the end of
[ARCHITECTURE.md](ARCHITECTURE.md#known-gaps).

The event schema is versioned on the wire and preserves fields it does not
recognise, so a newer node and an older one can already talk to each other.

## Documentation

[ARCHITECTURE.md](ARCHITECTURE.md) explains how it works, the three ideas you
need before changing anything, why it exists rather than the alternatives, and
what is unfinished.

---

*A murmuration: many independent agents, no leader, coherent from a distance.*
