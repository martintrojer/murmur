# murmur architecture

How it works, why it is built this way, and why it exists rather than a
configuration of something else.

## The problem

Coding agents run on more than one machine: a laptop, a desktop, a remote box.
Each machine knows what its own agents are doing. No machine knows what the
others are doing. So "is anything blocked on me right now" means visiting each
one in turn, and jumping to an agent means first remembering which host it lives
on.

That is the whole problem. Everything below is in service of it, and the design
spends most of its effort refusing to solve harder problems nearby.

## The shape

```
pi agent ──in-process── murmur store ── events.db   (one per node)
                                            │
                              ssh murmur export --since N
                                            │
                                   collector ── fold ── picker
                                                          │
                                        jump: local switch, or ssh -t
```

Each node keeps an append-only SQLite log describing only its own agents. Any
node pulls its peers' logs over ssh and folds the union into one
attention-sorted picker. No daemon, no listening socket, no master node.

murmur observes and connects. It does not place work. That is an orchestrator's
job, and mixing the two is how you end up owning scheduling, credentials and
artifact movement.

## Why this is not a distributed system

It is single-writer-per-partition replication. Each node authors only events
about its own agents, so no two nodes ever write about the same thing. Merging
is a UNION.

Calling it "distributed" invites machinery the problem does not have: consensus,
conflict resolution, vector clocks, leader election. If a change starts to need
conflict resolution, that is the signal the single-writer invariant has been
broken somewhere.

Two consequences worth stating, because both are easy to violate by accident:

- **A node may not author events about another node's agents.** Not even
  corrections. A reader that learns something (a jump proving a window is gone)
  records it as *reader state*, or deletes its replica. It does not write an
  event.
- **`host_id` is the origin, watermarks are keyed by peer.** These are the same
  thing today, and differ the moment anything gossips. Free to preserve now,
  expensive to retrofit.

## A tmux pane is the agent's address

Everything below assumes agents run inside tmux. A pane is how murmur names an
agent and how a jump reaches one.

The extension resolves its pane from `$TMUX_PANE` and returns early without one,
so a pi started in a plain terminal writes no events and never appears in the
picker. That is the honest outcome rather than a gap: with no pane there is no
address, and a row you cannot jump to is worse than no row.

Two nearby calls look contradictory and are not:

- `currentWindow()` answers "which pane am I in", so only `$TMUX_PANE` can tell
  it. Asking tmux instead reports whichever pane the server considers active,
  which would let a non-tmux pi record itself in an unrelated agent's pane and
  overwrite that agent's state.
- `liveWindows()` answers "which windows exist on this host", which is
  server-wide and correct from anywhere. Export runs over ssh with no pane of
  its own and still has to see the windows.

The remote jump inherits the same requirement, since it is `ssh -t <host> tmux
attach`. tmux must be running on the far side, which is why a dead remote tmux
server gets its own diagnosis rather than being reported as an unreachable
host.

The badge also has to be cleared from outside, which is why `murmur clear --pane
<id>` exists and why tmux hooks call it. The status bar and the `tms` picker read
a window option, so it outlives the agent unless something clears it — and the
agent cannot, because "you looked at it" is an event only the multiplexer sees.
Hooks run in the tmux server with no `$TMUX_PANE`, so the pane id is passed
explicitly: the badge belongs to the window, the looking belongs to one pane.

## The six units

| Unit | Does | Depends on |
| ---- | ---- | ---------- |
| `identity` | Read/create this node's `{host_id, display_name}` | state dir |
| `store` | Append, query, ingest, prune. **The only module touching SQL** | `identity` |
| `fold` | **Pure.** Events in, agent states out | nothing |
| `channel` | Seam: `exec(target, argv) -> stdout`. One impl: ssh | OS |
| `collector` | Pull each peer, ingest, advance watermark | `channel`, `store` |
| `mux` | Seam: window/pane queries, set state, attach. One impl: tmux | OS |

`fold` being pure and `store` being the only SQL is the boundary that carries
the design. Four heuristics live in one of those two modules: attention
ordering, staleness, crash synthesis, and retention. Both modules are testable
without a machine, a network or a multiplexer.

Three seams exist with exactly one implementation each: `channel` (ssh),
`harness` (pi, in-process), and `mux` (tmux). Defined so a second
backend is possible; not designed for one that does not exist.

## The data model

One append-only table. Sole author per `host_id`. Primary key `(host_id, seq)`,
which is what makes ingest idempotent. A re-read after a partial failure is
free.

