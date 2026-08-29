import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONTROL_PATH = "~/.ssh/control/%r@%h:%p";

// A peer that is merely unreachable — asleep, off the VPN, a stale address —
// must not hold up a command. OpenSSH's default TCP connect timeout is the
// kernel's, which is 75s on macOS; at that point `murmur pick` is unusable and
// the HUD tick overlaps itself. Two seconds is far above any real handshake on
// a LAN or a VPN, and a peer that misses it simply shows stale, which is the
// designed outcome for a host you cannot reach.
const CONNECT_TIMEOUT_S = 2;

// Belt and braces for a host that completes the TCP connect and then stops
// responding — ConnectTimeout does not cover that, and it is how a sleeping
// laptop behaves. Bounds the whole exchange rather than just the dial.
const EXEC_TIMEOUT_MS = 10_000;

// Warm if possible, cold if not, never interactive.
//
// ControlMaster=no attaches to a master socket left behind by an ordinary
// `ssh <host>` (given ControlMaster auto + ControlPersist in ssh_config), so a
// peer you have touched recently costs a new channel on an authenticated
// connection rather than a handshake.
//
// When no socket is listening OpenSSH falls back to connecting normally, and we
// want that: with plain key auth a cold peer collects fine, just slower
// (~170ms against ~10ms measured on a LAN). Fleet visibility should not depend
// on having ssh'd somewhere today.
//
// BatchMode=yes bounds what that fallback may do. It disables every
// interactive prompt — password, passphrase, host key confirmation — so a
// cold peer that cannot authenticate silently fails immediately instead of
// blocking a background collect on a human. Note this is "never prompt", not
// "never authenticate": a host demanding a hardware-token touch per connection
// is the case this does not fully cover, and the reason `hasWarmSocket` exists
// should that ever need gating.
//
// Exported because every ssh murmur runs wants exactly this posture -- the
// collector, the picker's preview, the jump probe. Three hand-rolled copies is
// how one of them ends up without BatchMode and starts prompting for auth on
// every keypress.
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

export const ssh: Channel = {
  async exec(target, argv) {
    const { stdout } = await execFileAsync("ssh", [...SSH_OPTIONS, target, ...argv], {
      encoding: "utf8",
      timeout: EXEC_TIMEOUT_MS,
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
