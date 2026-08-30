# Current-snapshot rewrite — implementation contract

Status: frozen. Task `rewrite-contract` (workstream `murmur`).
Scope: this document is the contract every downstream `rewrite-*` task
implements. It contains no production code and changes no behaviour by itself.

This is a clean slate in the existing repository. There is no migration, no
wire compatibility, and no adapter layer. Functionality may be reduced where
the reduction removes a class of bug; every such reduction is listed in
[Deleted concepts](#8-deleted-concepts) or
[Accepted limitations](#10-accepted-limitations).

Inputs this contract is derived from: the three audits in workstream
`murmur-model-review` (`core-model`, `ingestion-identity`, `consumers-cli`) and
the approved decisions recorded on `rewrite-contract`.

A note on where this file lives: `.gitignore` excludes `docs/`, with the stated
reason that "a spec that stops matching the code is worse than no spec". That
reason applies to a spec kept *after* the work lands, and it is why `rewrite-docs`
folds the surviving reasoning into `ARCHITECTURE.md` rather than pointing at
this file. This document is tracked anyway, deliberately, because eleven tasks
across multiple sessions implement against it and an untracked contract is one
`git clean` away from gone. It is committed with `git add -f` and it becomes
history, not a maintained document, once `rewrite-current-snapshot` closes.

---

## 1. The model in one page

Three facts, independent, each with exactly one writer:

| Fact | Meaning | Stored as | Written by |
|---|---|---|---|
| **activity** | is a process working in this pane | `agents.activity` = `running` \| `stopped` | the pane's owning process only |
| **attention** | does someone need to look at this pane | rows in `attention`, kind `done` \| `blocked` \| `crashed` | owner (`done`), external notifier (`blocked`), local reconciliation (`crashed`) |
| **freshness** | how recently we reached the node that reported | `peers.fetched_at` | the collector |

They are never folded into one enum. There is no `cleared`: absence of an
attention row *is* "nothing to see", and absence of an agent row *is* "no agent
here".

Identity and address are separated:

- **node identity** — `identity.json`, `{host_id, display_name}`. Created only
  by `murmur init`. Survives a store wipe.
- **agent identity** — a random UUID minted per *process instance* when it
  claims a pane. It is not derived from the pane, so a new process in the same
  pane is a different agent.
- **pane** — the *address*. `UNIQUE` in `agents`, `PRIMARY KEY` component in
  `attention`. One top-level instrumented agent per pane, by construction.

Truth about a node lives only on that node. Other nodes hold one opaque,
validated **snapshot** per peer, replaced whole or not at all.

---

## 2. Files

| Path | Contents after the rewrite |
|---|---|
| `src/types.ts` | `Location`, `Activity`, `AttentionKind`, `Driver`, `AgentMeta`, `AgentRow`, `AttentionRow`, `Snapshot`, `PeerRecord`, request/result types. Imports nothing but `./ids.js` |
| `src/store.ts` | schema, `openStore`, the closed `Store` interface, all SQL |
| `src/snapshot.ts` | `parseSnapshot`, `SnapshotInvalidError`. The `Snapshot` *type* lives in `types.ts`, so `PeerRecord` can name it without a module cycle |
| `src/view.ts` | `PaneView`, `Freshness`, `RenderState`, `RENDER_PRIORITY`, `renderState`, `paneViews`, `viewSort`, `age`, `freshness` |
| `src/identity.ts` | `loadIdentity`, `createIdentity`, `setDisplayName` (no minting on read) |
| `src/collector.ts` | fetch + validate + `replacePeerSnapshot`, per peer |
| `src/status.ts` | `Status`, `status`, `statusWithCollect`, `tmuxStatus` over `PaneView[]` |
| `src/paths.ts` | `stateDir`, `configDir`, `dbPath` → `state.db` |
| `src/cli/*.ts` | unchanged verb set: `init`, `link`, `export`, `collect`, `clear`, `notify`, `peer`, `status`, `pick`. Each is re-pointed at the new store and view; none gains or loses a command |
| `src/ids.ts`, `src/mux.ts`, `src/channel.ts`, `src/agents.ts`, `src/glance.ts` | kept; edited only where they touch deleted types. `Location` moves from `mux.ts` to `types.ts` and every caller imports it from there |
| `src/export.ts` | **deleted**. The three jobs it conflated are separated: `Store.buildLocalSnapshot` produces the document, `src/cli/export.ts` serialises it to stdout, `src/snapshot.ts` validates one on the way in |
| `src/fold.ts` | **deleted**; replaced by `src/view.ts` |
| `src/extension/decide.ts` | keeps `driverFromEnv`, `settledState`; loses ownership machinery |
| `src/extension/murmur-pi.ts` | rewritten against `claimAgent` / `setActivity` / `releaseAgent` |

`dbPath()` returns `<stateDir>/state.db`. `events.db` is not read, not
migrated, and not written. `openStore` deletes `events.db`, `events.db-wal` and
`events.db-shm` if present, best effort, exactly once per open.

---

## 3. SQLite schema

`user_version = 3`. All tables `STRICT`, which requires SQLite 3.37 — satisfied
by the bundled `better-sqlite3`. Pragmas: `journal_mode = WAL`,
`busy_timeout = 5000`.

No foreign keys, so no `foreign_keys` pragma. `attention.pane` deliberately does
**not** reference `agents.pane`: an attention-only pane has no agent row, and a
constraint saying otherwise would make the codex case unrepresentable. The two
tables are joined by pane at read time and reconciled by §5.1's
`reconcileLocal`, never by cascade.

```sql
CREATE TABLE agents (
  agent_id     TEXT    NOT NULL PRIMARY KEY,
  pane         TEXT    NOT NULL UNIQUE,
  owner_pid    INTEGER NOT NULL CHECK (owner_pid > 0),
  activity     TEXT    NOT NULL CHECK (activity IN ('running', 'stopped')),
  session      TEXT    NOT NULL,
  window       TEXT    NOT NULL,
  session_name TEXT,
  window_name  TEXT,
  agent_name   TEXT,
  pi_session   TEXT,
  workstream   TEXT,
  role         TEXT,
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
  session      TEXT    NOT NULL,
  window       TEXT    NOT NULL,
  session_name TEXT,
  window_name  TEXT,
  requested_at INTEGER NOT NULL,
  PRIMARY KEY (pane, kind)
) STRICT;

CREATE TABLE peers (
  name            TEXT    NOT NULL PRIMARY KEY,
  target          TEXT    NOT NULL,
  host_id         TEXT,
  display_name    TEXT,
  snapshot        TEXT,
  snapshot_at     INTEGER,
  fetched_at      INTEGER,
  last_attempt_at INTEGER,
  last_error      TEXT,
  murmur_version   TEXT,
  snapshot_version INTEGER
) STRICT;
```

Schema facts that are load-bearing, and the reason each is in the schema rather
than in a comment:

1. **`agents.pane` is `UNIQUE`.** "One top-level instrumented agent per pane"
   is enforced by SQLite, not by a caller. A second claimant hits a constraint
   or is refused in the same transaction that reads the incumbent.
2. **`agents.agent_id` is a UUID, not `host:pane`.** A replacement owner is a
   different row, so a late write from the previous owner cannot match and is
   silently ineffective rather than destructive.
3. **`owner_pid` is local-only.** It is never in a snapshot and never crosses
   the wire. A remote pid names a process in another machine's table; keeping it
   off the wire makes remote liveness inference unrepresentable.
4. **`attention` has no `agent_id` and no `owner_pid` column.** An attention
   writer structurally cannot address an agent's identity, activity or owner
   metadata. This is the whole fix for the live-store corruption in
   `core-model` F1/F2 and `consumers-cli` finding 1.
5. **`PRIMARY KEY (pane, kind)`.** Kinds coexist: a `crashed` row is not
   clobbered by a later `blocked`, and "focus clears all attention for the
   pane" is one `DELETE ... WHERE pane = ?`.
6. **`attention` carries its own location** (`session`, `window`, and names) so
   an attention-only pane — a codex agent murmur never instrumented — is
   listable and jumpable with no agent row.
7. **`peers.snapshot` is one TEXT column** holding the validated document.
   Whole-peer atomic replacement is therefore structural: there is no partial
   apply to get wrong.
8. **`CHECK` constraints on `activity`, `driver`, `kind`.** An unknown value
   cannot reach storage, so no sort, count or render path needs a fallback
   branch. This replaces the `AgentState | string` type that collapsed to
   `string` (`core-model` F4, `consumers-cli` finding 2).

There is no index beyond the declared keys. Both local tables are bounded by the
number of live panes on one machine; the audits measured full scans of a
multi-thousand-row event table as the cost worth removing, and that table is
gone.

### 3.1 Version handling

One strategy, not two. On open:

1. Read `user_version`. If it equals `3`, proceed.
2. Otherwise salvage `SELECT name, target FROM peers` if that table is readable
   — the two fields a human typed, nothing else.
3. Delete the database file and its `-wal` / `-shm` sidecars.
4. Recreate the schema, set `user_version = 3`, and re-insert the salvaged
   peers with every observed column `NULL` (no snapshot, no `fetched_at`).

No `ALTER TABLE` anywhere. Any change to any table bumps `user_version`. The
dual-strategy fragility in `core-model` F7 is removed by having no additive
path to forget to use.

### 3.2 Identity is never minted by the store

`openStore()` does not call `ensureIdentity` and does not read
`identity.json`. It takes no arguments and returns a `Store`.

- `createIdentity(displayName): NodeIdentity` — only `murmur init` calls it.
  Fails if `identity.json` already exists.
- `setDisplayName(name): NodeIdentity` — `murmur init --name` on an existing
  identity rewrites `display_name` and keeps `host_id`. This closes
  `ingestion-identity` finding 5: `--name` is never silently ignored.
- `loadIdentity(): NodeIdentity | null` — memoized per process. `identity.json`
  cannot change under a running command, and the audit measured 8 redundant
  reads per invocation.

Every command that needs a `host_id` calls `loadIdentity()` and, on `null`,
fails with `murmur is not initialised on this node; run: murmur init`. The
commands that need one are `export`, `collect`, `status`, `pick` and `peer`.

`notify` and `clear` do **not** need one, and that is a consequence of the
model rather than an exemption: both address a pane, and `attention` is keyed on
pane alone. Neither reads `identity.json`, so neither can fail for want of an
identity. Both remain silent and exit 0 on any failure regardless, because both
run inside another program's hook.

---

## 4. TypeScript types

```ts
// src/types.ts
export type Activity = "running" | "stopped";
export type AttentionKind = "done" | "blocked" | "crashed";
export type Driver = "human" | "orchestrated";

/** Where a pane currently lives. Location, never identity. */
export type Location = {
  session: SessionId;
  window: WindowId;
  pane: PaneId;
  session_name: string | null;
  window_name: string | null;
};

/** Owner-reported metadata about the agent in a pane. */
export type AgentMeta = {
  agent_name: string | null;
  pi_session: string | null;
  workstream: string | null;
  role: string | null;
  cli: string;
  driver: Driver;
};

export type AgentRow = AgentMeta & {
  agent_id: string;
  pane: PaneId;
  owner_pid: number;
  activity: Activity;
  session: SessionId;
  window: WindowId;
  session_name: string | null;
  window_name: string | null;
  claimed_at: number;
  updated_at: number;
};

export type AttentionRow = {
  pane: PaneId;
  kind: AttentionKind;
  message: string;
  source: string;
  session: SessionId;
  window: WindowId;
  session_name: string | null;
  window_name: string | null;
  requested_at: number;
};

export type PeerRecord = {
  name: string;
  target: string;
  host_id: string | null;
  display_name: string | null;
  snapshot: Snapshot | null;
  snapshot_at: number | null;
  fetched_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
  murmur_version: string | null;
  /** The peer's `murmur_snapshot` value, i.e. the document version it speaks. */
  snapshot_version: number | null;
};

export type Snapshot = {
  murmur_snapshot: 1;
  host_id: string;
  display_name: string;
  murmur_version: string;
  generated_at: number;
  panes: SnapshotPane[];
};

export type SnapshotPane = {
  pane: PaneId;
  session: SessionId;
  window: WindowId;
  session_name: string | null;
  window_name: string | null;
  agent: SnapshotAgent | null;
  attention: SnapshotAttention[];
};

export type SnapshotAgent = AgentMeta & {
  agent_id: string;
  activity: Activity;
  claimed_at: number;
  updated_at: number;
};

export type SnapshotAttention = {
  kind: AttentionKind;
  message: string;
  source: string;
  requested_at: number;
};

export type LiveCheck = (pid: number) => boolean;
```

Request and result types, one per operation. Each is a closed object type; none
has an index signature, and none is `Partial<Row>`:

```ts
export type AgentClaim = {
  location: Location;
  owner_pid: number;
  meta: AgentMeta;
  now?: number;
  isAlive?: LiveCheck;
};

export type ClaimResult =
  | { outcome: "claimed"; agent_id: string }
  | { outcome: "retained"; agent_id: string }
  | { outcome: "replaced"; agent_id: string; previous_agent_id: string }
  | { outcome: "refused"; held_by_pid: number };

export type ActivityUpdate = {
  agent_id: string;
  owner_pid: number;
  activity: Activity;
  location: Location;
  now?: number;
};

export type AgentRelease = { agent_id: string; owner_pid: number };

/**
 * Everything an attention writer may say. There is no agent_id, no owner_pid,
 * no activity and no owner metadata field, and adding one is a contract change.
 */
export type AttentionRequest = {
  kind: AttentionKind;
  location: Location;
  message: string;
  source: string;
  now?: number;
};

/**
 * The only local facts reconciliation is allowed to consult. Both optional
 * fields default the same way `AgentClaim`'s do: `isAlive` to `pidAlive`, `now`
 * to `Date.now()`. They are parameters so a test needs no process table and no
 * clock control.
 */
export type LocalWorld = {
  /** Live pane ids, or null when tmux could not answer. */
  panes: Set<PaneId> | null;
  isAlive?: LiveCheck;
  now?: number;
};

export type ReconcileSummary = {
  crashed: PaneId[];
  removed: PaneId[];
  attention_removed: PaneId[];
};

export type PeerFetch =
  | { ok: true; snapshot: Snapshot; at: number }
  | { ok: false; error: string; at: number };
```

---

## 5. The `Store` interface

This interface is **closed**. Adding a method is a contract change, and the
generic shapes named in §5.3 are forbidden outright.

```ts
export interface Store {
  // --- agent lifecycle: owner-only, pid-gated -----------------------------
  claimAgent(claim: AgentClaim): ClaimResult;
  setActivity(update: ActivityUpdate): boolean;
  releaseAgent(release: AgentRelease): boolean;

  // --- attention: pane-addressed, no agent authority ----------------------
  requestAttention(request: AttentionRequest): void;
  acknowledgePane(pane: PaneId): number;

  // --- local truth --------------------------------------------------------
  /** The one local read. Joins agents and attention by pane. No reconciliation. */
  localPanes(): SnapshotPane[];
  reconcileLocal(world: LocalWorld): ReconcileSummary;
  buildLocalSnapshot(identity: NodeIdentity, world: LocalWorld): Snapshot;

  // --- peer cache ---------------------------------------------------------
  peers(): PeerRecord[];
  addPeer(name: string, target: string): void;
  removePeer(name: string): boolean;
  replacePeerSnapshot(name: string, fetch: PeerFetch): void;

  close(): void;
}
```

### 5.1 Semantics, exactly

**`claimAgent`** — one `IMMEDIATE` transaction. `now` defaults to `Date.now()`,
`isAlive` to `pidAlive`.

| Incumbent row for `location.pane` | Action | Result |
|---|---|---|
| none | `INSERT` a row: new `randomUUID()`, `activity = 'stopped'`, `claimed_at = updated_at = now` | `claimed` |
| `owner_pid === claim.owner_pid` | `UPDATE` location + `meta` + `updated_at`. `activity` untouched. `agent_id` kept | `retained` |
| different pid, `isAlive(owner_pid)` true | nothing written at all | `refused` |
| different pid, `isAlive(owner_pid)` false | `DELETE` incumbent, `DELETE FROM attention WHERE pane = ?`, `INSERT` a row with a fresh UUID | `replaced` |

- `retained` is what makes pi's `/reload` a no-op: pi re-runs the extension
  factory in the same process, and a check that could not recognise its own
  claim would silence the real agent.
- `refused` is the nested-agent case. It is the *only* answer for a second live
  process in one pane, and it replaces `MURMUR_PANE_OWNER`, `ownsPane` and
  `mayReport` with a database constraint plus one liveness probe. A refused
  caller registers no handlers, opens nothing further, paints no badge.
- `replaced` clears the previous occupant's attention, because that attention
  described a process that is gone and a human looking at the pane now sees a
  different agent.
- `isAlive` **fails closed**: `pidAlive` reports death only on `ESRCH`, so an
  unanswerable probe (`EPERM`) reads as alive and produces `refused`. An
  unknown must never let a second writer displace a possibly-live owner.

**`setActivity`** — one statement:

```sql
UPDATE agents
   SET activity = ?, session = ?, window = ?,
       session_name = ?, window_name = ?, updated_at = ?
 WHERE agent_id = ? AND owner_pid = ?;
```

Returns `changes === 1`. Both key components are required, so a write from a replaced
owner matches nothing and returns `false`. It never touches `attention`, never
touches `AgentMeta`, and cannot create a row.

**`releaseAgent`** — `DELETE FROM agents WHERE agent_id = ? AND owner_pid = ?`.
Returns `changes === 1`. It does **not** delete attention: a `done` raised at
settle must survive the agent exiting, or completion becomes invisible the
moment the process quits.

**`requestAttention`** — one statement:

```sql
INSERT INTO attention (pane, kind, message, source, session, window,
                       session_name, window_name, requested_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (pane, kind) DO UPDATE SET
  message = excluded.message,
  source = excluded.source,
  session = excluded.session,
  window = excluded.window,
  session_name = excluded.session_name,
  window_name = excluded.window_name;
```

`requested_at` is deliberately **not** in the `DO UPDATE` list. Age means "how
long this has gone unmet", so a repeat does not reset the clock — which also
makes crash attention idempotent for free. It touches no `agents` row, ever.

**`acknowledgePane`** — `DELETE FROM attention WHERE pane = ?`, returning the
row count. All kinds, one statement. It touches no `agents` row, so focusing a
pane cannot alter activity or owner metadata. This is the entire `murmur clear`
write path.

**`reconcileLocal`** — one `IMMEDIATE` transaction; a no-op returning empty
arrays when `world.panes === null`, because a tmux that could not answer is not
evidence of death. Each agent row is examined once, and pane and pid are each
consulted once:

| Pane live? | Owner pid alive? | `activity` | Action |
|---|---|---|---|
| no | — | — | `DELETE` agent; `DELETE` all attention for the pane |
| yes | yes | — | nothing |
| yes | no | `running` | `UPDATE activity = 'stopped'`; upsert `crashed` attention with `source = 'murmur'`, `message = ''` |
| yes | no | `stopped` | `DELETE` agent; attention **kept** |

Then, unconditionally: `DELETE FROM attention WHERE pane NOT IN (live panes)`.
This is what reaps attention for a pane that never had an agent row — an
attention-only codex pane whose window was closed. It also subsumes the first
row's attention delete, so that delete is stated for clarity, not because a
second statement is needed.

The asymmetry in the last two rows is the point. A dead *running* owner is an
unreported crash and must leave a durable trace; a dead *stopped* owner
finished normally, so its row is noise, but any `done` it raised is a fact a
human has not yet seen.

**`localPanes`** — the only way to read local state, and it returns the same
`SnapshotPane[]` shape a remote peer's cached snapshot holds. One deferred read
transaction over both tables, full outer join on pane in effect:

- a pane with an agent row and no attention → `agent` set, `attention: []`
- a pane with attention and no agent row → `agent: null`, `attention` non-empty
- a pane with both → both set
- `attention` sorted by `RENDER_PRIORITY`; `panes` sorted by pane id

It reconciles nothing and probes no pid, so it is safe on a read-only path and
in a tmux focus hook. `owner_pid` is not in the returned shape — the read model
and the wire model are the same type, which is what makes "no remote liveness
inference" structural rather than a rule to remember.

One shape for local and remote is the point. `paneViews` (§7) maps
`SnapshotPane` → `PaneView` exactly once, and a local pane and a remote pane
travel the same code path, differing only in the `host_id`, `local` and
freshness fields the caller supplies. The old model had `foldAll` for local and
`foldAll` with `() => true` for remote, which is the seam three of the audited
bugs lived in.

**`buildLocalSnapshot`** — `reconcileLocal(world)`, then `localPanes()`, then the
envelope fields from `identity` and `package.json`. It drops any pane where
`agent === null && attention.length === 0` (§6 rule 3), which `localPanes` does
not, because that rule is about what may be published, not about what is
readable locally.

Reconciling inside this method is what makes "a snapshot is authoritative" true:
absence from a successful snapshot means absence, so the snapshot must never be
produced from unreconciled rows. `reconcileLocal` is idempotent, so `collect`
calling it too (§6.2) is a cheap repeat, not a second policy.

**`peers` / `addPeer` / `removePeer`** — `peers()` returns rows ordered by
`name`, parsing the `snapshot` column and yielding `snapshot: null` when it is
`NULL`. A stored snapshot that no longer parses is returned as `null` with
`last_error` left untouched; it is not deleted, and it is not thrown from a read
path. `addPeer` is `INSERT ... ON CONFLICT(name) DO UPDATE SET target =
excluded.target` — correcting a target must not discard the cache.
`removePeer` deletes the row and its snapshot with it.

**`replacePeerSnapshot`** — one statement, chosen by `fetch.ok`:

```sql
-- ok: true
UPDATE peers SET snapshot = ?, snapshot_at = ?, fetched_at = ?,
       last_attempt_at = ?, last_error = NULL,
       host_id = ?, display_name = ?, murmur_version = ?, snapshot_version = ?
 WHERE name = ?;

-- ok: false
UPDATE peers SET last_attempt_at = ?, last_error = ? WHERE name = ?;
```

Which value goes where, because two of these are clocks on different machines
and conflating them is how a freshly fetched three-hour-old fact reads as new:

- `snapshot_at` ← `snapshot.generated_at`, the **peer's** clock. When that node
  built the document.
- `fetched_at` and `last_attempt_at` ← `fetch.at`, **our** clock. When we
  reached it. Freshness (§7) is computed from `fetched_at` only.
- `host_id`, `display_name`, `murmur_version` ← the same-named snapshot fields.
- `snapshot_version` ← `snapshot.murmur_snapshot`.

Success replaces the whole document and every field derived from it. Failure
touches neither `snapshot`, `snapshot_at` nor `fetched_at`, so the last-known
snapshot is retained and the peer ages into `stale` on its own. There is no
third outcome and no path that writes part of a snapshot.

### 5.2 Transactions

| Operation | Mode | Why |
|---|---|---|
| `claimAgent` | `IMMEDIATE` | reads the incumbent, then writes. A deferred transaction would start as a reader and fail `SQLITE_BUSY_SNAPSHOT` on upgrade — measured previously at 5 of 8 concurrent writers failing |
| `reconcileLocal` | `IMMEDIATE` | multi-statement; stop + crash attention must land together or not at all |
| `setActivity`, `releaseAgent`, `requestAttention`, `acknowledgePane`, `addPeer`, `removePeer`, `replacePeerSnapshot` | single statement | atomic by construction; no read-then-write, so no upgrade to lose |
| `localPanes` | deferred read transaction | the two tables must be read at one point in time, or a pane can appear with an agent and without the attention that was there when the agent was read |
| `buildLocalSnapshot` | `IMMEDIATE` reconcile, then `localPanes`' read transaction | two transactions, not one: a write transaction held open across the read would serialise every focus hook on the machine behind an export |

No caller outside `src/store.ts` opens a database handle, prepares a statement,
or writes SQL. This already holds in the current tree — verified by grep, and
`latestForAgent` exists precisely because `clear.ts` used to violate it — and
the rewrite must not reintroduce a second SQL site. `latestForAgent` itself goes
away: `clear` no longer reads an agent row to decide anything (§9.3).

### 5.3 Forbidden API shapes

These must not exist, in `Store` or anywhere reachable from `src/index.ts`.
Each is a shape that let a writer say something it had no standing to say:

- `append`, `ingest`, `insert`, `put`, `record`, or any method that takes a row
  and writes it.
- `eventsSince`, `allEvents`, `latestForAgent`, `maxSeq`, or any log read.
- A local read other than `localPanes`. No `agentForPane`, no `attentionFor`,
  no `agents()`. One read shape means one mapping to `PaneView`, and it is the
  proliferation of narrow reads that let `clear.ts` and `murmur-pi.ts` each
  derive their own idea of what a pane's current state was.
- `update(table, changes)`, `upsertAgent(Partial<AgentRow>)`, or any method
  whose parameter is a partial row, a column map, or an index-signature object.
  `upsertPeer`'s ten-argument hand-rolled `COALESCE` (`core-model` F8) is
  replaced by `addPeer` + `replacePeerSnapshot`, which between them cover every
  real caller.
- `setActivity` without `owner_pid`, or any activity write keyed on pane alone.
- Any attention method that accepts an `agent_id`, `owner_pid`, `activity`,
  `cli`, `driver`, `workstream`, `role`, `agent_name` or `pi_session`.
- `exec`, `prepare`, `raw`, `db`, or any escape hatch exposing the handle.
- Any method that writes a row for a *remote* `host_id`. Remote state lives
  only inside `peers.snapshot`.

---

## 6. Snapshot: schema and validation

One JSON document, `murmur export` on stdout, no `--since`, not JSONL.

```jsonc
{
  "murmur_snapshot": 1,
  "host_id": "9f1c...",            // from identity.json
  "display_name": "mtrojer-mac",
  "murmur_version": "0.2.0",       // read from package.json, never restated
  "generated_at": 1772456400000,   // this node's clock at build time
  "panes": [
    {
      "pane": "%250",
      "session": "$25",
      "window": "@75",
      "session_name": "hacking/murmur",
      "window_name": "worker-1",
      "agent": {
        "agent_id": "c0ffee00-...",
        "activity": "running",
        "agent_name": "worker-1",
        "pi_session": null,
        "workstream": "murmur",
        "role": null,
        "cli": "pi",
        "driver": "orchestrated",
        "claimed_at": 1772456000000,
        "updated_at": 1772456390000
      },
      "attention": [
        {
          "kind": "blocked",
          "message": "needs input",
          "source": "codex",
          "requested_at": 1772456380000
        }
      ]
    }
  ]
}
```

Rules:

1. `owner_pid` is absent, on purpose. A reader has no pid to probe, so remote
   liveness inference is not merely discouraged, it is unrepresentable.
2. A pane entry with `"agent": null` is an attention-only pane. It is a valid,
   listable, jumpable row.
3. A pane entry with `"agent": null` and `"attention": []` must not be emitted.
4. `panes` order is presentation-only and carries no meaning. Readers sort for
   themselves (§7). Emitted sorted by pane id for diffable output.
5. There is no `epoch`, no `seq`, no `since`, no watermark, and no delta form.
   The document is complete, so a peer that returns one has said everything it
   knows and absence is absence.

### 6.1 `parseSnapshot(text: string): Snapshot`

Throws `SnapshotInvalidError` with a message naming the first failing path
(e.g. `panes[3].attention[0].kind`). The collector catches it and turns it into
`{ok: false, error}` — a peer that answers with a bad document is *reachable
but broken* and must be visibly so, not silently stale.

Validation is total and strict. Nothing is coerced, defaulted, or carried
through:

- top level is a non-array object with exactly these six keys:
  `murmur_snapshot`, `host_id`, `display_name`, `murmur_version`,
  `generated_at`, `panes`. A missing or unknown key is rejected.
- `murmur_snapshot === 1`. Any other value, including a higher one, is
  rejected. Forward compatibility is not offered; a version mismatch is an
  operator-visible pairing problem, which is the honest report.
- `host_id`, `display_name`, `murmur_version`: non-empty strings.
- `generated_at`: a finite, non-negative, integral number.
- `panes`: an array; each entry an object with exactly these seven keys:
  `pane`, `session`, `window`, `session_name`, `window_name`, `agent`,
  `attention`. `pane`, `session` and `window` are non-empty strings; `pane` is
  unique in the document; `session_name` and `window_name` are `string | null`.
- `agent`: `null`, or an object with exactly these ten keys: `agent_id`,
  `activity`, `agent_name`, `pi_session`, `workstream`, `role`, `cli`,
  `driver`, `claimed_at`, `updated_at`.
  `activity ∈ {running, stopped}`, `driver ∈ {human, orchestrated}`, `cli` a
  non-empty string, `agent_id` a non-empty string, the four name fields
  `string | null`, `claimed_at` / `updated_at` finite non-negative integers.
- `attention`: an array; each entry an object with exactly these four keys:
  `kind`, `message`, `source`, `requested_at`. `kind ∈ {done, blocked,
  crashed}` and is unique within the pane; `message` and `source` are strings;
  `requested_at` is a finite non-negative integer.
- an entry with `agent === null` and `attention.length === 0` is rejected.

Validation happens **before** storage. Nothing partially valid is cached, so no
unknown value can reach a sort, a count or a render path — which is exactly the
failure mode `NaN`-sorting an unknown state produced (`core-model` F6).

### 6.2 Collector

Per peer, independently, in the existing bounded-concurrency pool with the
existing whole-collect deadline (both retained: they were measured against a
tmux `status-interval`, and the audits did not fault them):

1. `ssh <target> murmur export` — no arguments, one round trip. There is no
   second "refetch from zero" trip, because there is no watermark to be wrong.
2. `parseSnapshot(stdout)`.
3. `replacePeerSnapshot(name, {ok: true, snapshot, at: now})`, which reads
   `host_id`, `display_name`, `murmur_version` and `snapshot_version` (the
   document's `murmur_snapshot`) out of the snapshot itself. The caller passes no
   metadata alongside it, so the cache cannot disagree with the document.

Any failure at any step → `replacePeerSnapshot(name, {ok: false, error, at:
now})`, and the previous snapshot stands. `collect` still returns a
`CollectResult[]`, still distinguishes *unreachable* from *reachable but
broken*, and still prints only from `murmur collect`. `Permission denied` is
classified as **reachable but broken**, not unreachable
(`ingestion-identity` finding 8): an auth misconfiguration is an operator task,
not a sleeping laptop.

`collect` also calls `reconcileLocal` once per invocation, which is the only
housekeeping left. `prune`, `synthesizeCrashes` and `reapDeadAgents` are gone.

---

## 7. View

```ts
export type Freshness = "fresh" | "stale";
export type RenderState = "crashed" | "blocked" | "done" | "running" | "idle";

export type PaneView = {
  // address
  host_id: string;
  host: string;             // the name the operator typed, or this node's display_name
  local: boolean;
  pane: PaneId;
  session: SessionId;
  window: WindowId;
  session_name: string | null;
  window_name: string | null;
  // the three independent facts
  activity: Activity | null;      // null: attention-only pane, no agent row
  attention: AttentionKind[];     // priority-ordered, possibly empty
  freshness: Freshness;
  // owner-reported metadata, null for an attention-only pane
  agent_id: string | null;
  agent_name: string | null;
  pi_session: string | null;
  workstream: string | null;
  role: string | null;
  cli: string | null;
  driver: Driver;                 // defaults to "human" when there is no agent row
  // ages
  updated_at: number | null;      // when the pane's own node last said something
  snapshot_at: number | null;     // when that node generated its snapshot; null for local
  fetched_at: number | null;      // when we last reached that node; null for local
};
```

- `paneViews(store, identity, now)` builds views from two sources of one shape:
  `store.localPanes()` for this node, and each `PeerRecord.snapshot`'s `panes`
  for the others. Both are `SnapshotPane[]`, so there is one mapping function.
  There is no fold, no event grouping, and no `LiveCheck` anywhere on the read
  path.
- `identity` is a non-null `NodeIdentity`, because every caller is a command
  that already requires `murmur init` (§3.2). This is what deletes the
  `identity?.` chains that previously classed every row as remote — including
  local ones — whenever identity was absent (`consumers-cli` finding 5).
- `PaneView` replaces `AgentView`, and `agents.ts`'s
  `Agent = Status["agents"][number]` alias is deleted: `agentLabel`,
  `agentLocation`, `jumpToAgent` and `glance` take a `PaneView` directly. The
  alias existed so the picker could name a shape assembled inside `status()`;
  the shape now has its own name and its own module.
- `updated_at` is the pane's own news, not ours. For a pane with an agent it is
  `agents.updated_at`; for an attention-only pane it is the newest
  `requested_at` on that pane. It is never `fetched_at`, which is when *we*
  last reached the node — the two ages answer different questions and a peer
  polled one second ago can be serving a three-hour-old fact.
- `freshness(fetchedAt, now)` returns a `Freshness`; `age(ms)` returns the short
  human string. Both live in `src/view.ts` and are the only two places a
  duration is turned into text or a verdict.
- **Local views are always `fresh`.** Remote views take the freshness of their
  *node*: `fresh` when `fetched_at !== null && now - fetched_at <=
  STALENESS_MS`, else `stale`. Freshness is never per agent, and a stale node
  keeps its last-known fields verbatim beside an explicit warning. No liveness
  is inferred for a remote pane, ever.
- `renderState(view)`: the first kind present in
  `["crashed", "blocked", "done"]`, else `"running"` when `activity ===
  "running"`, else `"idle"`. Presentation only. A running agent with `blocked`
  attention is a valid and expected state; surfaces that can show both, do.
- `RENDER_PRIORITY = ["crashed", "blocked", "done", "running", "idle"]` is the
  single ordering table. `viewSort` uses it, then descending `updated_at`.
  `status.ts` and `pick.ts` import it rather than declaring their own copies
  (`consumers-cli` finding 7).
- Human-vs-orchestrated visibility survives as a presentation rule over the
  typed `driver` field: a crew agent is hidden unless its attention includes
  `blocked` or `crashed`. Unchanged behaviour, moved onto typed data.

---

## 8. Deleted concepts

Deleted outright, with no replacement and no adapter:

**Model and store.** `Event`, `NewEvent`, `AgentState`, the `cleared` state,
`ResolvedState`, `kind`, `seq`, `ts`-vs-`seq` ordering, `synthetic`, `reason`
codes, `extra` / unknown-field round-tripping, `epoch`, `watermark`, retention
and `prune`, `MURMUR_RETENTION_MS`, `STORE_VERSION`'s additive `ALTER` path,
`events.db`, `store.append`, `store.ingest`, `eventsSince`, `allEvents`,
`latestForAgent`, `maxSeq`, `forgetAgent`, `forgetHost`, `upsertPeer`.

**Fold.** All of `src/fold.ts`: `foldAgent`, `foldAll`, `resolveState`,
`viewState`, `attentionSort`, `ATTENTION_ORDER`, `AgentView`, and the
`LiveCheck` on any read path. `age` and `isStale` move to `src/view.ts`
unchanged.

**Reconciliation-by-event.** `synthesizeCrashes`, `reapDeadAgents`,
`reconcileDeadAgents`, and the `Set<WindowId> | null | undefined` three-meaning
`live` parameter. Window-keyed liveness is gone; only panes decide.

**Reader compensation.** `forgetReplica`, `forgetHostReplica`,
`forgetOneAgent`'s replica eviction, watermark rewind, `tmux_down_at`, and the
picker's delete key as a state mutation. A reader holds no per-agent remote rows
to evict — it holds one snapshot per peer, and the next fetch replaces it.

**Wire.** `Envelope`, `SCHEMA_VERSION`, `eventToWire`, `eventFromWire`, JSONL
parsing, `--since`, `refetchFromZero`, `SchemaTooNewError`, and the epoch
comparison in `collect`.

**Extension ownership machinery.** The `MURMUR_PANE_OWNER` environment marker
and its `OWNER_ENV` constant, `ownsPane`, `ownerClaim`, `mayReport`, and the
"last event carrying a pid" scan in `murmur-pi.ts`. All of it is replaced by
`claimAgent`'s `refused` outcome, which needs no environment transport and
cannot be dropped by a process launched in an unusual way. `endState` is deleted
with `cleared`. `driverFromEnv` stays; `settledState` stays with its return type
narrowed to `"done" | null`.

**Consumer complexity that existed only to compensate.** Metadata copy-forward
in `clear.ts` and `notify.ts`; `CLEARABLE` and `windowHasAgent`; `identity?.`
optional chaining on paths where identity provably cannot be null
(`consumers-cli` finding 5); the duplicated `URGENCY` / `urgency` /
`NEEDS_HUMAN` tables in `pick.ts` and `status.ts`, which become imports of
`RENDER_PRIORITY`.

The extension's three-state `StoreState` (`untried` / `open` / `absent`) is
**kept**. It encodes three real states, the audits did not fault it, and
collapsing it is what previously latched reporting off for the life of a
process.

Not deleted, deliberately: `src/mux.ts`, `src/channel.ts` and its
`SSH_OPTIONS`, `src/glance.ts`, `src/agents.ts`'s `shellQuote` /
`terminalText` / `agentLabel` / `agentLocation` / remote-jump session seam, the
`SessionId` / `WindowId` / `PaneId` brands, `MAX_CONCURRENT_PEERS`,
`COLLECT_DEADLINE_MS`, `STALENESS_MS`. Each earns its keep and none depends on
the event model. `Mux` methods with no production caller
(`liveWindows`, `windowNames`, `windowNamed`, `selectWindow`, `newWindow`) are
removed with the code that used them.

---

## 9. Caller-visible behaviour

### 9.1 The pi extension

At load, in order, and it stops at the first failure:

1. `tmux.currentWindow()`; return if there is no pane.
2. `loadIdentity()`; return if null. Nothing is minted.
3. `openStore()`, then `claimAgent({location, owner_pid: process.pid, meta})`.
4. On `refused`: register no handlers, paint no badge, close the store, return.
   A nested agent is deliberately invisible.
5. On `claimed` / `retained` / `replaced`: keep the returned `agent_id` for the
   life of the process and register handlers.

| pi event | Focused | Driver | Store call |
|---|---|---|---|
| `agent_start` | any | any | `setActivity(running)` |
| `agent_end` | any | any | `setActivity(stopped)` |
| `agent_settled` | yes | any | none |
| `agent_settled` | no | `human` | `requestAttention({kind: "done", source: "pi"})` |
| `agent_settled` | no | `orchestrated` | none |
| `session_shutdown` | any | any | `releaseAgent`, then drop the handle |
| `session_start` | any | any | re-resolve location; re-arm the handle |

Completion means `done`. `blocked` is never authored by an owner — it comes
only from an external notifier — which is the change that makes the two axes
genuinely independent.

Retained from the current extension: the single-slot promise chain serialising
handlers, because `activity` is a last-write-wins field and an inverted
`start`/`end` pair would leave a finished agent `running`; the pane-move badge
handoff; and the three-state store handle. The queue is *not* retained for
append ordering, which no longer exists.

`setActivity` returning `false` is not an error and is not retried: it means
this process is no longer the owner of record, and the correct response is
silence.

### 9.2 `murmur notify`

`requestAttention({kind: "blocked", location, message, source})`. Nothing else.
It cannot name an agent, a pid, an activity or any owner metadata, because
`AttentionRequest` has no field for them. `--source` still lands in `source`;
`--pane` still narrows the caller's own location and still returns silently when
it names a pane in another window. Flags still beat the stdin payload, and the
bounded stdin read is unchanged.

The 250 ms stdin deadline, control-character cleaning, and silent success
outside tmux all stay.

### 9.3 `murmur clear --pane <pane>`

`acknowledgePane(pane)`, plus the tmux badge. It writes nothing else and reads
no agent row to decide. The `CLEARABLE` whitelist, `windowHasAgent`, the
resolver call and the metadata copy-forward are all deleted: there is no state
that focus must refuse to clear, because attention is the only thing focus can
address.

Badge handling: clear the window badge when no *other* pane in the focused
pane's window has attention, read via `store.localPanes()`. This is the same
question `windowHasAgent` asked, with the answer now coming from attention
rather than from "any non-`cleared` state" — which is the fix, since a `working`
agent next door is not a reason to keep an attention badge lit.

Fails safe in the direction the old code chose and for the same reason: if the
store or tmux cannot answer, leave the badge alone. Wrongly keeping a badge is
recoverable by focusing the pane; wrongly clearing one loses the signal. Best
effort, silent, total, exit 0 always.

### 9.4 `murmur status`, `pick`, `glance`, `jump`, `peer`

- `status --json` breaks. New shape: `{counts, orchestrated_counts, panes,
  peers}` where `counts` is `Record<RenderState, number>` and `panes` is
  `PaneView[]`. `tmuxStatus` keeps its `state\tcount\n` output and its rule
  that orchestrated agents count only for `blocked` and `crashed`.
- `pick` renders activity and attention simultaneously and marks host staleness
  explicitly. History preview is deleted; the preview shows current details plus
  `glance` output. The delete key is removed — there is no replica to evict.
- `jump` and `glance` use pane location and **never mutate state on failure**.
  A failed probe returns a `JumpResult` with a reason and a message; it does not
  delete, does not rewind, does not write. `pane_gone` becomes a report, not a
  deletion.
- `peer list` shows `name`, `target`, `display_name`, last fetch age,
  freshness, `murmur_version`, `snapshot_version`, and `last_error` when set.
  `peer add` stores `name` + `target`, probes once with bare `murmur export`
  (not `--since 0`, which no longer exists), and records the probe's `host_id`,
  `display_name`, `murmur_version` and `snapshot_version` via
  `replacePeerSnapshot` — the data was already parsed and was previously thrown
  away (`ingestion-identity` finding 7). Self-add and duplicate-`host_id`
  refusals are unchanged.
- `murmur export` takes no options and prints one snapshot document. The
  `--since` flag is removed from the CLI, from the collector's argv, and from
  `peer add`'s probe argv; three call sites, all of which must change together.

### 9.5 SDK surface (`src/index.ts`)

Exports: `VERSION`; `openStore` and `Store`; every type in `src/types.ts`
(including `Snapshot` and its three member types); `parseSnapshot` and
`SnapshotInvalidError`; `PaneView`, `Freshness`, `RenderState`,
`RENDER_PRIORITY`, `renderState`, `paneViews`, `viewSort`, `age`, `freshness`;
`Status`, `status`, `statusWithCollect`, `tmuxStatus`; `loadIdentity`,
`createIdentity`, `setDisplayName`, `NodeIdentity`; the three id brands and
their constructors; `Mux`, `tmux`, `pidAlive`; `Channel`, `ssh`,
`hasWarmSocket`; `collect`, `CollectResult`, `STALENESS_MS`,
`MAX_CONCURRENT_PEERS`; `stateDir`, `configDir`, `dbPath`; `glance`,
`jumpToAgent`, `JumpResult`, `agentLabel`, `agentLocation`, `shellQuote`.

Not exported: anything in §5.3, and no raw database handle by any name.
`reconcileLocal` and `buildLocalSnapshot` are exported only as `Store` methods,
which is what keeps `src/store.ts` the sole owner of SQL.

---

## 10. Accepted limitations

Stated here so they are design, not surprise, and repeated verbatim in the
rewritten `ARCHITECTURE.md`:

1. **No history.** Only current state is stored. There is no event log, no
   retention horizon, and no way to ask what an agent was doing an hour ago.
2. **No compatibility.** A pre-rewrite `events.db` is deleted, not migrated. An
   old and a new node cannot federate: the old one serves JSONL, the new one
   rejects it as an invalid snapshot and reports the peer as broken.
3. **No incremental sync.** Every collect transfers each peer's whole snapshot.
   Bounded by live pane count, so this is small; it is still O(panes) per tick
   rather than O(changes).
4. **No nested agents.** A second live process in one pane is refused and
   reports nothing. A pane shows at most one agent.
5. **No remote liveness inference.** `owner_pid` never crosses the wire. A
   remote pane's `activity` is whatever its own node last said, and a stale node
   keeps last-known values with a warning.
6. **PID reuse.** If a pane's owner dies and the OS reassigns its pid before
   the next `reconcileLocal`, that owner reads as alive and the crash is missed
   until something else changes. Accepted: the window is short, the failure is
   temporary, and the alternatives (pid start-time, cgroup, a watcher) each buy
   a platform dependency for a case measured as rare.
7. **`claimAgent` costs a liveness probe**, and a probe that cannot answer
   (`EPERM`) refuses the new claimant. A pane whose owner is unprobeable stays
   unclaimable until the pane goes away. Fails closed on purpose.
8. **Attention is not per-agent.** It is per pane. A pane whose agent is
   replaced loses the previous occupant's attention, which is intended, and two
   sequential agents in one pane cannot each hold their own `done`.

---

## 11. Verification the rewrite must pass

Every item is a claim about what is *impossible*, testable without reference to
a deleted implementation:

1. A notifier cannot change any agent field. Snapshot every column of an
   `agents` row, run `requestAttention` with every kind, assert byte equality.
2. `acknowledgePane` cannot change `activity` or any owner field, and clears
   every kind for that pane and no other pane.
3. `notify` then `clear` while the owner pid is alive leaves the agent row
   byte-for-byte unchanged. This is the regression test for the measured live
   incident: under the event model that sequence replaced `working` with
   `blocked` and nulled `agent_name`, `workstream`, `role` and `driver` on panes
   `%250`–`%252` while all three pi processes were alive.
4. A second live process claiming an owned pane gets `refused` and writes
   nothing.
5. A dead owner's pane is `replaced` with a new `agent_id`, and the previous
   owner's `setActivity` / `releaseAgent` then return `false`.
6. `retained` for the same pid: `agent_id` and `activity` survive a re-claim.
7. `reconcileLocal` on a dead running owner produces `stopped` + one `crashed`
   row, transactionally; running it again changes nothing, including
   `requested_at`.
8. A pane that disappears removes its agent row *and* its attention. A pane
   whose owner died after `stopped` removes the agent row and *keeps* attention.
9. `reconcileLocal` with `panes: null` writes nothing.
10. A successful peer fetch replaces the whole cached document — a pane present
    before and absent after is gone from the view.
11. A failed peer fetch keeps the previous snapshot, sets `last_attempt_at` and
    `last_error`, leaves `fetched_at` alone, and the peer renders `stale`.
12. An invalid snapshot (bad version, unknown `activity`, unknown `kind`,
    duplicate pane, unknown key, missing key) is rejected before storage, and
    the peer reports reachable-but-broken.
13. No read path probes a remote pid, and neither a snapshot nor `localPanes`'
    return value contains `owner_pid`. Assert structurally, over the whole
    returned object graph, not by reading the type.
14. `openStore` mints no identity: on a clean state dir, `loadIdentity()`
    returns `null` before and after `openStore()`.
15. `murmur init --name` sets `display_name` on an existing identity and never
    silently ignores the flag.
16. A jump or probe failure mutates nothing: assert `agents`, `attention` and
    `peers` are all unchanged, including `last_error`.
17. Constraint tests, driven through the store where possible and through raw
    SQL where the point is that SQLite itself refuses: a second `agents` row for
    one pane violates `UNIQUE`; `activity`, `driver` or `kind` outside their
    enums violates a `CHECK`; `owner_pid <= 0` violates a `CHECK`. Separately,
    and not a constraint but the same guarantee: `setActivity` with a
    non-matching `owner_pid` returns `false` and writes nothing.
18. Test-isolation guard (owned by `rewrite-test-isolation`, asserted again
    here): no test process, in-process or spawned, resolves `stateDir()` under
    `$HOME`, and no test addresses the caller's `$TMUX_PANE`.

    This is not a hypothetical, and it is why `rewrite-test-isolation` blocks
    `rewrite-state-store` rather than running beside it. Writing this contract
    required one `npm run check` to confirm the tree was green. That run wrote
    three `blocked` rows (`cli=stdin-probe`, `chunked`, `file-stdin`,
    `reason=notify`, `pid=null`) into the author's real `events.db` for pane
    `%254` — this pane — superseding `seq 1042`, a `working` row whose pid 55195
    was and is alive, and nulling `agent_name=worker-1`, `workstream=murmur` and
    `driver=orchestrated` in the process. Same mechanism, same three test files,
    a third independent reproduction. Until this item lands, every validation
    run of every downstream task corrupts live state.
19. Two-node smoke test against real hosts: fresh view, stale view after a peer
    goes away, owner replacement, attention raised remotely and acknowledged
    locally, and a jump to a remote pane.
20. `snapshot_at` and `fetched_at` are not interchangeable: fetching a snapshot
    whose `generated_at` is hours old yields a `fresh` node with an old
    `updated_at`, and the view shows both.
21. `npm run lint:fix` then `npm run check` clean.

---

## 12. Task mapping

| Task | Sections it implements |
|---|---|
| `rewrite-test-isolation` | §11.18 |
| `rewrite-state-store` | §2, §3, §4, §5 |
| `rewrite-agent-lifecycle` | §5.1 (`claimAgent`, `setActivity`, `releaseAgent`, `reconcileLocal`), §9.1 |
| `rewrite-attention` | §5.1 (`requestAttention`, `acknowledgePane`), §9.2, §9.3 |
| `rewrite-local-snapshot` | §6, §5.1 (`localPanes`, `buildLocalSnapshot`) |
| `rewrite-peer-cache` | §5.1 (`replacePeerSnapshot`, peer methods), §6.2 |
| `rewrite-view` | §7 |
| `rewrite-surfaces` | §9.4, §9.5, and `src/status.ts` per §2 |
| `rewrite-delete-legacy` | §8 |
| `rewrite-integration` | §11 (all items) |
| `rewrite-docs` | §1, §10 |

Sections not claimed by any single task are cross-cutting and bind all of them:
§5.2 (transactions), §5.3 (forbidden shapes) and the reduction lists in §8 and
§10. A task that cannot meet one of those without violating another is a
contract bug — reopen `rewrite-contract` rather than working around it.
