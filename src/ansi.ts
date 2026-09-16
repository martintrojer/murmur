/**
 * The escape-sequence rules the dash preview lives by.
 *
 * A pane's colours are the fastest signal a reader has: red test output, a green
 * diff, the inverse block of a selection. `capture-pane -e` hands those back, so
 * the preview can show what the pane actually looks like instead of a grey slab.
 *
 * That makes the dash a consumer of arbitrary terminal bytes, and only one class
 * of them is safe. SGR (`CSI ... m`) paints the cell in place and cannot move
 * anywhere; everything else in the repertoire either leaves the preview box
 * (cursor movement, erases, scroll regions) or does something to the operator's
 * machine (OSC 52 clipboard writes, titles, sixel and kitty image payloads).
 * Hence the shape here: an allow-list of one sequence type, and a scanner that
 * drops the rest rather than a sanitiser that pattern-matches known offenders.
 *
 * Hand-written rather than a parser dependency, because the grammar this needs
 * is one function: ECMA-48 fixes the terminators, and nothing here interprets
 * parameters -- SGR is copied through verbatim, so truecolor, colon-delimited
 * T.416 forms, and attributes murmur has never heard of all work without a
 * table to keep current.
 */

const ESC = "\u001b";
const BEL = "\u0007";
/** Terminates the string-family sequences (DCS/OSC/SOS/PM/APC). */
const ST = `${ESC}\\`;
export const SGR_RESET = `${ESC}[0m`;

export type AnsiToken = {
  /** `sgr` is copied through verbatim; `text` is printable. Nothing else survives. */
  kind: "sgr" | "text";
  value: string;
};

/** Where a string-family sequence ends: at ST, or at the BEL xterm also accepts. */
function endOfString(value: string, from: number): number {
  const st = value.indexOf(ST, from);
  const bel = value.indexOf(BEL, from);
  if (st === -1 && bel === -1) return value.length;
  if (st === -1) return bel + BEL.length;
  if (bel === -1) return st + ST.length;
  return st < bel ? st + ST.length : bel + BEL.length;
}

/**
 * Printable, per code point.
 *
 * Newline is the line structure every consumer below is built from, and tab is
 * expanded at its column stops by `expandTabs` -- so both are text. The rest of
 * C0, DEL, and the C1 block are dropped: a bare CR overprints the row, a BEL
 * rings the operator's terminal once per redraw, and the C1 bytes are the
 * single-byte spellings of the escapes this file already refuses.
 */
function printable(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  if (character === "\n" || character === "\t") return true;
  if (code < 0x20 || code === 0x7f) return false;
  return !(code >= 0x80 && code <= 0x9f);
}

/**
 * Split terminal bytes into the tokens that survive, dropping everything else.
 *
 * Idempotent: a string that has already been through here contains only SGR and
 * printable text, so the downstream passes (clip, tab expansion, per-line reset)
 * can each scan again without a flag saying whether sanitation has happened.
 */
export function scan(value: string): AnsiToken[] {
  const tokens: AnsiToken[] = [];
  let text = "";
  const flush = () => {
    if (text) tokens.push({ kind: "text", value: text });
    text = "";
  };

  let index = 0;
  while (index < value.length) {
    const character = value[index] ?? "";
    if (character !== ESC) {
      if (printable(character)) text += character;
      index += 1;
      continue;
    }

    const introducer = value[index + 1];
    // A dangling ESC at the end of a capture -- tmux truncates mid-sequence
    // whenever the pane was written to while it read. Dropped, not printed.
    if (introducer === undefined) {
      index = value.length;
      continue;
    }
    if (introducer === "[") {
      // CSI: parameter and intermediate bytes, then one final byte. `m` is SGR
      // and the only one kept; `H`, `J`, `K`, `A`-`D` and friends move or erase.
      let cursor = index + 2;
      while (cursor < value.length) {
        const code = value.charCodeAt(cursor);
        if (code >= 0x40 && code <= 0x7e) break;
        cursor += 1;
      }
      const final = value[cursor];
      if (final === "m") {
        flush();
        tokens.push({ kind: "sgr", value: value.slice(index, cursor + 1) });
      }
      index = cursor === value.length ? value.length : cursor + 1;
      continue;
    }
    if (introducer === "]" || introducer === "P" || "X^_".includes(introducer)) {
      // The string family: OSC (titles, clipboard, OSC 8 hyperlinks), DCS
      // (sixel), APC (kitty graphics), SOS and PM. Payload and terminator go;
      // for a hyperlink the wrapped label survives because it is ordinary text
      // between two of these sequences.
      index = endOfString(value, index + 2);
      continue;
    }
    // Everything else is a two- or three-byte escape: charset selection
    // (`ESC ( B`), keypad modes, RIS, index and save/restore cursor.
    let cursor = index + 1;
    while (cursor < value.length) {
      const code = value.charCodeAt(cursor);
      cursor += 1;
      if (!(code >= 0x20 && code <= 0x2f)) break;
    }
    index = cursor;
  }
  flush();
  return tokens;
}

