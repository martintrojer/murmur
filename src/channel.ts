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

const SSH_OPTIONS = [
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
