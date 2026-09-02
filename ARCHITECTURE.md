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
pi agent ──in-process── murmur store ── state.db   (one per node)
                                            │
                                    ssh murmur export
                                            │
                                collector ── view ── picker
                                                       │
                                     jump: local switch, or ssh -t
```

Each node keeps one SQLite database describing the current state of its own
panes. `murmur export` prints that state as a single complete JSON document — a
**snapshot**. Any node pulls its peers' snapshots over ssh, caches one per peer,
and renders the union as an attention-sorted list. No daemon, no listening
socket, no master node.

murmur observes and connects. It does not place work. That is an orchestrator's
job, and mixing the two is how you end up owning scheduling, credentials and
artifact movement.

## The model in one page

Three facts, independent, each with exactly one writer:

| Fact | Meaning | Stored as | Written by |
| --- | --- | --- | --- |
| **activity** | is a process working in this pane | `agents.activity` = `running` \| `stopped` | the pane's owning process only |
| **attention** | does someone need to look at this pane | rows in `attention`, kind `done` \| `blocked` \| `crashed` | owner (`done`), external notifier (`blocked`), local reconciliation (`crashed`) |
| **freshness** | how recently we reached the node that reported | `peers.fetched_at` | the collector |

They are never folded into one enum, and no stored value spans two of them.
There is no `cleared`: absence of an attention row *is* "nothing to see", and
absence of an agent row *is* "no agent here". The words a surface paints
(`crashed`, `blocked`, `done`, `running`, `idle`) are derived at read time by
`renderState` and stored nowhere.

Why three and not one. A crashed agent on an unreachable host is crashed *and*
stale, on different axes; a running agent that a notifier flagged as blocked is
both, and the picker shows both. Every attempt to collapse these produced a
question with no answer, and one of them shipped: a focus hook that could
overwrite an agent's state replaced `working` with `blocked` on live panes and
nulled the owner metadata while all three processes were running. The fix is
structural — `attention` has no column an agent field could live in.

Identity and address are separated:

- **node identity** — `identity.json`, `{host_id, display_name}`. Created only
  by `murmur init`, and only by it. Survives a store wipe.
- **agent identity** — a random UUID minted per *process instance* when it
  claims a pane. It is not derived from the pane, so a new process in the same
  pane is a different agent, and a late write from a replaced owner matches no
  row.
- **pane** — the *address*. `UNIQUE` in `agents`, part of the primary key in
  `attention`. One top-level instrumented agent per pane, enforced by SQLite.

Truth about a node lives only on that node. Other nodes hold one opaque,
validated snapshot per peer, replaced whole or not at all.

## Why this is not a distributed system

It is single-writer-per-partition caching. Each node owns the state of its own
panes and publishes it; no other node writes about them, ever. Merging is a
concatenation of one local read and one cached document per peer.

Calling it "distributed" invites machinery the problem does not have: consensus,
conflict resolution, vector clocks, leader election. If a change starts to need
conflict resolution, that is the signal the single-writer invariant has been
broken somewhere.

Three consequences worth stating, because each is easy to violate by accident:

- **A node may not write state about another node's panes.** Not even
  corrections. A reader that learns something — a jump proving a pane is gone —
  *reports* it and writes nothing. The next collect reconciles, because the
  owning node is the one that reconciles.
- **Only a pane's own process may report for that pane.** `claimAgent` answers
  `refused` to a second live claimant, and a refused caller registers no
  handlers, writes nothing and paints no badge. This replaced an environment
  marker and three helper functions: a nested pi inherits `$TMUX_PANE` and used
  to report *as* the pane's real agent, so one pane accumulated six reporting
  pids of which one was alive, and the live agent read idle while it worked.
  Silence is correct for a process with nothing true to say.
- **`murmur notify` is the one deliberate exception, and it is narrow by
  construction.** Its whole request type is `{kind, location, message, source}`
  — there is no `agent_id`, no pid, no activity and no metadata field, so it
  cannot say anything about a process being alive even by accident. It is also
  restricted to `blocked` by the callers that use it; `running`, `done` and
  `crashed` remain the owner's and reconciliation's.

## A tmux pane is the agent's address

Everything below assumes agents run inside tmux. A pane is how murmur names an
agent and how a jump reaches one.

An agent IS a pane. A session and a window are only where that pane currently
lives: a pane keeps its id across `move-pane`, `break-pane`, and a window closed
and reopened, while a recorded window id goes stale as a matter of course. So
**only a pane may decide whether an agent exists** — a window id is location,
never evidence of life. tmux says the same thing with its sigils, `$25` / `@75`
/ `%89`, and the three ids are branded types (`SessionId`, `WindowId`, `PaneId`)
so that passing one where another is meant does not compile.

The extension resolves its pane from `$TMUX_PANE` and returns early without one,
so a pi started in a plain terminal records nothing and never appears in the
picker. That is the honest outcome rather than a gap: with no pane there is no
address, and a row you cannot jump to is worse than no row.

Two nearby calls look contradictory and are not:

- `currentWindow()` answers "which pane am I in", so only `$TMUX_PANE` can tell
  it. Asking tmux instead reports whichever pane the server considers active,
  which would let a non-tmux pi record itself in an unrelated agent's pane.
- `livePanes()` answers "which panes exist on this host", which is server-wide
  and correct from anywhere. `export` runs over ssh with no pane of its own and
  still has to see the panes.

`livePanes()` returns `null` for "could not tell", which is deliberately
distinct from an empty set, and `reconcileLocal` treats `null` as no evidence
and writes nothing. Conflating them deletes every agent on the host the moment
tmux is unreachable.

The rule binds the JUMP as well as reconciliation, and that took two goes to
learn. A local jump asks `livePanes()`, and the remote probe is `tmux list-panes
-a -F '#{pane_id}'` — not `list-windows`, because no answer about windows can
say whether a pane exists. Asking about windows there condemned healthy agents
on one keypress. **A failed jump now mutates nothing**: it returns a
`JumpResult` with a reason and a message, and `pane_gone` is a report rather
than a deletion. That is the same single-writer rule one level down — the jump
runs on the reader, and only the owning node may retire a pane.

The remote jump inherits the tmux requirement, since it is `ssh -t <host> tmux
attach`. tmux must be running on the far side, which is why a dead remote tmux
server gets its own diagnosis rather than being reported as an unreachable host.

The brands (`src/ids.ts`) are phantom types on `string`, so they cost nothing at
runtime and are applied at the edges: `asPaneId` and friends are called where a
bare string arrives — argv, a tmux query, the wire — and everything inside deals
in branded values. What that prevented was the mix-up that deleted ten live
agents: comparing a `WindowId` against a set of pane ids is a compile error.

What it does NOT buy, since that bounds how far the types can be trusted: both
jump paths once compared a `WindowId` against a `Set<WindowId>`, which is
internally coherent and compiles cleanly. Branding stops you MIXING the three
ids; it cannot stop you asking the wrong one a question. A type system polices
which noun you passed, never whether the question was worth asking. Only a test
that moves a pane out from under a recorded window catches that.

The badge also has to be cleared from outside, which is why `murmur clear --pane
<id>` exists and why tmux hooks call it. The status bar and the picker read a
tmux window option, so it outlives the agent unless something clears it — and
the agent cannot, because "you looked at it" is an event only the multiplexer
sees. Hooks run in the tmux server with no `$TMUX_PANE`, so the pane id is
passed explicitly: the badge belongs to the window, the looking belongs to one
pane.

## The units

| Unit | Does | Depends on |
| ---- | ---- | ---------- |
| `identity` | Read/create this node's `{host_id, display_name}` | state dir |
| `store` | Claim, report, reconcile, cache. **The only module touching SQL** | `identity` (as a parameter) |
| `snapshot` | **Pure.** `parseSnapshot`: validate one document, totally | nothing |
| `view` | **Pure.** `SnapshotPane[]` in, `PaneView[]` out | `store` (types) |
| `channel` | Seam: `exec(target, argv) -> stdout`. One impl: ssh | OS |
| `collector` | Fetch each peer, validate, replace its cache whole | `channel`, `store` |
| `mux` | Seam: window/pane queries, badge, attach. One impl: tmux | OS |

`view` and `snapshot` being pure and `store` being the only SQL is the boundary
that carries the design. All three are testable without a machine, a network or
a multiplexer.

**One local read.** `Store.localPanes()` is the only way to read local state,
and it returns `SnapshotPane[]` — the same shape a peer's cached snapshot holds.
So `paneViews` maps one type to `PaneView` exactly once, and a local pane and a
remote pane travel the same code path, differing only in the `host_id`, `local`
and freshness fields the caller supplies. There is no `agentForPane`, no
`attentionFor`, no `agents()`: it was the proliferation of narrow reads that let
`clear` and the extension each derive their own idea of what a pane's state was,
across fourteen sites and six shipped bugs.

`owner_pid` is not in that shape. It is local-only, never in a snapshot and
never on the wire, which makes remote liveness inference *unrepresentable*
rather than discouraged. A remote pid names a process in another machine's table.

The `Store` interface is closed, and adding a method is a contract change. Some
shapes are forbidden outright, each because it once let a writer say something
it had no standing to say: anything that takes a row and writes it (`append`,
`ingest`, `put`), any log read, any partial-row or column-map update, any
activity write keyed on pane alone rather than on `agent_id` plus `owner_pid`,
any attention method that accepts an agent field, and any escape hatch exposing
the database handle.

Two seams exist with exactly one implementation each: `channel` (ssh) and `mux`
(tmux). Defined so a second backend is possible; not designed for one that does
not exist. The harness is not a third: pi reports in-process through the
extension, and every other harness comes in through `murmur notify`, which is a
command rather than an interface to implement.

## The data model

Three tables in `state.db`, all `STRICT`, `user_version = 3`. `agents` and
`attention` are local truth; `peers` is a cache of other nodes.

```sql
CREATE TABLE agents (
  agent_id     TEXT    NOT NULL PRIMARY KEY,   -- a UUID per process instance
  pane         TEXT    NOT NULL UNIQUE,        -- the address
  owner_pid    INTEGER NOT NULL CHECK (owner_pid > 0),
  activity     TEXT    NOT NULL CHECK (activity IN ('running', 'stopped')),
  session      TEXT    NOT NULL,               -- location, may change
  window       TEXT    NOT NULL,
  session_name TEXT, window_name TEXT,
  agent_name   TEXT, pi_session TEXT, workstream TEXT, role TEXT,
  cli          TEXT    NOT NULL,
  driver       TEXT    NOT NULL CHECK (driver IN ('human', 'orchestrated')),
  claimed_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE attention (
  pane         TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('done', 'blocked', 'crashed')),
  message      TEXT    NOT NULL,
  source       TEXT    NOT NULL,
  session      TEXT    NOT NULL,               -- its own location: see below
  window       TEXT    NOT NULL,
  session_name TEXT, window_name TEXT,
  requested_at INTEGER NOT NULL,
  PRIMARY KEY (pane, kind)
) STRICT;