| Column | Notes |
| ------ | ----- |
| `host_id` | UUID of the **origin** node, not the node we fetched from |
| `seq` | Monotonic per `host_id`. The watermark unit |
| `ts` | Wall clock. Display ordering only |
| `agent_id` | Stable for the agent's life. Identity, distinct from location |
| `session`, `window`, `pane` | Current **location**. May change |
| `session_name`, `window_name` | Recorded by the author; ids are machine-local |
| `agent_name`, `pi_session` | Richer than tmux, and not derivable from it |
| `workstream`, `role`, `cli` | Nullable. Grouping and display |
| `driver` | `human \| orchestrated`. **Per agent, not per node** |
| `kind` | `state` today. Discriminator for future kinds |
| `state` | `working \| blocked \| done \| crashed \| cleared` |
| `message`, `pid`, `synthetic`, `reason` | Detail |
| `extra` | JSON. Unknown fields, preserved verbatim |

**Unknown data round-trips.** A node ingesting an unknown `kind` or unknown
fields stores them in `extra` and re-exports them unchanged. Without this, an old
node in a future replication path silently truncates data — invisible from both
ends, and only reachable against a version you do not control.

Deliberately absent: a generic `put`/`del` op-log (that needs conflict
resolution, which single-writer partitioning lets us skip, and it would simply
*be* `mu`), task/DAG structure (observing a task graph means owning it), and any
hybrid logical clock (nothing depends on cross-node causality; clock skew
affects display order only).

**An event log, not a state snapshot.** Current state is a fold over the log,
which buys three things: there is no state table that can disagree with the log,
incremental sync is a watermark ("everything after N", idempotent), and history
is not optional, because the picker's preview shows recent events, so the
protocol has to ship events rather than derived state.

**TypeScript, on install-story grounds.** pi is an npm package, so every node
running agents already has Node and npm. Python would mean inventing a
cross-machine install story for the ecosystem that handles it worst, on machines
where the system interpreter is least yours to touch. "Keep the working script"
is weaker than it looks: those lines worked because dotfiles symlinked them, so
a second machine means packaging them either way.

## Three ideas to understand before changing anything

Everything else is mechanical.

### 1. State and freshness are different axes, and freshness is two

`stale` is not an agent state. The enum stays `working | blocked | done |
crashed | cleared`.

- **state** — what the agent is doing. Authored by the agent, in the log.
- **freshness** — how current our replica is. Known only by the reader.

Putting `stale` in the enum produces unanswerable questions: is a crashed agent
on an unreachable host `crashed` or `stale`? Both, on different axes.

Freshness then splits again, and missing this shipped a bug:

| | asks | answers |
| --- | --- | --- |
| `fetched_at` | how current is my copy | is the host reachable |
| event `ts` | how old is this agent's news | is the row worth believing |

A peer polled one second ago can be serving three-hour-old events. Collapsing
these made a dead host's agents render as live, because the replica really was
current.

### 2. Facts only the author can know are recorded by the author

Pids, window liveness and window names mean something only on the machine that
owns them, so crash synthesis runs on the authoring node during export.

Do it on the reader and every remote `working` agent is marked `crashed`, which
looks exactly like a real crash and so goes uninvestigated. This is the easiest
thing in the codebase to get backwards.

The same rule gives names their home: window ids are machine-local, so resolving
a remote id against the local tmux labels an agent with whatever *this* machine
has at that id. Names travel on the event instead. Liveness follows it too — an
idle agent's pid is only checkable at home, which is why remote idle rows report
`unknown` rather than a guess.

### 3. The single-machine case is the same code path

murmur replaced a 1500-line script that was the daily local tool. Zero peers is
therefore the common case:

- the pi extension appends events and sets the tmux window option
- the status bar and picker read the fold
- the collector iterates the peer list, finds nothing, and does nothing

No network, no ssh, no daemon, no added latency. Federation is strictly
additive: a `host_id` on rows that all say "me", and a loop over an empty array.

This is a constraint, not an observation. A tool that only pays for itself at
three nodes charges rent daily for capability used occasionally — one of the
things herdr was rejected for. Measured first paint with zero peers: 48 ms
against 250 ms for the picker it replaces.

## Design choices, and what they cost

**Pull, not push.** "Adhoc ssh" and "an open tunnel" are one model at two
latencies. Both are the reader pulling, and OpenSSH `ControlMaster` collapses
them, because the persisted control socket *is* the tunnel. Push needs a
listener, which is the thing this design does not have.

