/**
 * SGR mouse for murmur dash. No Ink onClick yet (upstream PR), so we enable
 * xterm button+SGR modes and hit-test with measureElement ourselves.
 */

export type MouseButton = "left" | "middle" | "right" | "up" | "down" | "other";

export type MouseEvent = {
  kind: "press" | "release" | "move" | "wheel";
  button: MouseButton;
  /** 0-based column in the terminal. */
  x: number;
  /** 0-based row in the terminal. */
  y: number;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const ENABLE = `${String.fromCharCode(27)}[?1000h${String.fromCharCode(27)}[?1006h`;
const DISABLE = `${String.fromCharCode(27)}[?1000l${String.fromCharCode(27)}[?1006l`;
const SGR_PATTERN = `${String.fromCharCode(27)}\\[<(\\d+);(\\d+);(\\d+)([Mm])`;
const SGR = new RegExp(SGR_PATTERN, "g");

export function enableMouse(stream: { write: (chunk: string) => unknown } = process.stdout): void {
  stream.write(ENABLE);
}

export function disableMouse(stream: { write: (chunk: string) => unknown } = process.stdout): void {
  stream.write(DISABLE);
}

function decodeButton(code: number, release: boolean): Pick<MouseEvent, "kind" | "button"> {
  if (code & 32 && !(code & 64)) {
    return { kind: "move", button: "other" };
  }
  if (code & 64) {
    const wheel = code & 3;
    return {
      kind: "wheel",
      button: wheel === 0 ? "up" : wheel === 1 ? "down" : "other",
    };
  }
  const buttonCode = code & 3;
  const button: MouseButton =
    buttonCode === 0 ? "left" : buttonCode === 1 ? "middle" : buttonCode === 2 ? "right" : "other";
  return { kind: release ? "release" : "press", button };
}

/**
 * Pull complete SGR mouse packets out of a stdin chunk. Incomplete tails stay
 * in `rest` for the next read.
 */
export function parseMouseEvents(chunk: string): { events: MouseEvent[]; rest: string } {
  const events: MouseEvent[] = [];
  let last = 0;
  SGR.lastIndex = 0;
  for (const match of chunk.matchAll(SGR)) {
    const code = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const release = match[4] === "m";
    if (!Number.isFinite(code) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const decoded = decodeButton(code, release);
    events.push({
      ...decoded,
      // SGR reports 1-based cells; Yoga/measureElement are 0-based.
      x: Math.max(0, x - 1),
      y: Math.max(0, y - 1),
    });
    last = (match.index ?? 0) + match[0].length;
  }

  // Keep a partial CSI at the end; drop consumed bytes.
  const tail = chunk.slice(last);
  const partial = tail.lastIndexOf("\x1b");
  if (partial === -1) return { events, rest: "" };
  if (tail.slice(partial).includes("\x1b[<") && !/[Mm]$/.test(tail.slice(partial))) {
    return { events, rest: tail.slice(partial) };
  }
  return { events, rest: "" };
}

export function pointInRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export type ClickMemory = { key: string; at: number };

/**
 * Single click vs double click on the same target. `windowMs` is the gap that
 * still counts as a double.
 */
export function classifyClick(
  previous: ClickMemory | null,
  key: string,
  now: number,
  windowMs = 400,
): { double: boolean; next: ClickMemory } {
  const double = previous !== null && previous.key === key && now - previous.at <= windowMs;
  return { double, next: { key, at: now } };
}

/** Clamp a glance line offset into the scrollable range. */
export function clampGlanceScroll(offset: number, lineCount: number, visibleLines: number): number {
  if (lineCount <= 0) return 0;
  const max = Math.max(0, lineCount - Math.max(1, visibleLines));
  return Math.max(0, Math.min(max, offset));
}
