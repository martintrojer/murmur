import { loadIdentity, type NodeIdentity } from "../identity.js";

/**
 * This node's identity, or null after printing why not.
 *
 * Every command that needs a `host_id` -- export, collect, status, pick, peer --
 * fails here rather than minting one, because a node that came into existence as
 * a side effect of a status-bar tick has an identity nobody chose. `notify` and
 * `clear` are absent from that list as a consequence of the model rather than as
 * an exemption: both address a pane, and attention is keyed on pane alone.
 */
export function requireIdentity(): NodeIdentity | null {
  const identity = loadIdentity();
  if (identity) return identity;
  process.stderr.write("murmur is not initialised on this node; run: murmur init\n");
  process.exitCode = 1;
  return null;
}
