import type { PaneIdentity, TmuxServer } from "./types.js";

export const ATTACH_PLACEHOLDER = "{attach}";
export const PANE_PLACEHOLDER = "{pane}";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function legacyDefaultJumpCommand(target: string): string {
  return `ssh -t ${shellQuote(target)} tmux attach -t ${shellQuote(shellQuote(PANE_PLACEHOLDER))}`;
}

function generatedPaneJumpCommand(target: string): string {
  return `ssh -t ${shellQuote(target)} env LC_CTYPE=C.UTF-8 tmux attach -t ${shellQuote(shellQuote(PANE_PLACEHOLDER))}`;
}

/** Today's remote attach command, represented as an opaque command template. */
export function defaultJumpCommand(target: string): string {
  return `ssh -t ${shellQuote(target)} env LC_CTYPE=C.UTF-8 ${ATTACH_PLACEHOLDER}`;
}

/** Upgrade only murmur's generated defaults; custom commands stay opaque. */
export function currentJumpCommand(template: string, target: string): string {
  return template === legacyDefaultJumpCommand(target) ||
    template === generatedPaneJumpCommand(target)
    ? defaultJumpCommand(target)
    : template;
}

export function tmuxAttachCommand({ server, pane }: PaneIdentity): string {
  const selector =
    server.kind === "default"
      ? ""
      : ` ${server.kind === "label" ? "-L" : "-S"} ${shellQuote(server.value)}`;
  return `tmux${selector} attach -t ${shellQuote(pane)}`;
}

/** Substitute values into a peer-owned transport without parsing or rewriting it. */
export function renderJumpCommand(template: string, destination: PaneIdentity): string {
  return template
    .replaceAll(ATTACH_PLACEHOLDER, shellQuote(tmuxAttachCommand(destination)))
    .replaceAll(PANE_PLACEHOLDER, destination.pane);
}

export function supportsServer(template: string, server: TmuxServer): boolean {
  return server.kind === "default" || !template.includes(PANE_PLACEHOLDER);
}
