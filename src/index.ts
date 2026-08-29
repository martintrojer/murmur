// SDK entry. package.json advertises this as the "." export, so anything a
// consumer needs to drive murmur without shelling out to the CLI belongs here.
// The CLI is a thin layer over exactly these units.
export const VERSION = "0.1.0";

export {
  type Agent,
  agentLabel,
  agentLocation,
  type JumpResult,
  jumpToAgent,
  shellQuote,
} from "./agents.js";
export { type Channel, hasWarmSocket, ssh } from "./channel.js";
export {
  COLLECT_INTERVAL_MS,
  type CollectResult,
  collect,
  STALENESS_MS,
} from "./collector.js";
export { eventFromWire, exportJsonl, SCHEMA_VERSION } from "./export.js";
export {
  type AgentView,
  attentionSort,
  foldAgent,
  foldAll,
  isStale,
  type LiveCheck,
} from "./fold.js";
export { glance } from "./glance.js";
export { ensureIdentity, loadIdentity, type NodeIdentity } from "./identity.js";
export { type Mux, pidAlive, tmux } from "./mux.js";
export { configDir, dbPath, stateDir } from "./paths.js";
export { type Status, status } from "./status.js";
export { type NewEvent, openStore, STORE_VERSION, type Store } from "./store.js";
export {
  type AgentState,
  DEFAULT_DRIVER,
  type Driver,
  type Event,
  type Peer,
} from "./types.js";
