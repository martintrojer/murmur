import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { hasWarmSocket, ssh } from "../channel.js";
import { loadIdentity } from "../identity.js";
import { parseSnapshot } from "../snapshot.js";
import { openStore } from "../store.js";
import type { PeerRecord, Snapshot } from "../types.js";
import { age, freshness, STALENESS_MS } from "../view.js";

/**
 * The snapshot document version this node speaks. One number, and the only one
 * the code enforces: `parseSnapshot` rejects anything else outright.
 */
export const SNAPSHOT_VERSION = 1;

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
  if (freshness(fetchedAt, now, STALENESS_MS) === "fresh") return "just now";
  return `${age(now - fetchedAt)} ago`;
}

/**
 * What to show in the VERSION column, and whether the pairing is a problem.
 *
 * The distinction is drawn from what the code actually enforces rather than from
 * taste:
 *
 *   - a differing SNAPSHOT VERSION is a hard incompatibility. `parseSnapshot`
 *     rejects any `murmur_snapshot` other than 1, so state genuinely does not
 *     flow. That is a fact about behaviour, and it is the only thing marked.
 *   - a differing murmur version is worth SHOWING and nothing more. Two nodes on
 *     snapshot 1 running 0.1.3 and 0.2.0 interoperate fine; marking that would
 *     cry wolf on every patch release and train the operator to ignore the
 *     column that is supposed to mean something.
 *
 * A peer we have never heard from is `unknown` and is NOT a mismatch: absence of
 * information is not evidence of incompatibility, and a sleeping peer is the
 * common case here.
 */
export function versionCell(
  peer: Pick<PeerRecord, "murmur_version" | "snapshot_version">,
  ours = SNAPSHOT_VERSION,
): { text: string; incompatible: boolean } {
  if (peer.murmur_version === null && peer.snapshot_version === null) {
    return { text: "unknown", incompatible: false };
  }
  // Answered, but from a build too old to say what it is. Distinct from never
  // having answered: this one is reachable and talking.
  const version = peer.murmur_version ?? "unreported";
  const incompatible = peer.snapshot_version !== null && peer.snapshot_version !== ours;
  // The number appears ONLY when it is the problem. In the normal case it is
  // noise on every row; in the abnormal case it is the whole explanation.
  return {
    text: incompatible ? `${version} (snapshot ${peer.snapshot_version} \u2260 ${ours})` : version,
    incompatible,
  };
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
  snapshot: Snapshot | null;
  selfHostId: string | null;
  peers: PeerRecord[];
}): string | null {
  const { name, target, snapshot, selfHostId, peers } = input;
  // No identity means an unreachable host. It is still added, on the operator's
  // word, and the first successful collect fills in who it is.
  if (!snapshot) return null;

  // Adding yourself would list this node's own panes twice and collect over ssh
  // to reach a database you already hold.
  if (snapshot.host_id === selfHostId) {
    return `${target} is this node; not adding it as a peer\n`;
  }

  // One node, one peer. Two names for one host_id means two ssh round-trips per
  // command and the
  // same machine listed twice, so nothing looks wrong until you notice every
  // collect is doing double the work. Excluding `name` itself keeps re-adding the same
  // peer idempotent, which is how a target gets corrected.
  const existing = peers.find(
    (candidate) => candidate.host_id === snapshot.host_id && candidate.name !== name,
  );
  if (existing) {
    return (
      `${target} is already configured as peer "${existing.name}" ` +
      `(${snapshot.display_name}); remove it first to rename\n`
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
        let snapshot: Snapshot | null = null;
        try {
          // Bare `murmur export`: it takes no options, here or in the collector.
          snapshot = parseSnapshot(await ssh.exec(target, ["murmur", "export"]));
        } catch {
          snapshot = null;
        }

        const refusal = peerAddDecision({
          name,
          target,
          snapshot,
          selfHostId: loadIdentity()?.host_id ?? null,
          peers: store.peers(),
        });
        if (refusal) {
          process.stderr.write(refusal);
          process.exitCode = 1;
          return;
        }

        store.addPeer(name, target);
        // The probe already parsed a valid document, so recording it here means
        // `peer list` can name the host, its version and its snapshot version
        // immediately rather than after the first collect.
        if (snapshot) {
          store.replacePeerSnapshot(name, { ok: true, snapshot, at: Date.now() });
        }
        process.stdout.write(
          snapshot
            ? `Added ${name} (${snapshot.display_name})\n`
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
            // What it is running, or undefined when nothing is known -- either
            // because the host is not a peer yet, or because it is a peer that
            // has never answered. Undefined is what drops the column, so the
            // test is "has anything told us", not "is this configured": a fleet
            // of asleep peers must not buy a column of "unknown".
            version:
              entry === undefined ||
              (entry.murmur_version === null && entry.snapshot_version === null)
                ? undefined
                : versionCell(entry),
            // Named where it can be acted on: a peer that answered with a bad
            // document is reachable but broken, which is an operator task and
            // reads nothing like a sleeping laptop.
            error: entry?.last_error ?? null,
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
        // Same rule as the PEER column, for the same reason: a column every row
        // answers "unknown" to is width spent on nothing. With zero successful
        // collects -- the common case, and one the task calls out -- the table
        // stays exactly as narrow as it is today.
        const showVersionColumn = rows.some((row) => row.version !== undefined);
        process.stdout.write(
          formatTable([
            [
              "NAME",
              "TARGET",
              ...(showPeerColumn ? ["PEER"] : []),
              "HOSTNAME",
              ...(showVersionColumn ? ["VERSION"] : []),
              "LAST SEEN",
              "SSH",
            ],
            ...rows.map((row) => [
              row.name,
              row.target,
              ...(showPeerColumn ? [row.peer ? "yes" : "-"] : []),
              row.hostname ?? "unknown",
              ...(showVersionColumn ? [row.version?.text ?? "-"] : []),
              row.last_seen ?? "-",
              row.ssh,
            ]),
          ]),
        );

        // Named, not just marked in the row: the table cell says WHAT differs
        // and this says what to do about it. Only for a real snapshot-version
        // mismatch, which is the only case where state genuinely cannot sync.
        const incompatible = rows.filter((row) => row.version?.incompatible);
        if (incompatible.length > 0) {
          process.stdout.write(
            `\n${incompatible.length} peer${incompatible.length === 1 ? "" : "s"} speak an incompatible snapshot version; state will not sync until murmur versions match: ${incompatible
              .map((row) => row.name)
              .join(", ")}\n`,
          );
        }

        // A peer that answered with something wrong. Printed after the table
        // rather than in it, because the message is a sentence and a column of
        // sentences is not a table.
        const broken = rows.filter((row) => row.error);
        for (const row of broken) {
          process.stdout.write(`\n${row.name}: last attempt failed -- ${row.error}\n`);
        }

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
