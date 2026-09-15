#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderJumpCommand } from "../dist/index.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const coopRoot = process.env.COOP_REPO;
if (!coopRoot) {
  console.error("usage: COOP_REPO=/path/to/coop npm run test:private-tmux-e2e");
  process.exit(2);
}

const state = mkdtempSync(join(tmpdir(), "murmur-coop-e2e-"));
const socket = "coop";
const id = "c00e2e";
const jobRoot = join(state, "coop", "jobs", id);
const murmurState = join(state, "murmur");
const env = { ...process.env, MURMUR_STATE_DIR: murmurState, XDG_STATE_HOME: state };
const run = (file, args, options = {}) =>
  execFileSync(file, args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
const tmux = (...args) => run("tmux", ["-L", socket, "-f", "/dev/null", ...args]);

let socketPath;
let ownsServer = false;
try {
  run(process.execPath, [join(root, "dist/cli.js"), "init", "--name", "coop-e2e"]);
  const command = [
    `MURMUR_STATE_DIR=${JSON.stringify(murmurState)}`,
    `node ${JSON.stringify(join(root, "test/helpers/private-claimant.mjs"))}`,
  ].join(" ");
  run("cargo", ["test", "--manifest-path", join(coopRoot, "Cargo.toml"), "--no-run"]);
  const probe = run("cargo", [
    "run",
    "--quiet",
    "--manifest-path",
    join(coopRoot, "Cargo.toml"),
    "--bin",
    "coop",
    "--",
    "--version",
  ]);
  if (!probe.includes("0.1.2")) throw new Error(`wrong coop build: ${probe}`);

  // coop's generated wrapper is already covered by its default suite. This
  // opt-in cross-repo check runs the same final shell under a real private tmux
  // server without requiring sshd, a model provider, or the internet.
  try {
    tmux("list-sessions");
    throw new Error("local tmux -L coop is already in use; refusing to disturb it");
  } catch (error) {
    if (error instanceof Error && error.message.includes("refusing")) throw error;
  }
  tmux("new-session", "-d", "-s", "keeper", "sleep 30");
  ownsServer = true;
  tmux(
    "new-session",
    "-d",
    "-s",
    `coop-${id}`,
    `env MU_MANAGED_AGENT=1 MU_AGENT_NAME=coop-${id} MU_WORKSTREAM=e2e sh -c ${JSON.stringify(command)}`,
  );
  socketPath = tmux("display-message", "-p", "#{socket_path}");

  const deadline = Date.now() + 5000;
  let snapshot;
  do {
    snapshot = JSON.parse(run(process.execPath, [join(root, "dist/cli.js"), "export"]));
    if (snapshot.panes.length === 1) break;
  } while (Date.now() < deadline);
  const pane = snapshot.panes[0];
  if (!pane) throw new Error("claimant did not appear");
  if (pane.server.kind !== "label" || pane.server.value !== socket)
    throw new Error(`wrong server: ${JSON.stringify(pane.server)}`);
  if (pane.agent?.driver !== "orchestrated" || pane.agent.agent_name !== `coop-${id}`)
    throw new Error(`not crew: ${JSON.stringify(pane.agent)}`);

  const second = JSON.parse(run(process.execPath, [join(root, "dist/cli.js"), "export"]));
  if (!second.panes.some((candidate) => candidate.pane === pane.pane))
    throw new Error("claimant disappeared during export liveness");

  const attach = renderJumpCommand("x2ssh -et dev -c {attach}", pane);
  if (!attach.includes("tmux -L") || !attach.includes(socket) || !attach.includes("attach -t"))
    throw new Error(`bad attach: ${attach}`);

  tmux("kill-session", "-t", `=coop-${id}`);
  const gone = JSON.parse(run(process.execPath, [join(root, "dist/cli.js"), "export"]));
  if (gone.panes.length !== 0)
    throw new Error(`claimant survived kill: ${JSON.stringify(gone.panes)}`);

  console.log(`crew=1 server=label:${socket} agent=coop-${id}`);
  console.log(`export_survived=1 pane=${pane.pane}`);
  console.log(`attach=${attach}`);
  console.log("after_kill=0");
} finally {
  if (ownsServer) {
    try {
      tmux("kill-server");
    } catch {}
  }
  if (ownsServer && socketPath) rmSync(socketPath, { force: true });
  rmSync(jobRoot, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
