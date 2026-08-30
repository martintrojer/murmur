// SDK entry. package.json advertises this as the "." export, so anything a
// consumer needs to drive murmur without shelling out to the CLI belongs here.
// The CLI is a thin layer over exactly these units.
// Read from the manifest rather than restated here: the version lived in
// package.json and in this file, and two copies of one fact drift. npm bumps
// the manifest, so the manifest is the source.
import { createRequire } from "node:module";

const manifest = createRequire(import.meta.url)("../package.json") as { version: string };
export const VERSION: string = manifest.version;

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
  type CollectResult,
  collect,
  MAX_CONCURRENT_PEERS,
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
export { type Status, status } from "./status.js";
export { type NewEvent, openStore, STORE_VERSION, type Store } from "./store.js";
export {
  type AgentState,
  DEFAULT_DRIVER,
  type Driver,
  type Event,
  type Peer,
} from "./types.js";
