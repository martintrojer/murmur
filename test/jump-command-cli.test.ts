import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { createIdentity } from "../src/identity.js";
import { asPaneId, asSessionId, asWindowId } from "../src/ids.js";
import { openStore } from "../src/store.js";
import type { Driver, Snapshot, TmuxServer } from "../src/types.js";
import { builtArtifact } from "./helpers/built.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "murmur-jump-command-"));
  vi.stubEnv("MURMUR_STATE_DIR", stateDir);
  createIdentity("here");
});

function addPeer(
  name: string,
  target: string,
  panes: Array<{ pane: string; agent: string; driver?: Driver; server?: TmuxServer }>,
): void {
  const store = openStore();
  store.addPeer(name, target, "fake-transport --command {attach}");
  const snapshot: Snapshot = {
    murmur_snapshot: 3,
    host_id: `host-${name}`,
    display_name: name,
    murmur_version: "0.5.0",
    generated_at: 1,
    panes: panes.map(({ pane, agent, driver = "human", server = { kind: "default" } }) => ({
      server,
      pane: asPaneId(pane),
      session: asSessionId("$1"),
      window: asWindowId("@1"),
      session_name: "agents",
      window_name: agent,
      agent: {
        agent_id: `${name}-${pane}`,
        activity: "running",
        agent_name: agent,
        pi_session: null,
        workstream: null,
        role: null,
        cli: "pi",
        driver,
        model: null,
        provider: null,
        effort: null,
        context_pct: null,
        context_tokens: null,
        context_window: null,
        provider_effort: null,
        usage: null,
        claimed_at: 1,
        updated_at: 1,
      },
      attention: [],
    })),
  };
  store.replacePeerSnapshot(name, { ok: true, at: 1, snapshot });
  store.close();
}

function cli(...args: string[]): string {
  return execFileSync(process.execPath, [builtArtifact("cli.js"), ...args], {
    env: { ...process.env, MURMUR_STATE_DIR: stateDir },
    encoding: "utf8",
  });
}

function cliResult(...args: string[]) {
  return spawnSync(process.execPath, [builtArtifact("cli.js"), ...args], {
    env: { ...process.env, MURMUR_STATE_DIR: stateDir },
    encoding: "utf8",
  });
}

test("text output is one command that survives command substitution literally", () => {
  addPeer("dev", "developer.example", [
    { pane: "%34", agent: "coop-job", server: { kind: "label", value: "coop server" } },
  ]);
  const bin = mkdtempSync(join(tmpdir(), "murmur-fake-transport-"));
  const log = join(bin, "argv");
  writeFileSync(join(bin, "fake-transport"), `#!/bin/sh\nprintf '%s\\n' "$@" > "$LOG"\n`);
  chmodSync(join(bin, "fake-transport"), 0o755);

  const stdout = execFileSync(
    "sh",
    ["-c", 'attach="$($NODE $CLI jump-command --host dev --agent coop-job)"; eval "$attach"'],
    {
      env: {
        ...process.env,
        MURMUR_STATE_DIR: stateDir,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        NODE: process.execPath,
        CLI: builtArtifact("cli.js"),
        LOG: log,
      },
      encoding: "utf8",
    },
  );

  expect(stdout).toBe("");
  const rendered = cliResult("jump-command", "--host", "dev", "--agent", "coop-job");
  expect(rendered.status).toBe(0);
  expect(rendered.stdout).toBe(
    "fake-transport --command 'tmux -L '\\''coop server'\\'' attach -t '\\''%34'\\'''\n",
  );
  expect(rendered.stderr).toBe("");
  expect(readFileSync(log, "utf8")).toBe("--command\ntmux -L 'coop server' attach -t '%34'\n");
});

test("JSON has the stable address and rendered-command shape for hidden crew", () => {
  addPeer("dev", "developer.example", [
    {
      pane: "%8",
      agent: "worker-hidden",
      driver: "orchestrated",
      server: { kind: "path", value: "/tmp/coop.sock" },
    },
  ]);

  expect(
    JSON.parse(cli("jump-command", "--host", "dev", "--agent", "worker-hidden", "--json")),
  ).toEqual({
    host: "dev",
    agent: "worker-hidden",
    pane: "%8",
    server: { kind: "path", value: "/tmp/coop.sock" },
    command: "fake-transport --command 'tmux -S '\\''/tmp/coop.sock'\\'' attach -t '\\''%8'\\'''",
  });
});

test("host resolution prefers an exact peer name over another peer's matching target", () => {
  addPeer("dev", "shared", [{ pane: "%1", agent: "worker" }]);
  addPeer("shared", "other-target", [{ pane: "%2", agent: "worker" }]);

  expect(cli("jump-command", "--host", "shared", "--agent", "worker")).toContain("%2");
});

test("a unique exact target resolves to its peer", () => {
  addPeer("dev", "developer.example", [{ pane: "%3", agent: "worker" }]);

  expect(
    cli("jump-command", "--host", "developer.example", "--agent", "worker", "--json"),
  ).toContain('"host":"dev"');
});

test("rendering cached state never executes the configured transport", () => {
  addPeer("dev", "developer.example", [{ pane: "%9", agent: "worker" }]);
  const bin = mkdtempSync(join(tmpdir(), "murmur-no-network-"));
  const marker = join(bin, "called");
  writeFileSync(join(bin, "fake-transport"), `#!/bin/sh\ntouch "$MARKER"\n`);
  chmodSync(join(bin, "fake-transport"), 0o755);

  const result = spawnSync(
    process.execPath,
    [builtArtifact("cli.js"), "jump-command", "--host", "dev", "--agent", "worker"],
    {
      env: {
        ...process.env,
        MURMUR_STATE_DIR: stateDir,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        MARKER: marker,
      },
      encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("fake-transport");
  expect(() => readFileSync(marker)).toThrow();
});

test("missing host fails with exit 2 and lists configured host-agent-pane candidates", () => {
  addPeer("dev", "developer.example", [{ pane: "%7", agent: "available" }]);

  const result = cliResult("jump-command", "--host", "missing", "--agent", "available");

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('host "missing" was not found');
  expect(result.stderr).toContain("dev\tavailable\t%7");
});

test("duplicate peer targets fail with exit 2 and candidate addresses", () => {
  addPeer("dev-a", "shared.example", [{ pane: "%1", agent: "alpha" }]);
  addPeer("dev-b", "shared.example", [{ pane: "%2", agent: "beta" }]);

  const result = cliResult("jump-command", "--host", "shared.example", "--agent", "alpha");

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('host "shared.example" is ambiguous');
  expect(result.stderr).toContain("dev-a\talpha\t%1");
  expect(result.stderr).toContain("dev-b\tbeta\t%2");
});

test("duplicate exact agent names fail with exit 2 and every matching pane", () => {
  addPeer("dev", "developer.example", [
    { pane: "%4", agent: "worker" },
    { pane: "%5", agent: "worker", driver: "orchestrated" },
  ]);

  const result = cliResult("jump-command", "--host", "dev", "--agent", "worker");

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('agent "worker" is ambiguous on dev');
  expect(result.stderr).toContain("dev\tworker\t%4");
  expect(result.stderr).toContain("dev\tworker\t%5");
});

test("missing exact agent fails with exit 2 and lists available candidates", () => {
  addPeer("dev", "developer.example", [{ pane: "%6", agent: "available" }]);

  const result = cliResult("jump-command", "--host", "dev", "--agent", "missing");

  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain('agent "missing" was not found on dev');
  expect(result.stderr).toContain("dev\tavailable\t%6");
});
