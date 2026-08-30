import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { hasWarmSocket, ssh } from "../channel.js";
import { STALENESS_MS } from "../collector.js";
import type { Envelope } from "../export.js";
import { age, isStale } from "../fold.js";
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
/**
 * How long since a peer last answered.
 *
 * `never` is deliberately distinct from an age: a peer that has never answered
 * is a setup problem (wrong target, murmur not installed there), while an old
 * age is an ordinary sleeping node. Uses the same fetched_at and threshold the
 * picker does, so the two cannot disagree about one peer.
 */
export function lastSeen(fetchedAt: number | null, now: number): string {
  if (fetchedAt === null) return "never";
  if (!isStale(fetchedAt, now, STALENESS_MS)) return "just now";
  return `${age(now - fetchedAt)} ago`;
}

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
    .description("List peers; --all adds SSH hosts that could become peers")
    .option("--json", "print JSON")
    .option("-a, --all", "also show SSH hosts that are not peers yet")
    .action((options: { json?: boolean; all?: boolean }) => {
      const store = openStore();
      try {
        // `list` and `discover` were two halves of one question -- "what hosts
        // can murmur see, and which of them are up?" -- and discover needed a
        // PEER column and a LAST SEEN column to be readable at all, at which
        // point it WAS list plus the unadded hosts. Merged into this one, with
        // the unadded hosts behind --all.
        //
        // Peers are the default because that is what the command is called and
        // what it is used for: the everyday question is "are my peers up?", not
        // "what could I add?", which is a setup-time question asked once.
        //
        // --all is the union of configured targets and ssh hosts, not ssh hosts
        // alone: `peer add` accepts any ssh target, so a peer can be an IP, a
        // user@host, or a Tailscale name that appears in no config file, and
        // listing ssh hosts alone would silently omit it.
        const peers = store.peers();
        const configured = new Map(peers.map((entry) => [entry.target, entry]));
        const discovered = options.all ? sshHosts().filter((host) => !configured.has(host)) : [];
        const now = Date.now();

        const rows = [...configured.keys(), ...discovered].map((target) => {
          const entry = configured.get(target);
          return {
            // The handle other commands take: a peer's name, or for a host that
            // is not one yet, the ssh host `peer add` wants.
            name: entry?.name ?? target,
            target,
            peer: entry !== undefined,
            // What the node called itself. Shown, never typed: it can be a
            // container id.
            hostname: entry?.display_name ?? null,
            // Being a peer is not the same as being reachable, and the old
            // output said only the first. A node asleep for twelve hours read
            // exactly like one polled a second ago.
            last_seen: entry === undefined ? null : lastSeen(entry.fetched_at, now),
            // A warm ControlMaster socket makes a collect ~10ms instead of
            // ~170ms, and is the only path that works on a host demanding a
            // hardware-token touch per connection. A speed hint, never a
            // requirement -- which is why the old bare `[x]` / `[ ]` was
            // unreadable: it never said what was being checked.
            //
            // Safe for every row: `ssh -O check` talks to a local socket and
            // never dials, so a host that is down or does not exist answers in
            // ~16ms. Measured.
            ssh: hasWarmSocket(target) ? "warm" : "cold",
          };
        });

        if (options.json) {
          process.stdout.write(`${JSON.stringify(rows)}\n`);
          return;
        }
        if (rows.length === 0) {
          // Point at the flag that answers the obvious next question, but only
          // when it would actually show something.
          process.stdout.write(
            options.all
              ? "no peers configured, and no hosts in ~/.ssh/config\n"
              : "no peers configured. See what could be added with: murmur peer list --all\n",
          );
          return;
        }

        // The PEER column only earns its width when the table mixes both kinds.
        // Without --all every row would read "yes", which is a column that says
        // nothing.
        const showPeerColumn = rows.some((row) => !row.peer);
        process.stdout.write(
          formatTable([
            ["NAME", "TARGET", ...(showPeerColumn ? ["PEER"] : []), "HOSTNAME", "LAST SEEN", "SSH"],
            ...rows.map((row) => [
              row.name,
              row.target,
              ...(showPeerColumn ? [row.peer ? "yes" : "-"] : []),
              row.hostname ?? "unknown",
              row.last_seen ?? "-",
              row.ssh,
            ]),
          ]),
        );

        const addable = rows.filter((row) => !row.peer).length;
        if (addable > 0) {
          process.stdout.write(
            `\n${addable} host${addable === 1 ? "" : "s"} not yet a peer. Add one with: murmur peer add <name>\n`,
          );
        }
      } finally {
        store.close();
      }
    });
}
