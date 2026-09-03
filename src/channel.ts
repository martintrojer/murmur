import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONTROL_PATH = "~/.ssh/control/%r@%h:%p";

/**
 * The command that makes a host murmur can otherwise not reach collectable.
 *
 * Both flags are load-bearing, and neither is about authentication -- they are
 * about the socket EXISTING WHERE MURMUR LOOKS on a machine whose ssh_config
 * murmur does not control. OpenSSH's defaults are `ControlMaster no` and
 * `ControlPath none`, verified with `ssh -F /dev/null -G <host>`: so a bare
 * `ssh <host>` on an unconfigured machine multiplexes nothing and leaves no
 * socket at all, while `SSH_OPTIONS` below always looks at `CONTROL_PATH`.
 * `-M` creates the master; `-S` puts it on that path.
 *
 * A reader whose own ssh_config already sets `ControlMaster auto` and a matching
 * `ControlPath` gets a usable master from a plain `ssh <host>` -- verified, the
 * channel rides it fine. The flags are what make one instruction correct for
 * everyone, not a fix for something a plain `ssh` does wrong.
 *
 * NOT the cure for `Session open refused by peer`. That earlier claim was wrong:
 * see `sessionChannelBusy` in the collector, which reproduces the error against
 * a fully authenticated master built by this very command. It is session-slot
 * contention, and no flag here prevents it.
 *
 * `-N` is the flag whose absence made this remedy CAUSE the symptom. A host may
 * cap session channels per connection (`MaxSessions 1` on the devvm this was
 * found on), and `ssh -M <host>` opens an interactive shell that OCCUPIES the
 * single slot -- so while the reader sat at the prompt the picker told them to
 * open, every collect was refused with `Session open refused by peer` and the
 * notice stayed up, pointing at the command holding the peer hostage. `-N`
 * requests no remote command, so the master authenticates and consumes nothing.
 * `-f` backgrounds it after auth, so the reader gets their prompt back instead
 * of a terminal parked on a command that prints nothing.
 *
 * `-S` uses the same `%r@%h:%p` tokens as `ControlPath`, so one string is
 * correct for every host and cannot drift from where murmur actually looks.
 *
 * Documented as a template rather than resolved per peer: the shell expands
 * nothing here, ssh does, so a reader can paste it verbatim.
 */
export function warmSocketCommand(target: string): string {
  return `ssh -MNf -S ${CONTROL_PATH} ${target}`;
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
// `no` does NOT mean "attach or fail". It governs master CREATION only, and the
// fallback fires for a socket that exists and REFUSES as readily as for one
// that is absent -- so on a session-capped host a refused channel silently
// becomes a fresh connection, which then fails at whatever auth the host
// demands. That is why a busy slot surfaces as `Permission denied` rather than
// as contention, and why `sessionChannelBusy` has to exist: no ssh option
// available here prevents the fallback or makes it announce itself. Measured
// with `no` set: three of four concurrent calls produced the misleading error.
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
