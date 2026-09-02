import { expect, test } from "vitest";
import { warmSocketCommand } from "../src/channel.js";

test("the warm-socket remedy opens no session of its own", () => {
  const command = warmSocketCommand("dev");

  // `-N` is the one flag whose absence made the remedy CAUSE the symptom.
  //
  // A host may cap session channels per connection (`MaxSessions 1` on the
  // devvm this was found on). `ssh -M <host>` opens an interactive shell, and
  // that shell OCCUPIES the single slot -- so while the reader sits at the
  // prompt the picker told them to open, every collect over the socket is
  // refused with `Session open refused by peer`. The notice then stays up,
  // pointing at the command that is holding the peer hostage. Verified against
  // dev: a held session channel refuses the next collect, and freeing it lets
  // the same collect succeed.
  //
  // `-N` requests no remote command, so the master authenticates and then
  // consumes nothing. The reader gets their prompt back and murmur gets the
  // slot.
  //
  // Matched as a flag GROUP rather than a standalone ` -N`: the flags are
  // combined as `-MNf`, and asserting the spaced form only proved the test
  // could not read its own subject.
  expect(command).toMatch(/\s-[A-Za-z]*N/);

  // `-M` still creates the master and `-S` still places the socket where
  // `SSH_OPTIONS` looks: OpenSSH defaults to `ControlMaster no` and
  // `ControlPath none`, so neither is redundant on a machine whose ssh_config
  // murmur does not control.
  expect(command).toMatch(/\s-[A-Za-z]*M/);
  expect(command).toContain("-S ~/.ssh/control/%r@%h:%p");

  // `-f` so it backgrounds itself after auth. Without it the reader must leave
  // a terminal parked on a command that prints nothing, which reads like a
  // hang.
  expect(command).toMatch(/\s-[A-Za-z]*f/);

  // The target is last, and unquoted: it is pasted verbatim.
  expect(command.endsWith(" dev")).toBe(true);
});
