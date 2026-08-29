import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { hasWarmSocket, ssh } from "../channel.js";
import type { Envelope } from "../export.js";
import { loadIdentity } from "../identity.js";
import { openStore } from "../store.js";
import type { Peer } from "../types.js";

export function parseSshHosts(config: string): string[] {
  const hosts: string[] = [];
  for (const line of config.split("\n")) {
    const tokens = line.replace(/#.*$/, "").trim().split(/\s+/);
    if (tokens[0]?.toLowerCase() !== "host") continue;
    for (const host of tokens.slice(1)) {
      if (!/[*?!]/.test(host)) hosts.push(host);
    }
  }
  return hosts;
}

function sshHosts(): string[] {
  try {
    return parseSshHosts(readFileSync(join(homedir(), ".ssh", "config"), "utf8"));
  } catch {
    return [];
  }
}

/**
 * Column-aligned plain text. Rows are all-ASCII here (peer names, ssh targets
 * and hostnames), so `length` is a fine width; trailing cells are not padded so
 * the output stays clean for `cut` and friends.
 */
export function formatTable(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
        .join("  ")
        .trimEnd(),
    )
    .map((line) => `${line}\n`)
    .join("");
}

/**
 * Whether `peer add` must refuse, and what to say. Returns null to proceed.
 *
 * Split out of the commander action because that action opens a store, shells
 * out over ssh and sets process.exitCode, so the rules below were unreachable
 * from a test: the suite ended up asserting a reimplementation of this lookup
 * instead, and disabling the real branch left it green.
 */
export function peerAddDecision(input: {
  name: string;
  target: string;
  envelope: Envelope | null;
  selfHostId: string | null;
  peers: Peer[];
}): string | null {
  const { name, target, envelope, selfHostId, peers } = input;
  // No identity means an unreachable host. It is still added, on the operator's
  // word, and the first successful collect fills in who it is.
  if (!envelope) return null;

  // Adding yourself would fold your own events back in as a "remote" host and
  // collect over ssh to reach a database you already hold.
  if (envelope.host_id === selfHostId) {
    return `${target} is this node; not adding it as a peer\n`;
  }

  // One node, one peer. Two names for one host_id means two ssh round-trips per
  // command and the same machine listed twice; the events dedupe on
  // (host_id, seq), so nothing looks wrong until you notice every collect is
  // doing double the work. Excluding `name` itself keeps re-adding the same
  // peer idempotent, which is how a target gets corrected.
  const existing = peers.find(
    (candidate) => candidate.host_id === envelope.host_id && candidate.name !== name,
  );
  if (existing) {
    return (
      `${target} is already configured as peer "${existing.name}" ` +
      `(${envelope.display_name}); remove it first to rename\n`
    );
  }
  return null;
}

export function registerPeer(program: Command): void {
  const peer = program.command("peer").description("Manage peers");

  peer
    .command("add")
    .description("Add a peer and discover its identity")
    // The decision itself is `peerAddDecision` below, so it can be tested
    // without an ssh binary or a commander harness.
    .argument("<name>")
    .argument("[target]")
    .action(async (name: string, target = name) => {
      const store = openStore();
      try {
        // Probe BEFORE writing. Identity is discovered, so the probe is what
        // tells us whether this is a node we already have under another name
        // — and a peer written first would be found by its own duplicate
        // check.
        let envelope: Envelope | null = null;
        try {
          const output = await ssh.exec(target, ["murmur", "export", "--since", "0"]);
          envelope = JSON.parse(output.trim().split("\n")[0] ?? "") as Envelope;
        } catch {
          envelope = null;
        }

        const refusal = peerAddDecision({
          name,
          target,
          envelope,
          selfHostId: loadIdentity()?.host_id ?? null,
          peers: store.peers(),
        });
        if (refusal) {
          process.stderr.write(refusal);
          process.exitCode = 1;
          return;
        }

        store.upsertPeer({
          name,
          target,
          host_id: envelope?.host_id ?? null,
          display_name: envelope?.display_name ?? null,
        });
        process.stdout.write(
          envelope
            ? `Added ${name} (${envelope.display_name})\n`
            : `Added ${name} (identity pending)\n`,
        );
      } finally {
        store.close();
      }
    });

  peer
    .command("remove")
    .description("Remove a peer")
    .argument("<name>", "peer to remove")
    .action((name: string) => {
      const store = openStore();
      try {
        if (store.removePeer(name)) process.stdout.write(`Removed ${name}\n`);
        else {
          process.stderr.write(`no such peer: ${name}\n`);
          process.exitCode = 1;
        }
      } finally {
        store.close();
      }
    });

  peer
    .command("list")
    .description("List configured peers")
    .option("--json", "print JSON")
    .action((options: { json?: boolean }) => {
      const store = openStore();
      try {
        const peers = store.peers();
        if (options.json) {
          process.stdout.write(`${JSON.stringify(peers)}\n`);
          return;
        }
        if (peers.length === 0) {
          process.stdout.write("no peers configured\n");
          return;
        }
        const rows = [
          // HOSTNAME, not HOST: this is what the node reported about itself,
          // which is not the handle any other command takes. NAME is.
          ["NAME", "TARGET", "HOSTNAME"],
          ...peers.map((configured) => [
            configured.name,
            configured.target,
            configured.display_name ?? "unknown",
          ]),
        ];
        process.stdout.write(formatTable(rows));
      } finally {
        store.close();
      }
    });

  peer
    .command("discover")
    .description("Check SSH hosts for warm control sockets")
    .action(() => {
      for (const host of sshHosts()) {
        process.stdout.write(`${hasWarmSocket(host) ? "[x]" : "[ ]"} ${host}\n`);
      }
    });
}
