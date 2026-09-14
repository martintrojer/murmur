import type { PaneId } from "./ids.js";
import type { Mux } from "./mux.js";

/**
 * The tmux option naming the pane a running `murmur dash` occupies.
 *
 * Server-global, not session- or window-scoped: `--goto` runs from whatever
 * session the operator happens to be in, and a session option would only be
 * readable from the dash's own session -- the one place you never need it.
 */
export const DASH_PANE_OPTION = "@murmur_dash_pane";

/**
 * The tmux option naming the client murmur itself attached for a remote jump.
 *
 * Lives on the REMOTE server, set by a one-shot `client-attached` hook that
 * murmur installs just before its jump attaches. It therefore marks exactly one
 * client: an ordinary human `ssh`+`tmux attach` to the same machine is not
 * murmur-controlled and must keep the ordinary switch behaviour.
 *
 * Stored as `#{client_name} #{client_created}` rather than the name alone. A
 * client name is a tty path, which the OS recycles, so a marker left behind by
 * a dead jump would otherwise make a later, unrelated client detach itself on
 * PREFIX G. The creation time makes the identity unforgeable by coincidence,
 * which is also why nothing has to clear this option on detach.
 */
export const JUMP_CLIENT_OPTION = "@murmur_jump_client";

/**
 * Hook index for the one-shot jump marker.
 *
 * A high index because hook arrays are shared with the user's own config:
 * writing `client-attached` unindexed would REPLACE whatever they had bound.
 * The hook removes itself when it fires, so it cannot mark a second client.
 */
export const JUMP_HOOK_INDEX = 9000;

export type GotoWorld = {
  insideTmux: boolean;
  /** This client as `name created`, or null if tmux would not name it. */
  client: string | null;
  /** The `@murmur_jump_client` marker, in the same shape. */
  jumpClient: string | null;
  dashPane: PaneId | null;
  /** null means tmux did not answer, which is not the same as "none". */
  livePanes: Set<PaneId> | null;
};

export type GotoDecision =
  | { kind: "switch"; pane: PaneId }
  | { kind: "detach"; client: string }
  | { kind: "fail"; message: string };

const NO_DASH =
  "no murmur dash is running on this machine; start one with `murmur dash` and press the key again.";

/**
 * What PREFIX G should do here, decided from tmux options alone.
 *
 * Pure, because the three outcomes are the whole feature and the alternative --
 * asserting on argv through a fake -- would only restate the implementation.
 *
 * Detach OUTRANKS switch, and that order is the point. On a murmur-controlled
 * remote visit the server being asked is the remote one, so "switch to the
 * marked dash" would move the operator to the remote machine's dash, one level
 * deeper into the nesting they are trying to leave. Detaching ends the wrapper's
 * attach, whose own restore command then returns the originating local client.
 */
export function gotoDecision(world: GotoWorld): GotoDecision {
  if (!world.insideTmux) {
    return {
      kind: "fail",
      message: "murmur dash --goto must run inside tmux; bind it to a tmux key.",
    };
  }

  if (world.client && world.jumpClient === world.client) {
    // The option carries `name created`; `detach-client -t` takes the name.
    const [name] = world.client.split(" ");
    if (name) return { kind: "detach", client: name };
  }

  if (!world.dashPane) return { kind: "fail", message: NO_DASH };

  // The PANE is the liveness authority here as everywhere else in murmur: the
  // dash clears this option on exit, but a SIGKILL cannot, so a marker alone
  // proves nothing. A null pane list means tmux would not answer, and refusing
  // on that basis would turn an unreadable tmux into "your dash is gone".
  if (world.livePanes && !world.livePanes.has(world.dashPane)) {
    return { kind: "fail", message: NO_DASH };
  }

  return { kind: "switch", pane: world.dashPane };
}

export type GotoResult = { ok: true } | { ok: false; message: string };

/** Read the world from tmux, decide, and act. The CLI layer only prints. */
export function runGoto(mux: Mux, env: NodeJS.ProcessEnv): GotoResult {
  const decision = gotoDecision({
    insideTmux: Boolean(env.TMUX),
    client: mux.clientIdentity(),
    jumpClient: mux.jumpClientMarker(),
    dashPane: mux.dashPane(),
    livePanes: mux.livePanes(),
  });

  if (decision.kind === "fail") return { ok: false, message: decision.message };
  if (decision.kind === "detach") {
    // Reported, never swallowed. A silently failed goto is indistinguishable
    // from a key that is not bound -- the same symptom the jump path's own
    // "enter did nothing" comment exists to prevent.
    return mux.detachClient(decision.client)
      ? { ok: true }
      : {
          ok: false,
          message: `could not leave this remote session (tmux detach-client failed).`,
        };
  }
  return mux.attach(decision.pane)
    ? { ok: true }
    : {
        ok: false,
        message: `could not reach the murmur dash (tmux switch-client failed).`,
      };
}
