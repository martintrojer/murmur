// SDK entry. package.json advertises this as the "." export, so anything a
// consumer needs to drive murmur without shelling out to the CLI belongs here.
// The CLI is a thin layer over exactly these units.
//
// Deliberately NOT here: anything from the forbidden-shapes list (no append, no
// ingest, no log read, no narrow local read, no partial-row update) and no raw
// database handle under any name. `reconcileLocal` and `buildLocalSnapshot` are
// reachable only as `Store` methods, which keeps src/store.ts the sole owner of
// SQL.
//
// The version comes from src/version.ts, the one module that can find
// package.json from any bundle depth.

export {
  agentLabel,
  agentLocation,
  type JumpResult,
  jumpToAgent,
  shellQuote,
} from "./agents.js";
export { type Channel, hasWarmSocket, ssh } from "./channel.js";
export {
  type CollectResult,
  collect,
  MAX_CONCURRENT_PEERS,
} from "./collector.js";
export { glance } from "./glance.js";
export {
  createIdentity,
  loadIdentity,
  type NodeIdentity,
  setDisplayName,
} from "./identity.js";
export {
  asPaneId,
  asSessionId,
  asWindowId,
  type PaneId,
  type SessionId,
  type WindowId,
} from "./ids.js";
export { type Mux, pidAlive, tmux } from "./mux.js";
export { configDir, dbPath, stateDir } from "./paths.js";
export { parseSnapshot, SnapshotInvalidError } from "./snapshot.js";
export { type Status, status, statusWithCollect, tmuxStatus } from "./status.js";
export { openStore, type Store } from "./store.js";
export type {
  Activity,
  ActivityUpdate,
  AgentClaim,
  AgentMeta,
  AgentRelease,
  AttentionKind,
  AttentionRequest,
  ClaimResult,
  Driver,
  LiveCheck,
  LocalWorld,
  Location,
  PeerFetch,
  PeerRecord,
  ReconcileSummary,
  Snapshot,
  SnapshotAgent,
  SnapshotAttention,
  SnapshotPane,
} from "./types.js";
export { DEFAULT_DRIVER } from "./types.js";
export { MURMUR_VERSION as VERSION } from "./version.js";
export {
  age,
  type Freshness,
  freshness,
  NEEDS_HUMAN,
  type PaneView,
  paneViews,
  RENDER_PRIORITY,
  type RenderState,
  renderState,
  STALENESS_MS,
  viewSort,
} from "./view.js";
