# Setup

Wire murmur after `npm install -g @martintrojer/murmur`. Selling and surface
overview: [README](../README.md). Hard ssh cases: [SSH.md](../SSH.md).

## Per-node init

On every node that runs agents:

```bash
murmur init      # this node's identity
murmur link pi   # install the agent-side extension
```

`link pi` writes a one-line extension into `~/.pi/agent/extensions/` that
re-exports this install. `npm install -g` is the upgrade path; re-run `link pi`
only if the install path moves. `link pi --copy` inlines the extension and pins
it — re-link after every upgrade if you use that form.

Running agents keep the old extension code until they restart. Order matters:
without `murmur init` the extension loads and records nothing. Agents must run
**inside tmux**. A pane is the address; without one there is nothing to jump to.

## tmux focus hooks

Looking at a finished agent clears its badge. On every node, in `.tmux.conf`:

```tmux
set-hook -g after-select-pane      "run-shell -b 'murmur clear --pane #{pane_id}'"
set-hook -g after-select-window    "run-shell -b 'murmur clear --pane #{pane_id}'"
set-hook -g client-session-changed "run-shell -b 'murmur clear --pane #{pane_id}'"
```

These are per node and not optional. `murmur clear` is what acknowledges an
attention request. A node's own snapshot is what every peer reads — without
these hooks, finished agents stay `done` in every peer's list.

Verify with `tmux show-hooks -g`. `set-hook` accepts a name your tmux does not
have and exits 0, so a wrong name fails silently.

Pass the pane id explicitly: hooks run in the tmux server, where `$TMUX_PANE` is
unset. Without it, a window holding an agent and a shell clears when you focus
the shell.

Focus can only cancel attention. It cannot stop a running agent or alter what
the agent reported about itself.

## Harnesses other than pi

pi reports in-process through the extension. Codex, opencode, and the Cursor CLI
have no such hook — they run a command when something happens — so they use
`murmur notify`, which records an attention request for the pane it runs in.

This path is attention only: no ownership, no `running`/`idle`, no crash
detection. Unrecognised events become `blocked`, so a new harness still puts a
row in front of you.

### Codex

```toml
# ~/.codex/config.toml
notify = ["murmur", "notify", "--source", "codex"]
```

Do not wrap with `sh -lc` alone. Codex appends the event JSON as one more
argument, and `sh -lc '<script>' <arg>` puts that argument in `$0` rather than
`$1` — the wrapper swallows the payload. Exec murmur directly, or forward
explicitly:

```toml
notify = ["/bin/sh", "-lc", "exec murmur notify --source codex \"$@\"", "codex-notify"]
```

Codex fires `agent-turn-complete` (turn ended, waiting for you) — murmur records
`done`. opencode's `session.idle` means the same thing. Drop `--title Codex` if
you have it; the message falls back to the payload's `last-assistant-message`.

The same fields may arrive as JSON on stdin (opencode's plugin form). argv wins
when both are present; flags still beat the payload, so `--event-type` can pin
an event murmur does not know.

### Cursor CLI

```json
{
  "version": 1,
  "hooks": {
    "stop": [
      {
        "command": "murmur notify --source cursor"
      }
    ]
  }
}
```

`~/.cursor/hooks.json` (user) or `.cursor/hooks.json` (project). `status:
completed` → `done`; `aborted` or `error` → `blocked`. The agent must run inside
tmux. Interactive `agent` sessions are the target; non-interactive `agent -p`
has been observed to omit `stop`.

### PATH in hooks

A notify hook inherits the PATH of whatever launched the harness. `/bin/sh -l`
does not fix a missing npm prefix. Verify from inside the harness:

```bash
murmur notify --source probe --message reachable && murmur status
murmur clear --pane "$TMUX_PANE"
```

If `murmur` is missing there, use the absolute path from `command -v murmur`.

The probe is a real attention request: no event name → `blocked`, so the window
badges. `murmur clear` (or focus, with the hooks above) takes it back.

`notify` outside tmux records nothing and exits 0, so it cannot break the
caller's exit code. A pane reached only via notify is still a full jumpable
row.

## Peers and doctor

On the machine you watch from:

```bash
murmur peer list         # configured peers, last seen
murmur peer list --all   # also ssh hosts that could become peers
murmur peer add devbox
murmur doctor            # survey each peer over ssh
murmur doctor --topology # also probe who can reach whom
```

`peer list` is local. `doctor` dials out. Membership is per node: peering a
machine does not mean it peers you — if it does not peer back, its list cannot
see your agents. `doctor` writes nothing and repairs nothing; it prints the
commands. Exit 0 for observations, 1 only for a real problem. Suggestions name
this node as it calls itself; that name may not resolve from the peer's side.
`peer add` accepts a target that does not answer yet and discovers identity on
the first collect.

`--topology` costs one dial per ordered pair. Plain `doctor` answers "is my
fleet mutual?"; `--topology` answers "what shapes are possible here?". A
recommended hub is arithmetic on that matrix. Spokes see the hub and the hub
sees every spoke; **spokes do not see each other** — `export` publishes local
panes only. A pair that was not demonstrably up reads `unknown`, not
unreachable.

Asleep or powered-off nodes are normal. `status`, `pick`, and `dash` stay silent
about that. `murmur peer list` has LAST SEEN; `murmur collect` (run on purpose)
prints one line per peer it could not reach.

Bind a popup picker:

```tmux
bind -N "agent state picker" a display-popup -E -w 80% -h 60% "murmur pick"
```

Typing in pick matches agent name, workstream or tmux session, host, and the
state word as literal substrings — so `blocked` narrows without a dedicated
binding.

## Jump command override

`target` is always ssh (collector). The jump command is for a human and need not
be ssh:

```bash
murmur peer set dev --jump-command 'et dev -c "tmux attach -t {pane}"'
```

murmur substitutes `{pane}` and runs the rest unparsed. Default is
`ssh -t <target> tmux attach`. Use this when sshd sets `MaxSessions 1` — see
[SSH.md](../SSH.md).

Remote jump from inside tmux opens a local wrapper session named after the peer
with a trailing `~`:

- `status off` — the remote's bar is the only one on screen
- `prefix None` — `^b` goes straight to the remote

Both are per-session. Leaving the remote returns you to the window you jumped
from and destroys the wrapper. Jumping to the same host twice reuses one
session. Outside tmux, pick/dash run ssh directly and you land back at your
shell on exit.

Inside the wrapper the local tmux has no prefix. Escape hatch (root table —
not `M-b` / other Alt letters that would eat picker's own filters):

```tmux
bind -n M-Escape if-shell -F '#{m:*~,#{session_name}}' detach-client
```

## Snapshot versions

All nodes must speak the same snapshot format. A mismatch is rejected rather
than guessed — the peer shows as reachable-but-broken with the reason.
`murmur peer list` shows each peer's version. Patch versions that share a
snapshot major interoperate.
