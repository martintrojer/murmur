import { loadIdentity, type NodeIdentity } from "../identity.js";

/**
 * This node's identity, or null after printing why not.
 *
 * Every command that needs a `host_id` -- export, collect, status, pick, doctor
 * -- fails here rather than minting one, because a node that came into existence
 * as a side effect of a status-bar tick has an identity nobody chose. `notify`
 * and `clear` are absent from that list as a consequence of the model rather
 * than as an exemption: both address a pane, and attention is keyed on pane
 * alone.
 *
 * `peer` is absent for a third reason: it reads identity OPPORTUNISTICALLY.
 * `peer add` uses it only to refuse adding this node to itself, so on an
 * uninitialised node that check cannot fire and the add proceeds -- configuring
 * peers before `init` is allowed, and the self-add refusal is best effort.
 * `peer list` and `peer remove` never read it at all.
 */
export function requireIdentity(): NodeIdentity | null {
  const identity = loadIdentity();
  if (identity) return identity;
  process.stderr.write("murmur is not initialised on this node; run: murmur init\n");
  process.exitCode = 1;
  return null;
}