**The collector never prompts.** It reuses a warm `ControlMaster` socket when
there is one and cold-connects otherwise, so with key auth a peer is visible
whether or not you ssh'd there recently. `BatchMode=yes` makes the cold path
acceptable: no password, passphrase or host-key prompt, so a peer that cannot
authenticate fails fast and shows stale instead of blocking on a human.

Unhandled: a host demanding a hardware-token touch per connection, which
`BatchMode` cannot detect before the token blinks. `hasWarmSocket` exists for
that — gating collect on it per peer would restore the strict posture for those
hosts only. Not wired up, because no peer in use needs it.

**Membership is local and asymmetric.** No shared node list, no registry, no
join protocol. Reachability is not symmetric: a laptop reaches a server, and
the server does not reach a laptop behind NAT that sleeps. A global list would
advertise peers half the fleet cannot use. And nothing needs one: only a node
rendering a picker needs targets, and only ones it can reach. Identity is
*discovered*. Config holds an ssh target, and the first export returns the
node's UUID and display name.

**Zero knobs.** Every exported setting is one the user can get wrong invisibly.
Two are irreducible: `peers` (only the operator knows their fleet) and `theme`.
Retention horizon, collection interval and staleness threshold are constants.
The trade: a wrong constant needs a release, not an edit. Heuristics replace
knobs, so heuristics are where the tests go.

**`driver` distinguishes who is waiting.** An agent you are talking to and an
agent an orchestrator placed want opposite treatment: when the orchestrated one
finishes, its supervisor consumes the result and nobody needs to acknowledge
anything. Same state, opposite attention. It is per *agent*, not per node,
because the normal case is one machine running your session and six spawned
workers at once. Null reads as `human`, so an older node's events degrade toward
visible.