/** Does this SGR return the cell to its defaults, so nothing is left in force? */
function isReset(sgr: string): boolean {
  const parameters = sgr.slice(2, -1);
  return parameters.split(";").every((parameter) => /^0*$/.test(parameter));
}

/** Terminal bytes reduced to SGR plus printable text: what a preview may show. */
export function sgrOnly(value: string): string {
  return scan(value)
    .map((token) => token.value)
    .join("");
}

/**
 * The same text with the styling removed as well.
 *
 * For anything that is read as a STRING rather than painted: a card summary the
 * filter matches against, and the compact table's column measurements. Escape
 * bytes there made a search for a word whose colour changed mid-line miss, and
 * every width wrong.
 */
export function plainText(value: string): string {
  return scan(value)
    .filter((token) => token.kind === "text")
    .map((token) => token.value)
    .join("");
}

/**
 * Visible columns, which is the only width any layout here cares about.
 *
 * Counted per code point, matching what the rest of murmur has always measured;
 * the point of this function is that escape bytes score zero, not a change of
 * grapheme policy.
 */
export function visibleWidth(value: string): number {
  return [...plainText(value)].length;
}

/**
 * Clip to visible columns without ever cutting inside an escape sequence.
 *
 * A byte-index clip did both halves of this wrong: it counted escape bytes
 * toward the width, so a coloured line was clipped far short of the edge, and it
 * could cut mid-sequence -- leaving the terminal holding `ESC [ 3` and
 * swallowing the following text while it waited for a final byte, which blanked
 * the rest of the line.
 *
 * Styles that opened before the cut are kept, because the surviving text must
 * look the way it did in the pane, and a reset is appended when anything is
 * still in force at the edge so the style cannot escape into the dash chrome.
 *
 * Returns the input unchanged when it fits, and ignores a width of zero or less:
 * a narrow terminal must still show something.
 */
export function clipToWidth(value: string, width: number): string {
  if (width <= 0 || visibleWidth(value) <= width) return value;
  let out = "";
  let used = 0;
  let styled = false;
  for (const token of scan(value)) {
    if (token.kind === "sgr") {
      out += token.value;
      styled = !isReset(token.value);
      continue;
    }
    for (const character of token.value) {
      if (used >= width) break;
      out += character;
      used += 1;
    }
    if (used >= width) break;
  }
  return styled ? out + SGR_RESET : out;
}

/**
 * End every styled line reset, so no pane's styling outlives its own row.
 *
 * tmux captures half-drawn output as a matter of course -- a progress bar, a
 * `less` status line, an interrupted colour run -- so a line that never closes
 * its attributes is normal rather than pathological. Left alone, that background
 * bled into the preview's border and everything the dash drew after it.
 *
 * Lines with no styling gain nothing: a reset on every blank line would double
 * the size of a mostly-plain capture for no visible effect.
 */
export function endLinesWithReset(value: string): string {
  return value
    .split("\n")
    .map((line) => {
      let styled = false;
      for (const token of scan(line)) {
        if (token.kind === "sgr") styled = !isReset(token.value);
      }
      return styled ? line + SGR_RESET : line;
    })
    .join("\n");
}
