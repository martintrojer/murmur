import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONTROL_PATH = "~/.ssh/control/%r@%h:%p";

// Both timeouts are sized against the tmux status bar, because that is what
// actually drives collection: `murmur status` collects, and tmux re-runs it
// every `status-interval` — 5s on the author's setup, 15s by default. A collect
// that outlives its tick is a collect overlapping itself, and tmux offers no
// way to cancel the last one.
//
// So the budget for the whole exchange is under 5s, and these are deliberately
// aggressive: a really slow node is rejected rather than allowed to hold up the
// HUD. That is cheap because the cost of losing the race is one tick of
// staleness, and the next tick is five seconds away.

// OpenSSH's default TCP connect timeout is the kernel's, 75s on macOS, which
// made `murmur pick` unusable against a sleeping laptop. One second is still
// ~6x a real cold handshake on a LAN or VPN (measured: 168ms cold, 42ms on a
// warm control socket), and a peer that misses it simply shows stale — the
// designed outcome for a host you cannot reach.
const CONNECT_TIMEOUT_S = 1;

// Belt and braces for a host that completes the TCP connect and then stops
// responding — ConnectTimeout does not cover that, and it is how a sleeping
// laptop behaves. Bounds the whole exchange rather than just the dial, so it
// has to leave room for the dial plus an export: three seconds is the tick
// budget minus headroom for the rest of `status`.
const EXEC_TIMEOUT_MS = 3_000;

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

// Node's execFile defaults to a 1 MiB stdout ceiling and rejects with
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER past it, killing the child. An export is
// now the peer's whole CURRENT state rather than its history, so it is bounded
// by live pane count -- a few hundred bytes per pane, on a machine that cannot
// hold thousands of panes. The ceiling is far less likely to be reached than it
// was against an unbounded event log.
//
// It is kept generous anyway, because the failure mode is bad out of proportion
// to its likelihood: a peer whose document exceeds the buffer fails identically
// on every collect, so it sits stale forever with an error that names a Node
// internal rather than a size.
//
// 64 MiB is orders of magnitude above any real snapshot, and it is a
// ceiling rather than an allocation. The timeout is the real bound on a
// runaway peer.
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