**Glance, not remote rendering.** "Render any pane from the master" hides two
different problems: a stateless `capture-pane` (cheap, and what the preview
does) and continuous frame streaming with resize negotiation and input routing
(most of herdr's codebase). Glance plus jump gets everything except never
leaving the local frame, and you are jumping there to work anyway. This
deferral is the main reason murmur is small.

## Why not something else

Investigated against herdr 0.8.2, a T3 Code checkout, and `mu`, all built and
run locally rather than judged from their READMEs.

| | multi-machine view | pi support | state source |
| --- | --- | --- | --- |
| herdr | no — 1:1, planned, blocked | yes | screen-scraped |
| T3 Code | no — "unbuilt" by its own docs | no — 14-method adapter | driven |
| mu | state sync yes, agents no | yes | reported |
| **murmur** | **yes** | **yes, in-process** | **pushed** |

### herdr

A Rust terminal multiplexer built for coding agents: workspaces, tabs, panes, a
per-pane `idle/working/blocked/done` sidebar, a socket API. Evaluated as a tmux
replacement and rejected on its own terms.

On multi-machine it is strictly 1:1. `--remote <target>` takes a single target,
no subcommand has a `--host` flag, and `--remote` *replaces* the view rather
than adding to it: two machines means two sessions and a full switch between
them. Multi-client is the maintainer's stated top priority, gated behind a
long-running server/client refactor.

Waiting would not help. The scope is one client attaching to multiple *herdr*
servers, so every machine must run herdr — including machines where you cannot
choose the multiplexer. And herdr detects state by matching terminal output, so
adopting it trades push-based state from inside the agent for screen-scraping.

Taken from it: integration installs that write hooks into each agent's own
config directory (`murmur link pi`), reusing one authenticated connection, and
its own stated non-goals: no merged PTYs across machines, no moving work
between hosts, host as a lightweight label. Rejected: the always-present
sidebar, not for its ~4 columns but because it is fixed to one edge and cannot
become a horizontal strip, while a status row is overhead already paid.

### T3 Code

An "agent harness control surface": a server owning agent sessions plus web,
desktop and mobile clients over one RPC WebSocket.

Its remote access is well ahead of herdr: direct ws/wss, bearer pairing, relay
tunnels, mesh-VPN serve and desktop-managed SSH, all shipped. But the aggregated
view is unbuilt by its own internals docs — multiple live connections exist, a
fused cross-machine overview does not.

It also does not support pi, and adding it is expensive: a provider needs a
driver plus a fourteen-method adapter, and the reference implementation is over
1700 lines. murmur's adapter problem is smaller structurally: T3 Code drives an
agent it does not live inside, while murmur's extension runs *in process* and
calls the store directly.

Taken from it: the rule that *remoteness is expressed at the connection layer,
never by splitting the runtime* (murmur's channel seam is exactly this),
transport is not an identity, and environment identity as a stable UUID rather
than a hostname.

### mu

An agent orchestrator: workstreams, a task DAG, agents in panes, isolated
workspaces. It already solved the hard half of the replication problem: machine
identity, per-peer watermarks, an op-log.

Two ideas taken directly. Sync is ambient rather than a daemon: every invocation
syncs before the verb, and no watcher outlives the command. And sync never fails
a command — every ambient entry point is total, and a dead peer warns and
returns.

One idea deliberately not taken: mu's generic replicated KV. A generic op-log
needs conflict resolution, which single-writer partitioning skips entirely, and
a murmur with `put`/`del` over arbitrary entities would just *be* mu.

**Relationship:** murmur observes, mu orchestrates. Merging is plausible later,
since murmur would give mu global agent addressing and remote observation. But
remote *orchestration* is much harder than remote observation, and none of it is
murmur's problem.

## Testing posture

Bug-driven, not coverage-driven. A thing earns a test when it can fail *without
you noticing*:

| Target | Why it can fail silently |
| ------ | ------------------------ |
| Fold precedence | A wrong glyph gets rationalized, not investigated |
| Staleness derivation | A dead peer keeps showing last-known state forever |
| Ingest idempotency | Duplicate rows after a partial read |
| Unknown-field preservation | Breaks against a future node you do not own |
| Retention keeping newest-per-agent | Idle agents vanish; reads as "not there" |

Not tested: ssh transport (OpenSSH's job), tmux wrappers (thin and loud), TUI
rendering, packaging.

New tests are verified by breaking the code they cover and watching them fail. A
test that has never failed has not been shown to test anything. A test asserting
a *wrong* behaviour has been written twice here, so this step is not ceremony.

Two traps this caught, both in the tests rather than the code. A `setTimeout(0)`
used to drain the extension's fire-and-forget queue passed and failed about one
run in ten -- a race in the test, which is worse than a failing test because it
teaches people to re-run. And a `until()` helper that threw on timeout made a
mutation "pass": the regression died inside the helper instead of at the
assertion describing it. Barriers wait for an observable effect, and report
through the caller's `expect`.

Where the fake is the test's weak point, the test talks to the real thing.
`test/mux-targets.test.ts` drives a private tmux server on its own `-L` socket,
because every other test fakes the `Mux` and a malformed tmux target passes them
all — two wrong target spellings did exactly that.

**The thing to know before adding a feature:** most bugs worth fixing here were
invisible to unit tests and to reading the code. A silently no-opping extension,
a remote jump broken by two independent shell-quoting layers, a 75-second hang
on an unreachable peer, ages that measured the wrong clock. All surfaced by
running the thing on two real machines. Unit tests protect the heuristics; they
do not tell you the tool is usable.

## Deliberate non-goals

Each was considered and refused with reasons above:

- a daemon or listening socket
- interactive remote terminal rendering
- orchestration or work placement
- a generic put/del op-log
- HLC or clock reconciliation
- gossip replication (schema-compatible, not built)
- configuration knobs beyond peers and theme
- harnesses other than pi, multiplexers other than tmux, channels other than ssh

## Known gaps

- **Liveness of a quiet agent degrades to `unknown` after an hour.** Pids
  recycle -- measured at ~9/sec idle here, so darwin's 99999-pid space wraps in
  about three hours -- and `pidAlive` only asks whether *something* holds that
  number. Past the trust horizon an alive agent that has been quiet reads
  `unknown`, which is honest but less useful than the truth. A start timestamp
  compared against the process's own would fix it and needs a `ps` call.
- **Remote idle agents report no liveness.** Only the authoring node can check a
  pid, so remote idle rows read `unknown` where local ones read `live` or
  `exited`. A peer could fold and export its own, and the wire format allows it.
- **The remote wrapper session is verified against tmux, not against use.**
  Options, the switch, and the return to the origin window are verified on real
  tmux servers with a stub ssh. Sitting in a live remote pane and working in it
  is not, which is the same gap as interactive attach below.
- **Interactive attach is unverified.** Federation, staleness and the jump
  target are verified across two machines over real ssh; sitting in a remote
  pane and working in it is not.
- **The hardware-token path is verified only in the cold-fail direction.** The
  second test node authenticates by key, so it never needed a warm socket.
- **Non-pi harnesses have no attention path.** Agents that cannot report from
  inside themselves need an outside-in `notify` verb, which does not exist.
