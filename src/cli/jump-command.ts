import type { Command } from "commander";
import { currentJumpCommand, renderJumpCommand } from "../jump-command.js";
import { openStore, type Store } from "../store.js";
import type { PeerRecord, SnapshotPane, TmuxServer } from "../types.js";

export type JumpCommandOptions = { host: string; agent: string; json?: boolean };

export type JumpCommandResult = {
  host: string;
  agent: string;
  pane: string;
  server: TmuxServer;
  command: string;
};

function candidate(peer: PeerRecord, pane?: SnapshotPane): string {
  return pane
    ? `${peer.name}\t${pane.agent?.agent_name ?? "-"}\t${pane.pane}`
    : `${peer.name}\t-\t-`;
}

function fail(message: string, candidates: string[]): never {
  process.stderr.write(`${message}\nCandidates (host\tagent\tpane):\n${candidates.join("\n")}\n`);
  process.exitCode = 2;
  throw new JumpCommandError();
}

class JumpCommandError extends Error {}

/** Resolve and render exclusively from the store's cached peer snapshots. */
export function jumpCommand(store: Store, options: JumpCommandOptions): JumpCommandResult {
  const peers = store.peers();
  const byName = peers.filter((peer) => peer.name === options.host);
  const hosts = byName.length > 0 ? byName : peers.filter((peer) => peer.target === options.host);
  if (hosts.length !== 1) {
    const candidates = (hosts.length > 0 ? hosts : peers).flatMap((peer) => {
      const panes = peer.snapshot?.panes.filter((pane) => pane.agent?.agent_name) ?? [];
      return panes.length > 0 ? panes.map((pane) => candidate(peer, pane)) : [candidate(peer)];
    });
    fail(
      hosts.length > 1
        ? `host ${JSON.stringify(options.host)} is ambiguous`
        : `host ${JSON.stringify(options.host)} was not found`,
      candidates,
    );
  }

  const peer = hosts[0];
  if (!peer) throw new Error("unreachable");
  const panes = peer.snapshot?.panes ?? [];
  const matches = panes.filter((pane) => pane.agent?.agent_name === options.agent);
  if (matches.length !== 1) {
    fail(
      matches.length > 1
        ? `agent ${JSON.stringify(options.agent)} is ambiguous on ${peer.name}`
        : `agent ${JSON.stringify(options.agent)} was not found on ${peer.name}`,
      (matches.length > 0 ? matches : panes.filter((pane) => pane.agent?.agent_name)).map((pane) =>
        candidate(peer, pane),
      ),
    );
  }

  const pane = matches[0];
  if (!pane?.agent?.agent_name) throw new Error("unreachable");
  return {
    host: peer.name,
    agent: pane.agent.agent_name,
    pane: pane.pane,
    server: pane.server,
    command: renderJumpCommand(currentJumpCommand(peer.jump_command, peer.target), pane),
  };
}

export function registerJumpCommand(program: Command): void {
  program
    .command("jump-command")
    .description("Render a cached agent's jump command without connecting")
    .requiredOption("--host <host>", "exact peer name or unique exact peer target")
    .requiredOption("--agent <agent>", "exact agent name, including orchestrated agents")
    .option("--json", "print host, agent, pane, server, and command as JSON")
    .action((options: JumpCommandOptions) => {
      const store = openStore();
      try {
        const result = jumpCommand(store, options);
        process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.command}\n`);
      } catch (error) {
        if (!(error instanceof JumpCommandError)) throw error;
      } finally {
        store.close();
      }
    });
}
