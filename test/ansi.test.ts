import { expect, test } from "vitest";
import { clipToWidth, endLinesWithReset, plainText, sgrOnly, visibleWidth } from "../src/ansi.js";

const ESC = "\u001b";

test("SGR sequences survive; every other escape sequence does not", () => {
  // The point of `capture-pane -e`: a pane's colours are the reader's fastest
  // signal of what happened (red test output, a green diff, an inverse
  // selection). Dropping them made every preview one grey slab.
  expect(sgrOnly(`${ESC}[31mred${ESC}[0m`)).toBe(`${ESC}[31mred${ESC}[0m`);
  // Full cell styling, not a colour subset: background, inverse, and the
  // emphasis attributes are all just SGR parameters and all carry meaning.
  expect(sgrOnly(`${ESC}[1;4;7;48;5;238mcell${ESC}[m`)).toBe(`${ESC}[1;4;7;48;5;238mcell${ESC}[m`);
  // Colon-delimited parameters are legal SGR (ITU T.416, what truecolor
  // terminals emit) and must not be mistaken for a different sequence.
  expect(sgrOnly(`${ESC}[38:2::255:0:0mx${ESC}[0m`)).toBe(`${ESC}[38:2::255:0:0mx${ESC}[0m`);
});

test("cursor movement, erases, OSC, and hyperlinks are stripped", () => {
  // A preview is a fixed box of text, not a terminal: anything that MOVES the
  // cursor or clears the screen paints outside the box and corrupts the dash
  // chrome around it. `capture-pane -e` emits only SGR itself, but the pane's
  // own bytes reach us on the remote path through ssh, so this is the guard.
  expect(sgrOnly(`a${ESC}[2Jb${ESC}[1;1Hc${ESC}[Kd`)).toBe("abcd");
  // OSC: titles, clipboard writes, and iTerm/kitty image payloads. A clipboard
  // OSC in pane output would otherwise hijack the reader's clipboard.
  expect(sgrOnly(`a${ESC}]0;title\u0007b`)).toBe("ab");
  expect(sgrOnly(`a${ESC}]52;c;cGF5bG9hZA==${ESC}\\b`)).toBe("ab");
  // OSC 8 hyperlinks: dropped whole, text kept, because the link target is not
  // clickable in a preview and the terminator bytes would print as garbage.
  expect(sgrOnly(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("link");
  // DCS / APC / PM / SOS strings, which is where sixel and kitty graphics live.
  expect(sgrOnly(`a${ESC}Pq#0;2;0;0;0b${ESC}\\c`)).toBe("ac");
  expect(sgrOnly(`a${ESC}_Gf=100,a=T;payload${ESC}\\b`)).toBe("ab");
  // A two-byte escape such as charset selection or keypad mode.
  expect(sgrOnly(`a${ESC}(Bb${ESC}=c`)).toBe("abc");
  // A dangling ESC at the end of a capture is dropped rather than printed.
  expect(sgrOnly(`ab${ESC}`)).toBe("ab");
});

test("control characters other than newline and tab are stripped", () => {
  // Newlines are the line structure the preview is built from and tabs are
  // expanded later, at their column stops. A bare CR would overprint the row
  // and a BEL would ring the operator's terminal once per redraw.
  expect(sgrOnly("a\rb\u0007c\u0000d\u007fe")).toBe("abcde");
  expect(sgrOnly("a\nb\tc")).toBe("a\nb\tc");
  // C1 controls, which are the single-byte spellings of the escapes above.
  expect(sgrOnly("a\u009bb\u009cc")).toBe("abc");
});

test("visible width counts cells, not bytes, and ignores styling", () => {
  // Every width decision downstream -- tab stops, clipping, the compact table
  // -- is about COLUMNS. Scoring escape bytes as width is how a styled line
  // measured as full while painting half empty.
  expect(visibleWidth(`${ESC}[31mred${ESC}[0m`)).toBe(3);
  expect(visibleWidth("plain")).toBe(5);
  expect(visibleWidth("")).toBe(0);
});

test("clipping counts visible columns and never splits an escape sequence", () => {
  // Clipping by `slice` cut mid-sequence, so the terminal received `ESC[3` and
  // swallowed the following text while it waited for a final byte -- one stray
  // colour code could blank the rest of the line.
  const styled = `${ESC}[31mabcdef${ESC}[0m`;
  const clipped = clipToWidth(styled, 3);
  expect(visibleWidth(clipped)).toBe(3);
  expect(clipped).toBe(`${ESC}[31mabc${ESC}[0m`);
  // A line that already fits is returned unchanged, so ink's measurement cache
  // does not gain a second key for text it has already seen.
  expect(clipToWidth(styled, 20)).toBe(styled);
  expect(clipToWidth("ready", 80)).toBe("ready");
  // A narrow or absent width must still show something: a blank preview would
  // be a worse bug than an overflowing one.
  expect(clipToWidth(styled, 0)).toBe(styled);
  expect(clipToWidth(styled, -5)).toBe(styled);
});

test("clipping keeps the styles that opened before the cut", () => {
  // The cut point is arbitrary, so the surviving text must keep whatever was in
  // force where it starts. Dropping the codes that preceded the edge repainted
  // the tail in the default colour and lost the distinction being previewed.
  const line = `${ESC}[1m${ESC}[32mgreen bold${ESC}[0m tail`;
  const clipped = clipToWidth(line, 5);
  expect(clipped).toBe(`${ESC}[1m${ESC}[32mgreen${ESC}[0m`);
  // And a clip landing past every sequence still terminates cleanly.
  expect(clipToWidth(`${ESC}[33mabc`, 2)).toBe(`${ESC}[33mab${ESC}[0m`);
});

test("every styled line ends reset, so no style leaks into the chrome", () => {
  // tmux captures a pane mid-attribute all the time (a half-drawn progress bar,
  // a `less` status line). Without a reset at the line boundary the dash's own
  // border, footer, and the next card inherited that pane's background.
  const out = endLinesWithReset(`${ESC}[41mhot\nplain\n${ESC}[32mcool${ESC}[0m`);
  expect(out.split("\n")).toEqual([
    `${ESC}[41mhot${ESC}[0m`,
    // A line with no styling gains nothing: a reset per blank line would
    // double the size of a mostly-plain capture for no visible effect.
    "plain",
    // Already terminated, so not terminated twice.
    `${ESC}[32mcool${ESC}[0m`,
  ]);
});

test("plain text drops styling as well, for summaries and search", () => {
  // The card summary and the filter query are TEXT, matched against what the
  // reader typed. Leaving codes in meant a filter for "passed" missed a line
  // whose colour changed mid-word, and the compact table measured the row wrong.
  expect(plainText(`${ESC}[31;1mtests ${ESC}[32mpassed${ESC}[0m`)).toBe("tests passed");
  // Still a sanitiser: the non-SGR cases stay gone rather than becoming visible
  // once the SGR pass stops protecting them.
  expect(plainText(`${ESC}[2Jdone\u0007`)).toBe("done");
});
