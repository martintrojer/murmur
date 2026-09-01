/**
 * tmux's three id kinds, kept apart by the type system.
 *
 * tmux prints a sigil on every id -- `session=$25  window=@75  pane=%89` -- but
 * they are all strings, so murmur could and did pass one where another was
 * meant. Twice, in shipped code: a sweep keyed on window liveness deleted ten
 * live agents, and a window cached at extension startup badged the window a
 * moved pane had left.
 *
 * An agent is addressed by its PANE, which survives `move-pane`, `break-pane`
 * and a window closed and reopened. A session and a window are only where that
 * pane currently lives and may differ between two reports from one agent. Hence
 * the rule the brands enforce: only a pane may decide whether an agent exists.
 *
 * Compile-time fiction -- at runtime these are the strings tmux printed, which
 * keeps the snapshot document and every stored row byte-identical.
 */

declare const brand: unique symbol;

/** A tmux session id, `$N`. Mutable location. */
export type SessionId = string & { readonly [brand]: "session" };

/** A tmux window id, `@N`. Mutable location -- never an agent's identity. */
export type WindowId = string & { readonly [brand]: "window" };

/** A tmux pane id, `%N`. The agent's identity, stable for its whole life. */
export type PaneId = string & { readonly [brand]: "pane" };

/*
 * The boundary. Every raw string that becomes an id passes through one of these
 * three, so the unsafe step is countable rather than an `as` at each call site.
 *
 * Deliberately not validating the sigil: these run on tmux stdout, JSON off the
 * wire, sqlite rows and argv, and an id murmur does not recognise -- a future
 * tmux, a different harness -- must still round-trip. Rejecting here would turn
 * a naming change into a behaviour change.
 */

export function asSessionId(raw: string): SessionId {
  return raw as SessionId;
}

export function asWindowId(raw: string): WindowId {
  return raw as WindowId;
}

export function asPaneId(raw: string): PaneId {
  return raw as PaneId;
}