CREATE TABLE peers (
  name TEXT NOT NULL PRIMARY KEY, target TEXT NOT NULL,
  host_id TEXT, display_name TEXT,
  snapshot TEXT, snapshot_at INTEGER,          -- the whole document, their clock
  fetched_at INTEGER, last_attempt_at INTEGER, last_error TEXT,
  murmur_version TEXT, snapshot_version INTEGER
) STRICT;
```

Schema facts that are load-bearing, and the reason each is in the schema rather
than in a comment:

1. **`agents.pane` is `UNIQUE`.** "One top-level instrumented agent per pane" is
   enforced by SQLite, not by a caller.
2. **`agents.agent_id` is a UUID, not `host:pane`.** A replacement owner is a
   different row, so a late write from the previous owner matches nothing and is
   silently ineffective rather than destructive.
3. **`owner_pid` is local-only**, per the previous section.
4. **`attention` has no `agent_id` and no `owner_pid` column.** An attention
   writer structurally cannot address an agent's identity, activity or metadata.
   This is the whole fix for the live-corruption incident described above.
5. **`PRIMARY KEY (pane, kind)`.** Kinds coexist: a `crashed` row is not
   clobbered by a later `blocked`, and "focus clears all attention for the pane"
   is one `DELETE ... WHERE pane = ?`.
6. **`attention` carries its own location.** An attention-only pane — a codex
   agent murmur never instrumented — is listable and jumpable with no agent row.
   `attention.pane` deliberately does not reference `agents.pane`; a constraint
   saying otherwise would make that case unrepresentable.
7. **`peers.snapshot` is one TEXT column** holding the validated document.
   Whole-peer atomic replacement is therefore structural: there is no partial
   apply to get wrong.
8. **`CHECK` constraints on `activity`, `driver`, `kind`.** An unknown value
   cannot reach storage, so no sort, count or render path needs a fallback
   branch. An unknown state that sorted as `NaN` was a real bug.

No index beyond the declared keys: both local tables are bounded by the number
of live panes on one machine.

**Who writes each fact**, since "it is in the enum" is not the same as
"something produces it" — `blocked` sat in an enum unproduced for months while
three surfaces carried machinery for it:

| Fact | Written by | On |
| --- | --- | --- |
| `activity = running` | pi extension | `agent_start` |
| `activity = stopped` | pi extension | `agent_end` |
| attention `done` | pi extension | `agent_settled`, pane unfocused, `driver = human` |
| attention `blocked` | `murmur notify` | an outside-in call from another harness |
| attention `crashed` | `reconcileLocal` | pane alive, owner pid gone, activity was `running` |
| (row removed) | `releaseAgent` | `session_shutdown` |
| (attention removed) | `acknowledgePane` | `murmur clear`, i.e. tmux focus |

Nothing writes `crashed` from inside an agent, for the obvious reason.

**Versioning is one strategy, not two.** On open, if `user_version` is not 3,
murmur salvages `SELECT name, target FROM peers` — the two fields a human typed
— deletes the database and its `-wal`/`-shm` sidecars, recreates the schema, and
re-inserts those peers with every observed column `NULL`. There is no
`ALTER TABLE` anywhere and no additive path to forget to use. Any change to any
table bumps the version and costs a rebuild, which is affordable precisely
because nothing here is history: everything in the file is either current state
or a cache.

**Identity is never minted by the store.** `openStore()` takes no arguments and
does not read `identity.json`. `createIdentity` is called only by `murmur init`;
`setDisplayName` backs `murmur init --name` on an existing node and keeps its
`host_id`. Every command that needs a `host_id` — `export`, `collect`, `status`,
`pick`, `doctor` — calls `loadIdentity()` and fails with `murmur is not
initialised on this node; run: murmur init`. A node that came into existence as a
side effect of a status-bar tick has an identity nobody chose. `peer` reads
identity opportunistically instead: `peer add` uses it only to refuse adding this
node to itself, so an uninitialised node can still configure peers and that
refusal is best effort.

`notify` and `clear` are absent from that list as a consequence of the model
rather than as an exemption: both address a pane, and `attention` is keyed on
pane alone, so neither reads `identity.json` and neither can fail for want of an
identity.

**Transactions.** `claimAgent` and `reconcileLocal` are `IMMEDIATE`: both read
then write, and a deferred transaction would start as a reader and fail
`SQLITE_BUSY_SNAPSHOT` on upgrade — measured at 5 of 8 concurrent writers
failing. Everything else is a single statement, atomic by construction.
`localPanes` is a deferred read transaction, so a pane cannot appear with an
agent and without the attention that was there when the agent was read.
`buildLocalSnapshot` is two transactions rather than one, because a write
transaction held open across the read would serialise every focus hook on the
machine behind an export.

Deliberately absent from the model: a generic `put`/`del` op-log (that needs
conflict resolution, which single-writer partitioning lets us skip, and it would
simply *be* `mu`), task/DAG structure (observing a task graph means owning it),
and any hybrid logical clock (nothing depends on cross-node causality; clock
skew affects display order only).

**TypeScript, on install-story grounds.** pi is an npm package, so every node
running agents already has Node and npm. Python would mean inventing a
cross-machine install story for the ecosystem that handles it worst, on machines
where the system interpreter is least yours to touch.

## The snapshot

`murmur export` takes no options and prints one complete document. There is no
`--since`, no watermark, no delta form and no JSONL.

```jsonc
{
  "murmur_snapshot": 1,
  "host_id": "1d2ee96e-3a94-41b2-90fa-5f1ee2f04276",  // from identity.json
  "display_name": "mtrojer-mac",
  "murmur_version": "0.2.2",         // read from package.json, never restated
  "generated_at": 1788105698997,     // this node's clock at build time
  "panes": [
    {
      "pane": "%250",
      "session": "$25",
      "window": "@75",
      "session_name": "hacking/murmur",
      "window_name": "worker-1",
      "agent": {
        "agent_id": "c0ffee00-1111-2222-3333-444444444444",
        "activity": "running",
        "agent_name": "worker-1",
        "pi_session": null,
        "workstream": "murmur",
        "role": null,
        "cli": "pi",
        "driver": "orchestrated",
        "claimed_at": 1788105600000,
        "updated_at": 1788105690000
      },
      "attention": [
        { "kind": "blocked", "message": "needs input", "source": "codex",
          "requested_at": 1788105680000 }
      ]
    }
  ]
}
```

Rules, each of which a reader depends on:

1. **The document is complete, so absence is absence.** A peer that answers has
   said everything it knows, and a pane present in the previous fetch and
   missing from this one is gone. This is what makes whole replacement correct.
2. `owner_pid` is absent, on purpose. A reader has no pid to probe.
3. A pane with `"agent": null` is an attention-only pane: valid, listable,
   jumpable. A pane with `"agent": null` and `"attention": []` is not emitted.
4. `panes` order is presentation-only. Emitted sorted by pane id so the output
   diffs cleanly; readers sort for themselves.
5. `generated_at` is the *producing* node's clock. What it is not is when the
   reader fetched it — see freshness below.

`buildLocalSnapshot` reconciles before it reads, which is what makes the
document authoritative: a snapshot built from unreconciled rows would publish
agents whose panes are gone, and a reader has no way to tell.

**Validation is total and strict**, and happens before storage.
`parseSnapshot` rejects an unknown key, a missing key, a wrong type, a
`murmur_snapshot` other than `1`, an unknown `activity`, `driver` or `kind`, a
duplicate pane, and a pane that is neither an agent nor an attention. Nothing is
coerced, defaulted or carried through. The error names the first failing path
(`panes[3].attention[0].kind`), and the collector turns it into a failed fetch:
a peer that answers with a bad document is **reachable but broken** and visibly
so, not silently stale.

**Forward compatibility is not offered**, and that is the honest report rather
than a shortcut. A higher `murmur_snapshot` is rejected like any other wrong
value, because a reader that carried fields it did not understand would be
guessing about state a human acts on. A version mismatch is an operator-visible
pairing problem: upgrade the other node.

### Collecting

Per peer, independently, in a bounded pool (`MAX_CONCURRENT_PEERS = 8`) under a
whole-collect deadline (`COLLECT_DEADLINE_MS = 4000`, sized under a tmux
status-bar tick):

1. `ssh <target> murmur export` — one round trip, no arguments. There is never a
   second "refetch from zero" trip, because there is no watermark to be wrong.
2. `parseSnapshot(stdout)`.
3. `replacePeerSnapshot(name, {ok: true, snapshot, at: now})`, which takes
   `host_id`, `display_name`, `murmur_version` and `snapshot_version` out of the
   document itself. The caller passes no metadata alongside it, so the cache
   cannot disagree with the snapshot it holds.

Any failure at any step replaces nothing: `last_attempt_at` and `last_error` are
set, the previous snapshot stands verbatim, and the peer ages into `stale` on its
own. There is no third outcome and no path that writes part of a document.

Concurrency is about the unreachable peers, not the reachable ones. A sleeping
laptop holds a forked ssh client for the full connect timeout, and a serial loop
charged that to every peer behind it: three asleep laptops froze the status bar
for thirty seconds.

`collect` also calls `reconcileLocal` once per invocation, including with zero
peers. That is the only housekeeping left, and it lives here rather than on
`export` because `export` only runs when a peer asks, so a single-machine node
would otherwise reconcile never.

### Reconciliation

`reconcileLocal` is the only thing that retires local rows. It consults each
pane and each owner pid once:

| Pane live? | Owner pid alive? | `activity` | Action |
| --- | --- | --- | --- |
| no | — | — | delete the agent row and all attention for the pane |
| yes | yes | — | nothing |
| yes | no | `running` | set `stopped`, upsert `crashed` attention |
| yes | no | `stopped`, pane already `crashed` | nothing: the row says *which* agent died |
| yes | no | `stopped`, no `crashed` row | delete the agent row, **keep** attention |

Then, unconditionally, attention for any pane that no longer exists is deleted —
which is what reaps an attention-only pane whose window was closed.

The asymmetry in the last three rows is the point. A dead *running* owner is an
unreported crash and must leave a durable trace; a dead *stopped* owner finished
normally, so its row is noise, but a `done` it raised is a fact a human has not
yet seen. For the same reason `releaseAgent` deletes the agent row and not its
attention: completion must survive the process exiting.

The two `stopped` rows are one distinction, and the split is load-bearing rather
than pedantic. The crash path sets `activity = stopped` before it raises the
attention, so a literal reading of a single `stopped` row would have the *second*
reconcile delete the row the first had just marked — stripping `agent_name`,
`workstream`, `role` and `cli` one tick after the crash, which is exactly the
information saying which agent died, and breaking the idempotence claimed below.
The `crashed` attention is what tells an owner that finished from one that died
mid-run, so it is the right thing to key on.

`requested_at` is never updated by a repeat, so re-reconciling changes nothing —
crash attention is idempotent for free, and age keeps meaning "how long this has
gone unmet".

The liveness probe **fails closed**. `pidAlive` reports death only on `ESRCH`,
so a probe that cannot answer (`EPERM`) reads as alive. An unknown must never
let a second writer displace a possibly-live owner, and must never manufacture a
crash.

## The view

`paneViews(store, identity, now)` builds `PaneView[]` from `store.localPanes()`
and each cached peer snapshot, through one mapping function. `renderState`
picks one word, `viewSort` orders the list, and `RENDER_PRIORITY` is the single
ordering table both the status bar and the picker import rather than restating.

`identity` is required and non-null, because every caller is a command that
already fails without one. Optional-chaining it is what previously classed every
row as remote — including local ones — whenever identity was absent.

### State and freshness are different axes, and the ages are two

`stale` is not a state. It is a property of a NODE.

- **Local views are always fresh.** We are the node that authored them.
- **A remote view takes the freshness of its node**: `fresh` when
  `now - fetched_at <= STALENESS_MS` (60s), else `stale`. A peer never reached
  is stale, not fresh — `null` means the first collect has not succeeded yet, and
  an unreachable host you just added must not read as up to date.
- **Freshness is never per agent, and no liveness is inferred for a remote
  pane.** A stale node keeps its last-known fields verbatim, beside an explicit
  "stale host" flag. That is the honest presentation: the fields are real, they
  are simply old, and hiding them would lose the only information available.

Two clocks, and collapsing them shipped a bug where a dead host's agents
rendered as live, because the *replica* really was current:

| | asks | answers |
| --- | --- | --- |
| `fetched_at` (our clock) | how current is my copy | is the host reachable |
| `updated_at` (their clock) | how old is this pane's news | is the row worth believing |

`snapshot_at` is the third and belongs to the peer too: when that node *built*
the document. A peer polled one second ago can be serving a three-hour-old
fact, so `peer list` and `status --json` report both, and the picker shows the
pane's own age rather than ours.

`age()` and `freshness()` are the only two places a duration becomes text or a
verdict.

### Facts only the owner can know are recorded by the owner

Pids, pane liveness and window names mean something only on the machine that
owns them, so reconciliation runs on the owning node and the results travel in
its snapshot.

Do it on the reader and every remote `running` pane is marked `crashed`, which
looks exactly like a real crash and so goes uninvestigated. This is the easiest
thing in the codebase to get backwards, and the model now makes it impossible
rather than merely inadvisable: the reader holds no pid to probe.

The same rule gives names their home. Window ids are machine-local, so resolving
a remote id against the local tmux would label an agent with whatever *this*
machine has at that id. Names travel in the snapshot instead.

### `clear` may only cancel a request for attention

`murmur clear --pane` runs from tmux focus hooks, so the single fact it knows is
*the user looked at this pane*. Its only WRITE to murmur state is one `DELETE
FROM attention WHERE pane = ?`, so a focus hook structurally cannot mutate an
agent row — no activity, no identity, no owner metadata. It does read local
panes once, to recompute the window badge from what the window's other panes are
doing.

There is no state focus must refuse to clear, because attention is the only
thing focus can address. That whole class of bug — a whitelist, a resolver call,
a metadata copy-forward, and the reasoning about which states were clearable —
is deleted along with the ability to get it wrong. It was the worst bug found
here: 50 of 84 turns on one agent were cleared within a minute of starting,
because switching back to a pane wiped the state of the agent running in it.

The badge is a window option while "you looked" is true of one pane, so `clear`
keeps the badge lit when another pane in the same window still wants attention.
The badge is recomputed from attention AND activity, so a busy agent next door
keeps the window showing `running` rather than going dark; `idle` is the one
state never painted, since it is the absence of a signal. It fails safe by keeping the badge — wrongly
keeping one is recoverable by focusing the pane, wrongly clearing one loses the
signal — and it is silent and total, because it runs inside the tmux server.

### The single-machine case is the same code path

murmur replaced a 1500-line script that was the daily local tool. Zero peers is
therefore the common case:

- the extension claims its pane and reports activity
- the status bar and picker read `localPanes()` through the same mapping a peer
  snapshot goes through
- the collector iterates the peer list, finds nothing, and reconciles once

No network, no ssh, no daemon, no added latency. Federation is strictly
additive: a loop over an empty array. Measured first paint with zero peers:
~50 ms, against 250 ms for the picker it replaces.

This is a constraint, not an observation. A tool that only pays for itself at
three nodes charges rent daily for capability used occasionally — one of the
things herdr was rejected for.

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

**A node being down is the common case, so nothing routine reports it.** A fleet
normally has a laptop asleep and a box switched off. The collector used to write
two lines of ssh diagnostics per failed peer, and it runs from `murmur status`
on every status-bar tick and from `murmur pick` inside a display-popup — so one
sleeping node wrote to stderr several times a minute, forever, and into a UI.

Failures now travel in `collect`'s return value. `murmur collect`, which a human
runs on purpose, is the only thing that prints, and it distinguishes unreachable
(expected, exit 0) from reachable-but-broken (an invalid snapshot, a missing
binary, an auth failure; exit 1). `Permission denied` is deliberately classed as
reachable-but-broken: an auth misconfiguration is an operator task, not a
sleeping laptop, and calling it "asleep, probably" is how a fixable setup error
stays invisible for weeks. Errors are normalised once, where they are caught, so
`peer list`, `status --json` and any SDK consumer get the diagnosis rather than
140 characters of murmur's own ssh invocation.

**Membership is local and asymmetric.** No shared node list, no registry, no
join protocol. Reachability is not symmetric: a laptop reaches a server, and the
server does not reach a laptop behind NAT that sleeps. A global list would
advertise peers half the fleet cannot use. And nothing needs one: only a node
rendering a picker needs targets, and only ones it can reach. Identity is
*discovered* — config holds an ssh target, and the first export returns the
node's `host_id` and display name, which `peer add` records immediately rather
than throwing away.

Asymmetry is design with an unreported consequence: **if B does not peer A, B's
picker cannot see A's agents, and no local surface can say so.** From A
everything reads healthy, because from A it is.

`murmur doctor` surveys each peer over ssh and reports it. Two calls per peer —
`murmur export` for the `host_id`, `murmur peer list --json` for the roster —
because a snapshot structurally cannot carry a roster (below) and `peer list`
carries no `host_id`. Identity is compared on `host_id` only: names are local
handles and `hostname` can be a container id, so comparing by name would report
naming drift as asymmetry and miss genuine duplicates.

Asymmetry is *reported*, never called a fault, and exits 0. Flagging the normal
case — the laptop and the NAT'd server above — would train the operator to ignore
the command. Only a duplicate `host_id` and a snapshot-version mismatch are
problems, because both are murmur behaving provably wrongly. Skew is not
recomputed: `doctor` calls the same `versionCell` `peer list` uses.

"Island" is scoped to one hop and says so: *no peer that this node surveyed peers
this host*, not "no node in the fleet". `doctor` asks its own peers and stops —
multi-hop survey is a crawler, needing loop detection, a depth bound and a story
for a node reachable from B but not from here, all to report on machines this
node cannot fix anyway.

`doctor --topology` adds the fact hub advice needs and murmur otherwise lacks:
who can reach whom. One `ssh A "ssh B true"` per ordered pair — a bare `true`, so
it measures transport alone, since "unreachable" and "reachable but murmur
missing" have different fixes.

Which node *can* hub is then a set intersection over the matrix, not a
preference. A spoke counts only when reachability is proven in **both**
directions, since the spoke collects from the hub and the hub from the spoke.
When no node qualifies, nothing is recommended and the partition is reported.

Measured while building it: on the author's fleet two peers reach nothing, no
peer can resolve this node's own display name, and no whole-fleet hub exists. A
recommendation would have been wrong.

A failed probe is not a negative. It becomes `unreachable` only when the target
is demonstrably up — it answered this node's survey seconds earlier — and
otherwise it is `unknown`, because a firewall and a sleeping laptop are
indistinguishable from one dial and hub advice built on the confusion would flip
between runs as machines sleep. Nothing a survey learns is written to the store:
it is a diagnostic that reaches out, not state murmur caches, and caching it
would make `peer list` report facts no collect established.

**The snapshot carries no peer roster, deliberately.** Publishing one would be
the obvious way to make the fleet self-describing, and it is refused: a snapshot's
contract is "my panes, complete and authoritative", which is exactly what makes
"absent from a snapshot means absent" true. A roster is neither complete nor
authoritative — it is one node's local configuration, and its truth lives on the
node being described rather than the one describing. Putting membership into that
document would also make every membership question a format question, needing a
version bump and a coordinated fleet upgrade, which is a heavy price so soon
after 0.2.1 given that `parseSnapshot` rejects a mismatched version outright.
Surveying over ssh needs no format change and no fleet-wide upgrade, and it is
honest about what it is: a question asked now, not a fact murmur stores.

**Only `collect` could ever be relayed, which is why there is no broker.** Three
surfaces need a path to a pane's host, and they are not alike:

| surface | needs |
|---|---|
| collect | `ssh <target> murmur export` |
| glance (the picker's preview) | `ssh <target> tmux capture-pane` |
| jump | `ssh <target>`, interactively |

Glance and jump are inherently point-to-point: a captured pane and an interactive
session cannot be served by a third party holding neither. So a relay could only
deduplicate `collect` — and `collect` is the cheap one, ~400 bytes per pane and
~1.2KB per snapshot, measured.

A broker would therefore dedupe the cheapest of the three, leave both interactive
paths untouched, and add a daemon, a port and a second auth story to do it. That
is why gossip and a NATS-style bus lost: they address payload, and payload was
never the problem. The cost was one forked ssh per peer per repaint, fixed by
throttling — see the collect floor in limitation 3.

**Zero knobs.** Every exported setting is one the user can get wrong invisibly.
Two are irreducible: `peers` (only the operator knows their fleet) and `theme`.
Collection concurrency, deadlines and the staleness threshold are constants. The
trade: a wrong constant needs a release, not an edit. Heuristics replace knobs,
so heuristics are where the tests go.

**`driver` distinguishes who is waiting.** An agent you are talking to and an
agent an orchestrator placed want opposite treatment: when the orchestrated one
finishes, its supervisor consumes the result and nobody needs to acknowledge
anything. Same facts, opposite attention. So an orchestrated agent raises no
`done` at all, and its rows are hidden from the picker and the status bar unless
its attention includes `blocked` or `crashed` — the two kinds only a human can
answer. That list is `NEEDS_HUMAN`, shared by both surfaces, because it was two
literals in two files and that is how a row needing a human became one a human
could not see.

It is per *agent*, not per node, because the normal case is one machine running
your session and six spawned workers at once.

**Glance, not remote rendering.** "Render any pane from the master" hides two
different problems: a stateless `capture-pane` (cheap, and what the preview
does) and continuous frame streaming with resize negotiation and input routing
(most of herdr's codebase). Glance plus jump gets everything except never
leaving the local frame, and you are jumping there to work anyway. This
deferral is the main reason murmur is small.

## Why not something else

Version numbers and roadmap status are deliberately absent here: they were true
on the day they were checked and are the first thing to rot. What follows is the
structural difference, which does not move.

**Terminal multiplexers built for agents** (herdr and similar) own the panes and
infer state by matching terminal output. Two consequences: every machine must run
that multiplexer, which is not a choice you always have, and state is scraped
rather than reported. murmur takes tmux as given and has the agent report from
inside its own process.

**Harness control surfaces** (T3 Code and similar) run a server that owns agent
sessions, with clients over RPC. Their remote *access* is strong. The structural
cost is the adapter: driving an agent you do not live inside needs a per-harness
driver, where murmur's extension runs in-process and calls the store directly.

**Orchestrators** (`mu`) place work and replicate writes from many nodes, so they
need an op-log, watermarks and conflict resolution. murmur observes and never
places work, so single-writer-per-node caching removes all of it. **murmur
observes, mu orchestrates.** Merging is plausible — murmur would give mu global
agent addressing — but remote orchestration is a much harder problem than remote
observation, and it is not murmur's.

Taken from these tools, and worth stating because each is load-bearing above:
integration installs that write hooks into each agent's own config (`murmur link
pi`); reusing one authenticated connection; remoteness expressed at the
connection layer rather than by splitting the runtime; identity as a stable UUID
rather than a hostname; and ambient sync with no daemon, where every invocation
syncs before the verb and no watcher outlives the command.

Deliberately not taken: a generic replicated KV. A generic op-log needs conflict
resolution, which single-writer caching skips entirely, and a murmur with
`put`/`del` over arbitrary entities would just *be* mu.

## The extension's lifecycle assumptions

The extension is the only part of murmur that lives inside another program's
process, and every bug in it has come from assuming that process is simpler than
it is.

At load, in order, stopping at the first failure: resolve the pane, load the
identity (never mint one), open the store, and `claimAgent`. Then:

| Outcome | Meaning | What the extension does |
| --- | --- | --- |
| `claimed` | the pane had no owner | keep the `agent_id`, register handlers |
| `retained` | same pid re-claiming | keep the same `agent_id` and activity |
| `replaced` | previous owner is dead | fresh `agent_id`; the old occupant's attention is cleared |
| `refused` | another live process owns the pane | register nothing, paint nothing, close the store |

`retained` is what makes pi's `/reload` a no-op: pi re-runs the extension
factory in the same process, and a check that could not recognise its own claim
would silence the real agent. `refused` is permanent for the process — a nested
agent is deliberately invisible, and it is checked at both the store call and
the badge, because the badge is painted from the same handler that reports.

`replaced` clears the previous occupant's attention because that attention
described a process that is gone, and a human looking at the pane now sees a
different agent.

Handlers are serialised through a single-slot promise chain. `activity` is
last-write-wins, so an inverted `start`/`end` pair would leave a finished agent
`running`.

`setActivity` returning `false` is not an error and is not retried: it means
this process is no longer the owner of record, and the correct response is
silence. The badge is gated on that boolean, so a process that cannot report
cannot paint either.

Three assumptions that were wrong, all of which failed silently:

- **`session_shutdown` is not "the process is exiting".** pi fires it for
  `/reload`, session switch, resume and fork, then rebinds and continues with the
  same instance. Cleanup belongs there; re-arming belongs in `session_start`,
  which fires afterwards. Treating shutdown as terminal stopped reporting
  permanently on the first `/reload`.
- **`agent_end` is per RUN, and is not the end of the work.** `turn_start` /
  `turn_end` are the per-turn events; one prompt with three tool calls fires one
  `agent_start`, three `turn_end`, one `agent_end`. But `agent_end` can fire
  several times before the agent is finished, because pi re-enters the loop for a
  retry, a compaction or a queued continuation, each with its own `agent_start`.
  So `start, end, start, end, settled` is a normal sequence, and a single
  `agent_end` cannot mean "waiting for a human". `agent_settled` is the event
  that means it: fired once, last. Listening to the wrong event is why the
  highest-attention state in the model had no producer for months.
- **The pane outlives the window.** A pane can move between windows, keeping its
  id while the window id changes, so the location is re-read on every report
  rather than cached at startup, and a move hands the badge over to the new
  window.

The store handle has three states — `untried`, `open`, `absent` — because those
are three real situations. Collapsing them is what previously latched reporting
off for the life of a process after one transient failure.

The general rule: nothing in the extension may be permanent except "murmur is
not installed here" and "this pane is not mine". Every other giving-up must be
recoverable by the next event, because the process it lives in can run for days
and the user can fix the cause from outside without restarting it.

## Testing posture

Bug-driven, not coverage-driven. A thing earns a test when it can fail *without
you noticing*. `npm test` prints the current size — stating it here has drifted
twice, since every commit that earns a test invalidates it — and the ones that matter
assert what is **impossible** rather than what is implemented:

| Target | Why it can fail silently |
| ------ | ------------------------ |
| A notifier cannot touch an agent row | The corruption it caused looked like a state change |
| `acknowledgePane` cannot change activity | A focus hook wiping a busy agent reads as the agent stopping |
| A second live claimant is refused | A nested run reporting looks like the real agent misbehaving |
| A replaced owner's writes return false | A late write from a dead process corrupts a live row |
| Reconciliation asymmetry | An idle agent vanishing reads as "not there" |
| Whole-snapshot replacement | A pane that should be gone lingers forever |
| Validation before storage | An unknown value reaching a sort or a count |
| No `owner_pid` on any read path | Remote liveness inference creeping back in |
| Freshness derivation | A dead peer showing last-known state as current |
| Jump failure mutating nothing | A keypress deleting a healthy agent |

Several of those are asserted structurally — over the whole returned object
graph, not by reading the type — because a type says what the author intended
and a test says what the object contains.

Not tested: ssh transport (OpenSSH's job), tmux wrappers (thin and loud), TUI
rendering, packaging.

New tests are verified by breaking the code they cover and watching them fail. A
test that has never failed has not been shown to test anything. A test asserting
a *wrong* behaviour has been written twice here, so this step is not ceremony.

Three trap shapes this caught, all in tests rather than code. A `setTimeout(0)`
standing in for a barrier passed about nine runs in ten — worse than a failing
test, because it teaches people to re-run. A `until()` helper that threw on
timeout made a mutation "pass", because the regression died inside the helper
instead of at the assertion describing it. And `expect(output).not.toContain(n)`
over a live number passes for the wrong reason as soon as `n` changes; asserting
over a closed key set is strictly better, and this appeared three separate
times.

Tests must not touch the developer's own state. `stateDir()` is repointed for
every test process, in-process and spawned, and no test addresses the caller's
`$TMUX_PANE`. This is guarded by a test of its own, because it is not
hypothetical: writing the rewrite contract required one `npm run check` to
confirm the tree was green, and that run corrupted the author's live state for
the pane it was running in — the third independent reproduction of the same bug.

Where a fake is the test's weak point, the test talks to the real thing.
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
- history of any kind: an event log, a state timeline, an audit trail
- interactive remote terminal rendering
- orchestration or work placement
- a generic put/del op-log
- HLC or clock reconciliation
- gossip replication
- configuration knobs beyond peers and theme
- multiplexers other than tmux, channels other than ssh
- an in-process integration for any harness other than pi. `murmur notify` is
  the outside-in path for the rest, and it is not the same thing: a harness that
  can only run a command when something happens can ask for attention, but
  cannot report activity or ownership.

## Accepted limitations

These are design, not surprise. Each is a consequence of the model above, and
each was cheaper to accept than to solve:

1. **No history.** Only current state is stored. There is no event log, no
   retention horizon, and no way to ask what an agent was doing an hour ago. The
   picker's preview is a live `capture-pane`, not a replay.
2. **No compatibility with older nodes.** A pre-rewrite `events.db` is not
   migrated, and any `state.db` from a different `user_version` is rebuilt with
   only peer names and targets salvaged. A node serving the old event format is
   reported as reachable-but-broken, which is the honest description: the two
   cannot federate.
3. **No incremental sync.** Every collect transfers each peer's whole snapshot,
   so it is O(panes) rather than O(changes) — bounded by live pane count, and
   small in absolute terms: ~400 bytes per pane and ~1.2KB for a whole snapshot,
   measured. It is no longer *per tick*, though, and that was the part that
   mattered. Fetch rate used to be tied to redraw rate, because `murmur status`
   collects and tmux re-runs it every `status-interval`; the cost is quadratic in
   a mesh and multiplied again per attached client, since the interval fires per
   client. An ambient collect now skips a peer attempted within
   `COLLECT_FLOOR_MS` ± `COLLECT_JITTER_MS / 2` (30s ± 10s), measured at 1.08s →
   0.05s for `murmur status` against four real peers. Keyed on
   `last_attempt_at`, not `fetched_at`: the expensive peer is the one that does
   *not* answer, since it holds a forked ssh until `ConnectTimeout`, and keying
   on success would exempt exactly the sleeping laptops the floor exists to stop
   hammering. The jitter is drawn per peer per call and is what stops the floor
   becoming a synchroniser — a bare floor makes a fleet converge on hitting one
   machine in the same instant, permanently. A floor is passed by the two
   unattended callers: `murmur status`, which tmux re-runs on a tick, and the
   picker's launch-time background refresh, which runs on every popup open and
   would otherwise fan out ssh per keystroke. The picker itself paints from
   cache and never waits for a collect. `murmur collect` and the picker's `^r`
   are a person asking now, so neither floors — a refresh key that skipped the
   fetch would be a key that silently does nothing.
4. **No nested agents.** A second live process in one pane is refused and
   reports nothing. A pane shows at most one agent.
5. **No remote liveness inference.** `owner_pid` never crosses the wire, so a
   remote pane's `activity` is whatever its own node last said. A stale node
   keeps its last-known values beside a warning, and murmur will not guess.
6. **PID reuse can hide a crash.** If a pane's owner dies and the OS reassigns
   its pid before the next `reconcileLocal`, that owner reads as alive and the
   crash is missed until something else changes. The window is short and the
   failure is temporary; the alternatives (pid start time, cgroups, a watcher)
   each buy a platform dependency for a case measured as rare.
7. **A claim costs a liveness probe, and an unprobeable owner blocks the pane.**
   `claimAgent` fails closed, so a pid that answers `EPERM` refuses the new
   claimant and the pane stays unclaimable until it goes away. Deliberate: the
   alternative is letting a second writer displace a possibly-live owner.
8. **Attention is per pane, not per agent.** A pane whose agent is replaced
   loses the previous occupant's attention, which is intended, and two
   sequential agents in one pane cannot each hold their own `done`.
9. **A peer demanding interactive auth is collectable only while a session is
   open.** Every ssh murmur runs sets `BatchMode=yes`, so a host wanting a
   second factor, a token touch or a password per connection cannot be reached
   unattended — which is the case `SSH_OPTIONS` names as out of scope
   ("never prompt", not "never authenticate") and the reason `hasWarmSocket`
   exists. Such a peer is skipped by ambient collects rather than dialled and
   failed on every tick, keeps its cached snapshot, and is named in the picker
   header with the command that fixes it. That command is `ssh -M -S
   <ControlPath> <host>` and the `-M` is load-bearing: a plain `ssh` attaches as
   a client, or behind a `ProxyCommand` leaves a socket that forwards but has
   never authenticated a session — and `ssh -O check` reports `Master running`
   for both, so `hasWarmSocket` cannot tell them apart. Measured against a real
   2FA host, where every command over such a socket failed with `Session open
   refused by peer`. Eternal Terminal does not substitute either, since it
   bootstraps over ssh and leaves no socket to attach to.

   Two accepted costs. The reminder cannot say *when* a session lapsed, only
   that none exists now. And `hasWarmSocket` answers "is there a master", not
   "can I open a session", so a forward-only socket opens the gate and the
   collect then fails once — self-correcting on the next pass, since that
   failure is itself auth-class, but a real gap between the check and the
   question.

## Known gaps

- **The remote wrapper session is verified against tmux, not against use.**
  Options, the switch, and the return to the origin window are verified on real
  tmux servers with a stub ssh. Sitting in a live remote pane and working in it
  is not.
- **Interactive attach is unverified.** Federation, staleness, snapshot
  replacement and the jump target are verified across two machines over real
  ssh; sitting in a remote pane and working in it is not, and it needs a human
  at a terminal.
- **A deadline-cut peer reports `unreachable: false`.** The message says the
  collect deadline passed, which is accurate and is what every surface prints,
  but the flag reads as "reachable". No surface misreports it today; the flag is
  still the wrong shape for that one case.
- **`peer add` cannot always refuse a self-add.** The refusal keys on the
  `host_id` in the probe's snapshot, so a target that fails to answer is added
  on the operator's word. Correct by design, but best-effort rather than a
  guarantee.
- **The hardware-token path is verified only in the cold-fail direction.** The
  second test node authenticates by key, so it never needed a warm socket.
