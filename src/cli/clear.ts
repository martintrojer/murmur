import Database from "better-sqlite3";
import type { Command } from "commander";
import { loadIdentity } from "../identity.js";
import { type Mux, tmux } from "../mux.js";
import { dbPath } from "../paths.js";
import { openStore } from "../store.js";
import type { Driver } from "../types.js";

type OwnedPane = {
  agent_id: string;
  session_name: string | null;
  window_name: string | null;
  agent_name: string | null;
  pi_session: string | null;
  session: string;
  window: string;
  pane: string;
  workstream: string | null;
  role: string | null;
  cli: string | null;
  driver: Driver | null;
  state: string;
};

export function clearPane(pane: string, mux: Mux = tmux): void {
  try {
    if (!pane) return;

    // The badge is a tmux window option, not murmur state, so clearing it never
    // needs murmur to know anything. Resolve the window up front: an
    // uninitialised node or a missing database must still clear rather than
    // abort the hook.
    const window = mux.windowForPane(pane);
    const identity = loadIdentity();

    let owner: OwnedPane | undefined;
    if (identity) {
      try {
        const database = new Database(dbPath(), { readonly: true, fileMustExist: true });
        try {
          owner = database
            .prepare(
              `SELECT agent_id, session, window, pane, session_name, window_name,
                      agent_name, pi_session, workstream, role, cli, driver, state
                 FROM events
                WHERE host_id = ? AND agent_id = ?
                ORDER BY seq DESC
                LIMIT 1`,
            )
            .get(identity.host_id, `${identity.host_id}:${pane}`) as OwnedPane | undefined;
        } finally {
          database.close();
        }
      } catch {
        // No database yet. Nothing is owned; the badge still clears below.
      }
    }

    // A pane murmur has no event for can still carry a badge: an orphan from
    // the agent-attention era, or a window murmur never recorded. Left alone it
    // sits in the status bar and the tms picker forever, because nothing else
    // will ever clear it.
    if (!owner) {
      if (window) mux.setState(window, null);
      return;
    }
    if (owner.state === "cleared") return;

    const store = openStore();
    try {
      store.append({
        agent_id: owner.agent_id,
        session: owner.session,
        window: owner.window,
        pane: owner.pane,
        // Carry the names forward: a `cleared` row that drops them makes the
        // agent's last event nameless, which is what left "@75" in the picker.
        session_name: owner.session_name,
        window_name: owner.window_name,
        agent_name: owner.agent_name,
        pi_session: owner.pi_session,
        workstream: owner.workstream,
        role: owner.role,
        cli: owner.cli,
        driver: owner.driver,
        kind: "state",
        state: "cleared",
        message: "",
        pid: null,
        synthetic: false,
        reason: "",
        extra: {},
      });
    } finally {
      store.close();
    }
    mux.setState(owner.window, null);
  } catch {
    // Focus hooks run inside the tmux server: they must always be silent and total.
  }
}

export function registerClear(program: Command): void {
  program
    .command("clear")
    .description("Clear attention for the agent in a pane")
    .option("--pane <pane-id>", "focused tmux pane id")
    .action((options: { pane?: string }) => clearPane(options.pane ?? ""));
}
