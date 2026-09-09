export const PANE_PLACEHOLDER = "{pane}";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Today's remote attach command, represented as an opaque command template. */
export function defaultJumpCommand(target: string): string {
  return `ssh -t ${shellQuote(target)} tmux attach -t ${shellQuote(shellQuote(PANE_PLACEHOLDER))}`;
}

/** Substitute only murmur's pane placeholder; the rest of the command stays opaque. */
export function renderJumpCommand(template: string, pane: string): string {
  return template.replaceAll(PANE_PLACEHOLDER, pane);
}
