export const PANE_PLACEHOLDER = "{pane}";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function legacyDefaultJumpCommand(target: string): string {
  return `ssh -t ${shellQuote(target)} tmux attach -t ${shellQuote(shellQuote(PANE_PLACEHOLDER))}`;
}

/** Today's remote attach command, represented as an opaque command template. */
export function defaultJumpCommand(target: string): string {
  return `ssh -t ${shellQuote(target)} env LC_CTYPE=C.UTF-8 tmux attach -t ${shellQuote(shellQuote(PANE_PLACEHOLDER))}`;
}

/** Upgrade only murmur's previous generated default; custom commands stay opaque. */
export function currentJumpCommand(template: string, target: string): string {
  return template === legacyDefaultJumpCommand(target) ? defaultJumpCommand(target) : template;
}

/** Substitute only murmur's pane placeholder; the rest of the command stays opaque. */
export function renderJumpCommand(template: string, pane: string): string {
  return template.replaceAll(PANE_PLACEHOLDER, pane);
}
