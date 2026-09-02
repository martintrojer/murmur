import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONTROL_PATH = "~/.ssh/control/%r@%h:%p";

/**
 * The command that makes a host murmur can otherwise not reach collectable.
 *
 * `-M` is the load-bearing flag and the reason this is a constant rather than
 * prose in three places. A plain `ssh <host>` does NOT produce a usable master:
 * it either attaches as a client to whatever socket exists, or -- through a
 * `ProxyCommand` -- leaves a socket that can forward but has never authenticated
 * a SESSION. Verified against a real 2FA host, where `ssh -O check` reported
 * `Master running` and every command over it still failed with `Session open
 * refused by peer`. `-M` makes the interactive session the reader just
 * authenticated the master, so the session channel murmur wants rides a
 * connection that has already cleared the second factor.
 *
 * `-S` with the same `%r@%h:%p` tokens as `ControlPath`, so one string is
 * correct for every host and cannot drift from where murmur actually looks.
 *
 * Documented as a template rather than resolved per peer: the shell expands
 * nothing here, ssh does, so a reader can paste it verbatim.
 */
export function warmSocketCommand(target: string): string {
  return `ssh -M -S ${CONTROL_PATH} ${target}`;
}

// Both timeouts are sized against the tmux status bar, which is what drives
// collection: tmux re-runs `murmur status` every `status-interval` (5s here,
// 15s by default), and a collect that outlives its tick overlaps itself with no
// way to cancel the last one. So the whole exchange budgets under 5s, and these
// are deliberately aggressive -- a slow node is rejected rather than allowed to
// hold up the HUD, which costs one tick of staleness.

// OpenSSH's default is the kernel's TCP timeout, 75s on macOS. One second is
// still ~6x a real cold handshake on a LAN or VPN (measured: 168ms cold, 42ms
// warm), and a peer that misses it shows stale -- the designed outcome for a
// host you cannot reach.
const CONNECT_TIMEOUT_S = 1;

// Belt and braces for a host that completes the TCP connect and then stops
// responding, which ConnectTimeout does not cover and is how a sleeping laptop
// behaves. Bounds the whole exchange, so it must leave room for the dial plus
// an export: the tick budget minus headroom for the rest of `status`.
const EXEC_TIMEOUT_MS = 3_000;

// Warm if possible, cold if not, never interactive.
//
// ControlMaster=no ATTACHES to a master socket left by an ordinary `ssh <host>`
// (given ControlMaster auto + ControlPersist in ssh_config), so a peer touched
// recently costs a channel on an authenticated connection, not a handshake.
// With no socket listening OpenSSH connects normally, which is wanted: a cold
// peer collects fine on key auth, just slower (~170ms against ~10ms on a LAN),
// and fleet visibility should not depend on having ssh'd somewhere today.
//
// BatchMode=yes bounds that fallback by disabling every prompt -- password,
// passphrase, host key -- so a cold peer that cannot authenticate fails at once
// rather than blocking a background collect on a human. "Never prompt", not
// "never authenticate": a host demanding a hardware-token touch per connection
// is the case this does not cover, and why `hasWarmSocket` exists should it
// ever need gating.
//
// Exported because every ssh murmur runs wants this posture -- collector,
// preview, jump probe. Three hand-rolled copies is how one ends up without
// BatchMode and prompts for auth on every keypress.
export const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ControlMaster=no",
  "-o",
  `ControlPath=${CONTROL_PATH}`,
  "-o",
  `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
];

export interface Channel {
  exec(target: string, argv: string[]): Promise<string>;
}

// Node's execFile defaults to a 1 MiB stdout ceiling and rejects with
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER past it, killing the child. An export is
// bounded by live pane count at a few hundred bytes each, so the ceiling is out
// of reach -- but generous anyway, because the failure mode is disproportionate
// to its likelihood: a peer over the buffer fails identically on every collect
// and sits stale forever behind an error naming a Node internal, not a size.
// A ceiling, not an allocation; the timeout is the real bound on a runaway peer.
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

export const ssh: Channel = {
  async exec(target, argv) {
    const { stdout } = await execFileAsync("ssh", [...SSH_OPTIONS, target, ...argv], {
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_EXPORT_BYTES,
    });
    return stdout;
  },
};

export function hasWarmSocket(target: string): boolean {
  try {
    execFileSync("ssh", [...SSH_OPTIONS, "-O", "check", target], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
