import type { Command } from "commander";
import {
  Box,
  type DOMElement,
  measureElement,
  render,
  Text,
  useApp,
  useInput,
  useWindowSize,
} from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentLabel, jumpToAgent, terminalText } from "../agents.js";
import { ssh } from "../channel.js";
import { COLLECT_FLOOR_MS } from "../collector.js";
import {
  type Composer,
  type DashFilter,
  dashFilter,
  editComposer,
  emptyComposer,
  emptyFilter,
  sendEscape,
  sendPrompt,
} from "../dash-input.js";
import {
  clampGlanceScroll,
  classifyClick,
  disableMouse,
  enableMouse,
  parseMouseEvents,
  pointInRect,
} from "../dash-mouse.js";
import { DASH_CHROME, DASH_CHROME_COLOR, DASH_COLOR, DASH_GLYPH } from "../dash-paint.js";
import { type DashPrefs, type DashSort, loadDashPrefs, saveDashPrefs } from "../dash-prefs.js";
import {
  cardWindow,
  clipGlanceLine,
  compactSelectionMarker,
  type DashFocus,
  type DashFooterMode,
  type DashViewState,
  dashFooterHints,
  dashHelpSections,
  dashNavigation,
  dashVisibleCards,
  fetchedText,
  glanceNeedsRefresh,
  glanceViewport,
  moveIndex,
  paneFingerprint,
  routeDashKey,
  scrollLabel,
} from "../dash-tick.js";
import { dashCrewCount, dashRows, dashStateCount } from "../dash-view.js";
import { runGoto } from "../goto.js";
import { asPaneId } from "../ids.js";
import { type Mux, tmux } from "../mux.js";
import {
  glancePlacement,
  glanceShare,
  PREVIEW_PANE_TAIL_LINES,
  previewText,
  sessionNotice,
} from "../paint.js";
import { type Status, status, statusWithCollect } from "../status.js";
import { openStore, type Store } from "../store.js";
import { age, oneLiner, type PaneView, RENDER_PRIORITY, renderState } from "../view.js";
import { requireIdentity } from "./identity-guard.js";

/**
 * Redraw cadence.
 *
 * Three seconds, not one, and this is a memory decision rather than a
 * cosmetic one. ink allocates a yoga layout node per element and frees it on
 * the next render; yoga is WASM and that churn is not returned to the OS.
 * Measured on this dash: a 1s tick grew ~200MB/hour without bound (2.3GB after
 * five and a half hours), a 10s tick was flat, and 3s plateaus around 250MB and
 * stays there.
 *
 * Nothing on screen needs a faster clock. The ages are displayed to the second
 * but a second's lag in reading one is invisible, and the collect floor is 30s,
 * so the underlying facts change far more slowly than this.
 */
const REDRAW_MS = 3_000;
/**
 * Widest text a card can show, used only to bound what ink measures.
 *
 * A card is a fixed fraction of the rail and never wide; the exact figure does
 * not matter, only that it is an upper bound, since anything past it was never
 * painted. See `clipGlanceLine` for why measuring the unclipped string leaks.
 */
const CARD_TEXT_WIDTH = 120;
const INPUT_PREVIEW_MS = 500;
const SORTS: DashSort[] = ["priority", "node", "age"];

type DashProps = {
  store: Store;
  initial: Status;
};

type SuspendTerminal = (action: () => void | Promise<void>) => Promise<void>;

/** Release Ink's terminal modes while a jump switches the tmux client away. */
export async function withDashTerminalSuspended<T>(
  suspendTerminal: SuspendTerminal,
  action: () => T,
  setMouse: (enabled: boolean) => void = (enabled) =>
    enabled ? enableMouse(process.stdout) : disableMouse(process.stdout),
): Promise<T> {
  let outcome: { value: T } | undefined;
  setMouse(false);
  try {
    await suspendTerminal(() => {
      outcome = { value: action() };
    });
  } finally {
    setMouse(true);
  }
  if (!outcome) throw new Error("dash jump did not run");
  return outcome.value;
}

export function requireDashTmux(
  env: NodeJS.ProcessEnv = process.env,
  writeError: (message: string) => unknown = process.stderr.write.bind(process.stderr),
): boolean {
  if (env.TMUX) return true;
  writeError("murmur dash must run inside tmux; start tmux and run it again.\n");
  process.exitCode = 1;
  return false;
}

function paneKey(pane: PaneView): string {
  return `${pane.host_id}:${pane.pane}`;
}

function nextSort(sort: DashSort): DashSort {
  return SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length] ?? "priority";
}

/** Middle-dot cluster separator — floats between header/footer items. */
function Dot() {
  return <Text color={DASH_CHROME_COLOR.furniture}> · </Text>;
}

/**
 * One footer hint: coloured chord, dim verb. Bold-everything made the line one
 * slab; this keeps key ≠ label.
 */
function Hint({ chord, label }: { chord: string; label: string }) {
  return (
    <Text>
      <Text color={DASH_CHROME_COLOR.accent}>{chord}</Text>
      {label ? <Text dimColor> {label}</Text> : null}
    </Text>
  );
}

/** The help panel's own value column, absent from the footer's hints. */
function HintValue({ value }: { value?: string }) {
  if (value === undefined) return null;
  return <Text color={DASH_CHROME_COLOR.text}> {value}</Text>;
}

function Footer({ columns, mode }: { columns: number; mode: DashFooterMode }) {
  const hints = dashFooterHints(mode);
  return (
    <Box width={columns} height={1}>
      {hints.map((hint, index) => (
        <Text key={`${hint.chord}:${hint.label}`}>
          {index > 0 ? <Dot /> : null}
          <Hint chord={hint.chord} label={hint.label} />
        </Text>
      ))}
    </Box>
  );
}

/**
 * The `?` panel: the full legend, inside the dash rather than a tmux popup.
 *
 * It replaces the body while it is up, because it is modal -- no dashboard key
 * does anything behind it, so the cards underneath are not actionable and need
 * not stay visible.
 */
function Help({ columns, rows, view }: { columns: number; rows: number; view: DashViewState }) {
  return (
    <Box
      borderStyle="double"
      borderColor={DASH_CHROME_COLOR.accent}
      flexDirection="column"
      width={columns}
      height={rows}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold color={DASH_CHROME_COLOR.accent}>
        shortcuts<Text dimColor> · ? or esc closes</Text>
      </Text>
      {dashHelpSections(view).map((section) => (
        <Box key={section.title} flexDirection="column">
          <Text bold color={DASH_CHROME_COLOR.info}>
            {section.title}
          </Text>
          {section.hints.map((hint) => (
            <Text key={hint.chord} wrap="truncate-end">
              {"  "}
              <Text color={DASH_CHROME_COLOR.accent}>{hint.chord.padEnd(7)}</Text>
              <Text dimColor>{hint.label}</Text>
              <HintValue value={hint.value} />
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function Card({
  pane,
  selected,
  cardsFocused,
  glanceLine,
  now,
  elementRef,
}: {
  pane: PaneView;
  selected: boolean;
  cardsFocused: boolean;
  glanceLine?: string;
  now: number;
  elementRef?: (node: DOMElement | null) => void;
}) {
  const state = renderState(pane);
  const stale = pane.freshness === "stale";
  const stream = pane.workstream ?? pane.session_name;
  // Clipped for the same reason the glance body is: for an agent that reports
  // nothing, this is the last line of its pane and changes every tick, and ink
  // retains every distinct string it measures for the life of the process. The
  // card is ~38 columns wide, so anything past that was never visible anyway.
  const summary = clipGlanceLine(oneLiner(pane, glanceLine), CARD_TEXT_WIDTH);
  const elapsed = age(pane.updated_at === null ? null : now - pane.updated_at);

  return (
    <Box
      ref={elementRef}
      borderStyle={selected && cardsFocused ? "double" : "single"}
      borderColor={selected ? DASH_CHROME_COLOR.accent : DASH_CHROME_COLOR.furniture}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color={DASH_COLOR[state]} wrap="truncate-end">
        {DASH_GLYPH[state]} {agentLabel(pane)} {elapsed}
      </Text>
      <Text wrap="truncate-end">
        <Text color={pane.local ? DASH_CHROME_COLOR.here : DASH_CHROME_COLOR.remote}>
          {pane.local
            ? `${DASH_CHROME.here} here`
            : `${DASH_CHROME.remote} ${terminalText(pane.host)}`}
        </Text>
        {pane.driver === "orchestrated" ? `  ${DASH_CHROME.crew}` : ""}
        {stream ? `  ${terminalText(stream)}` : ""}
        {stale ? <Text color={DASH_CHROME_COLOR.stale}> {DASH_CHROME.stale} stale</Text> : null}
      </Text>
      <Text dimColor={stale || !summary} wrap="truncate-end">
        {summary || " "}
      </Text>
    </Box>
  );
}

/**
 * One agent on one line, for the dense view.
 *
 * Painted as a single padded string rather than a row of elements, for the
 * reason the glance body is: ink allocates a yoga node per element and keeps
 * every distinct measured string forever, and compact mode exists precisely to
 * put many more rows on screen. Padding to the full width is what lets the
 * selection read as a bar -- a `Text` only as wide as its content would leave
 * the highlight ragged.
 */
function CompactRow({
  pane,
  selected,
  cardsFocused,
  width,
  glanceLine,
  now,
  elementRef,
}: {
  pane: PaneView;
  selected: boolean;
  cardsFocused: boolean;
  width: number;
  glanceLine?: string;
  now: number;
  elementRef?: (node: DOMElement | null) => void;
}) {
  const state = renderState(pane);
  const stale = pane.freshness === "stale";
  const stream = pane.workstream ?? pane.session_name;
  const flags = [
    pane.driver === "orchestrated" ? DASH_CHROME.crew : "",
    stale ? DASH_CHROME.stale : "",
  ]
    .filter(Boolean)
    .join(" ");
  const elapsed = age(pane.updated_at === null ? null : now - pane.updated_at);
  const head = [
    DASH_GLYPH[state],
    agentLabel(pane),
    pane.local ? DASH_CHROME.here : `${DASH_CHROME.remote} ${terminalText(pane.host)}`,
    stream ? terminalText(stream) : "",
    flags,
    elapsed,
  ]
    .filter(Boolean)
    .join("  ");
  // The head is the part that must survive a narrow rail, so the summary takes
  // whatever is left and nothing more.
  // Colour alone carried selection and focus on a borderless line; the gutter
  // makes both survive a low-contrast or colour-blind terminal.
  const marker = compactSelectionMarker(selected, cardsFocused);
  const summary = clipGlanceLine(
    oneLiner(pane, glanceLine),
    Math.max(0, width - marker.length - head.length - 2),
  );
  const line = clipGlanceLine(`${marker}${summary ? `${head}  ${summary}` : head}`, width);

  return (
    <Box ref={elementRef} width={width} height={1}>
      <Text
        bold={selected}
        color={selected ? "#11111b" : DASH_COLOR[state]}
        backgroundColor={
          selected
            ? cardsFocused
              ? DASH_CHROME_COLOR.accent
              : DASH_CHROME_COLOR.selectedFallback
            : undefined
        }
        dimColor={!selected && stale}
        wrap="truncate-end"
      >
        {line.padEnd(width)}
      </Text>
    </Box>
  );
}

function App({ store, initial }: DashProps) {
  const { exit, suspendTerminal } = useApp();
  const { columns, rows: terminalRows } = useWindowSize();
  const [prefs, setPrefs] = useState(loadDashPrefs);
  const [view, setView] = useState(initial);
  const [selectedKey, setSelectedKey] = useState<string | null>(
    initial.panes[0] ? paneKey(initial.panes[0]) : null,
  );
  const [glance, setGlance] = useState("");
  const [glanceScroll, setGlanceScroll] = useState(0);
  const [focus, setFocus] = useState<DashFocus>("cards");
  const [inputTarget, setInputTarget] = useState<PaneView | null>(null);
  const [composer, setComposer] = useState<Composer>(emptyComposer);
  const [inputError, setInputError] = useState("");
  const [inputSending, setInputSending] = useState(false);
  const inputGenerationRef = useRef(0);
  // Session-local on purpose: the query never reaches `dash.toml`, so a dash
  // reopened tomorrow shows every agent rather than silently hiding rows
  // behind a filter set days ago.
  const [filter, setFilter] = useState<DashFilter>(emptyFilter);
  // Process-local and never persisted: help is a glance at a reference, not a
  // view setting, so a dash reopened tomorrow must not start behind the panel.
  const [helpOpen, setHelpOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(Date.now());
  const [collectRevision, setCollectRevision] = useState(0);
  // When the collect cycle last COMPLETED, which is not `now` and not a peer's
  // `fetched_at`: on a peerless node those two say nothing about whether the
  // loop is alive, and the header's only ticking field has to.
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const query = filter.query.text;
  // Both lists come from `dashRows`, the one tested composition of gates,
  // query and sort -- the dash must not re-implement half of it. `allPanes` is
  // post-gate and pre-query, which is the `M` the header paints; the blank-query
  // branch reuses it so "no filter" keeps one array identity.
  const allPanes = useMemo(() => dashRows(view.panes, prefs, now), [view, prefs, now]);
  const panes = useMemo(
    () => (query.trim() ? dashRows(view.panes, prefs, now, query) : allPanes),
    [view, prefs, now, query, allPanes],
  );
  const selectedIndex = Math.max(
    0,
    panes.findIndex((pane) => paneKey(pane) === selectedKey),
  );
  const selected = panes[selectedIndex];
  const inputMode = inputTarget !== null;
  const previewPane = inputTarget ?? selected;
  const selectedFingerprint = previewPane ? paneFingerprint(previewPane) : null;
  const glanceRequestRef = useRef({ selected, peers: view.peers });
  const lastGlanceRequestRef = useRef({
    selectedKey: null as string | null,
    collectRevision: -1,
    fingerprint: null as string | null,
  });
  const clickMemoryRef = useRef<ReturnType<typeof classifyClick>["next"] | null>(null);
  const cardNodesRef = useRef(new Map<string, DOMElement>());
  const railNodeRef = useRef<DOMElement | null>(null);
  const glanceNodeRef = useRef<DOMElement | null>(null);
  glanceRequestRef.current = { selected: previewPane, peers: view.peers };

  const updatePrefs = useCallback((patch: Partial<DashPrefs>) => {
    setPrefs((current) => {
      const updated = { ...current, ...patch };
      saveDashPrefs(updated);
      return updated;
    });
  }, []);

  const refresh = useCallback(
    async (floored: boolean) => {
      const identity = requireIdentity();
      if (!identity) return;
      const updated = await statusWithCollect(
        store,
        identity,
        Date.now(),
        ssh,
        floored ? { floorMs: COLLECT_FLOOR_MS } : {},
      );
      const at = Date.now();
      setView(updated);
      setNow(at);
      setRefreshedAt(at);
      setCollectRevision((revision) => revision + 1);
    },
    [store],
  );

  useEffect(() => {
    void refresh(true);
    const timer = setInterval(() => {
      const identity = requireIdentity();
      if (!identity) return;
      const at = Date.now();
      setView(status(store, identity, at));
      setNow(at);
    }, REDRAW_MS);
    const collector = setInterval(() => void refresh(true), COLLECT_FLOOR_MS);
    return () => {
      clearInterval(timer);
      clearInterval(collector);
    };
  }, [refresh, store]);

  useEffect(() => {
    const previous = lastGlanceRequestRef.current;
    const selectionChanged = selectedKey !== previous.selectedKey;
    const collectionChanged = collectRevision !== previous.collectRevision;
    const fingerprintChanged = glanceNeedsRefresh(previous.fingerprint, selectedFingerprint);
    lastGlanceRequestRef.current = {
      selectedKey,
      collectRevision,
      fingerprint: selectedFingerprint,
    };

    const { selected: current, peers } = glanceRequestRef.current;
    if (!current) {
      setGlance("No agents");
      setGlanceScroll(0);
      return;
    }
    // Local store changes can refresh each tick. Remote previews wait for a
    // selection or collect so their SSH capture cannot fire every second.
    if (selectionChanged || collectionChanged || (current.local && fingerprintChanged)) {
      // Pin to the end so the capture-pane fills the viewport; scroll up for facts.
      setGlance(
        previewText(store, current, peers, undefined, { paneTailLines: PREVIEW_PANE_TAIL_LINES }),
      );
      setGlanceScroll(Number.MAX_SAFE_INTEGER);
    }
  }, [selectedKey, collectRevision, selectedFingerprint, store]);

  useEffect(() => {
    if (!inputMode && selected && selectedKey !== paneKey(selected))
      setSelectedKey(paneKey(selected));
  }, [inputMode, selected, selectedKey]);

  useEffect(() => {
    if (!inputMode) return;
    const timer = setInterval(() => {
      const { selected: current, peers } = glanceRequestRef.current;
      if (current) {
        setGlance(
          previewText(store, current, peers, undefined, { paneTailLines: PREVIEW_PANE_TAIL_LINES }),
        );
        setGlanceScroll(Number.MAX_SAFE_INTEGER);
      }
    }, INPUT_PREVIEW_MS);
    return () => clearInterval(timer);
  }, [inputMode, store]);

  const notice = sessionNotice(view.peers, now);
  const placement = glancePlacement(columns);
  const share = glanceShare(placement, prefs.preview);
  const headerRows = notice ? 2 : 1;
  const bodyRows = Math.max(5, terminalRows - headerRows - 2);
  const cardHeight =
    placement === "bottom" ? Math.max(4, Math.floor(bodyRows * (1 - share))) : bodyRows;
  const visibleCards = dashVisibleCards(cardHeight, prefs.compact, panes.length);
  // The rail's own width, used only to pad a compact row to full width so the
  // selection background spans it. Approximate is fine; the row is clipped.
  const railWidth = Math.max(
    1,
    placement === "right" ? Math.round(columns * (1 - share)) : columns,
  );
  const window = cardWindow(selectedIndex, panes.length, visibleCards);
  const shown = panes.slice(window.first, window.first + window.shown);
  const scroll = scrollLabel({ ...window, total: panes.length });

  const jumpTo = useCallback(
    (index: number) => {
      const pane = panes[index];
      if (pane) setSelectedKey(paneKey(pane));
    },
    [panes],
  );

  const move = useCallback(
    (offset: number, mode: "wrap" | "clamp" = "wrap") => {
      if (panes.length === 0) return;
      jumpTo(moveIndex(selectedIndex, offset, panes.length, mode));
    },
    [jumpTo, panes.length, selectedIndex],
  );

  const activatePane = useCallback(
    async (pane: PaneView) => {
      const result = await withDashTerminalSuspended(suspendTerminal, () =>
        pane.attached_pane
          ? tmux.attach(pane.attached_pane)
            ? { ok: true as const }
            : { ok: false as const, message: `could not focus ${pane.attached_pane}` }
          : jumpToAgent(store, pane),
      );
      setMessage(result.ok ? "" : result.message);
    },
    [store, suspendTerminal],
  );

  const mouseLiveRef = useRef({
    panes,
    move,
    activatePane,
    inputMode,
    glanceLineCount: 0,
    glanceVisibleLines: 1,
  });
  mouseLiveRef.current = {
    panes,
    move,
    activatePane,
    inputMode,
    glanceLineCount: glance.split("\n").length,
    glanceVisibleLines: glanceViewport(
      glance.split("\n").length,
      glanceNodeRef.current && measureElement(glanceNodeRef.current).height > 0
        ? measureElement(glanceNodeRef.current).height
        : placement === "bottom"
          ? Math.max(5, bodyRows - cardHeight)
          : bodyRows,
    ).visible,
  };

  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    enableMouse(process.stdout);
    let rest = "";
    const onData = (buffer: Buffer) => {
      const parsed = parseMouseEvents(rest + buffer.toString("utf8"));
      rest = parsed.rest;
      const live = mouseLiveRef.current;
      if (live.inputMode) return;
      for (const event of parsed.events) {
        if (event.kind === "press" && event.button === "left") {
          for (const [key, node] of cardNodesRef.current) {
            if (!pointInRect(event.x, event.y, measureElement(node))) continue;
            setFocus("cards");
            const classified = classifyClick(clickMemoryRef.current, key, Date.now());
            clickMemoryRef.current = classified.next;
            if (classified.double) {
              const pane = live.panes.find((entry) => paneKey(entry) === key);
              if (pane) void live.activatePane(pane);
            } else {
              setSelectedKey(key);
            }
            return;
          }
          const glanceBox = glanceNodeRef.current;
          if (glanceBox && pointInRect(event.x, event.y, measureElement(glanceBox))) {
            setFocus("preview");
            return;
          }
        }

        if (event.kind !== "wheel") continue;
        const delta = event.button === "up" ? -1 : event.button === "down" ? 1 : 0;
        if (delta === 0) continue;

        const rail = railNodeRef.current;
        if (rail && pointInRect(event.x, event.y, measureElement(rail))) {
          live.move(delta, "clamp");
          continue;
        }
        const glanceBox = glanceNodeRef.current;
        if (glanceBox && pointInRect(event.x, event.y, measureElement(glanceBox))) {
          setGlanceScroll((offset) =>
            clampGlanceScroll(offset + delta * 3, live.glanceLineCount, live.glanceVisibleLines),
          );
        }
      }
    };
    process.stdin.on("data", onData);
    return () => {
      process.stdin.off("data", onData);
      disableMouse(process.stdout);
    };
  }, []);

  useInput((input, key) => {
    // Checked before the composer and the filter editor, because help is modal:
    // while it is up, nothing else may see a key. It can only BE up in normal
    // mode, since `?` typed into either editor is text rather than a chord.
    if (helpOpen) {
      if (routeDashKey(true, input, key) === "help-close") setHelpOpen(false);
      return;
    }

    if (inputTarget) {
      if (key.escape) {
        inputGenerationRef.current += 1;
        setInputTarget(null);
        setComposer(emptyComposer());
        setInputError("");
        setInputSending(false);
      } else if (inputSending) {
        return;
      } else if (key.ctrl && input === "e") {
        const generation = inputGenerationRef.current;
        setInputSending(true);
        void sendEscape(store, inputTarget).then((result) => {
          if (inputGenerationRef.current !== generation) return;
          setInputSending(false);
          setInputError(result.ok ? "" : result.message);
          if (result.ok) setCollectRevision((revision) => revision + 1);
        });
      } else if (key.return) {
        if (!composer.text) return;
        const generation = inputGenerationRef.current;
        setInputSending(true);
        void sendPrompt(store, inputTarget, composer.text).then((result) => {
          if (inputGenerationRef.current !== generation) return;
          setInputSending(false);
          setInputError(result.ok ? "" : result.message);
          if (result.ok) {
            setComposer(emptyComposer());
            setCollectRevision((revision) => revision + 1);
          }
        });
      } else if (key.tab) {
        return;
      } else if (key.backspace) {
        setComposer((state) => editComposer(state, { type: "backspace" }));
      } else if (key.delete) {
        setComposer((state) => editComposer(state, { type: "delete" }));
      } else if (key.leftArrow) {
        setComposer((state) => editComposer(state, { type: "left" }));
      } else if (key.rightArrow) {
        setComposer((state) => editComposer(state, { type: "right" }));
      } else if (key.home) {
        setComposer((state) => editComposer(state, { type: "home" }));
      } else if (key.end) {
        setComposer((state) => editComposer(state, { type: "end" }));
      } else if (input && !key.ctrl && !key.meta) {
        setComposer((state) => editComposer(state, { type: "insert", text: input }));
      }
      return;
    }

    if (filter.editing) {
      // Filter editing owns every printable key, so a query may contain `q`,
      // `j` or `i` without quitting, moving or opening the prompt.
      if (key.escape) setFilter((state) => dashFilter(state, { type: "cancel" }));
      else if (key.return) setFilter((state) => dashFilter(state, { type: "accept" }));
      else if (key.backspace)
        setFilter((state) => dashFilter(state, { type: "edit", edit: { type: "backspace" } }));
      else if (key.delete)
        setFilter((state) => dashFilter(state, { type: "edit", edit: { type: "delete" } }));
      else if (key.leftArrow)
        setFilter((state) => dashFilter(state, { type: "edit", edit: { type: "left" } }));
      else if (key.rightArrow)
        setFilter((state) => dashFilter(state, { type: "edit", edit: { type: "right" } }));
      else if (key.home)
        setFilter((state) => dashFilter(state, { type: "edit", edit: { type: "home" } }));
      else if (key.end)
        setFilter((state) => dashFilter(state, { type: "edit", edit: { type: "end" } }));
      else if (input && !key.ctrl && !key.meta)
        setFilter((state) =>
          dashFilter(state, { type: "edit", edit: { type: "insert", text: input } }),
        );
      return;
    }

    if (routeDashKey(false, input, key) === "help-open") {
      setHelpOpen(true);
    } else if (input === "/") {
      setFilter((state) => dashFilter(state, { type: "open" }));
    } else if (key.escape && query) {
      // Escape while navigating a filtered list drops the filter, so one key
      // always gets the full list back.
      setFilter((state) => dashFilter(state, { type: "cancel" }));
    } else if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    } else if (key.tab) {
      setFocus((current) => (current === "cards" ? "preview" : "cards"));
    } else if (
      input === "j" ||
      key.downArrow ||
      input === "k" ||
      key.upArrow ||
      key.pageDown ||
      (key.ctrl && input === "d") ||
      key.pageUp ||
      (key.ctrl && input === "u") ||
      input === "g" ||
      key.home ||
      input === "G" ||
      key.end
    ) {
      const navKey =
        input === "j" || key.downArrow
          ? "down"
          : input === "k" || key.upArrow
            ? "up"
            : key.pageDown || (key.ctrl && input === "d")
              ? "pageDown"
              : key.pageUp || (key.ctrl && input === "u")
                ? "pageUp"
                : input === "g" || key.home
                  ? "home"
                  : "end";
      const navigation = dashNavigation(focus, navKey, visibleCards, glanceVisibleLines);
      if (navigation.type === "cards") move(navigation.offset, "clamp");
      else if (navigation.type === "cards-edge")
        jumpTo(navigation.edge === "top" ? 0 : panes.length - 1);
      else if (navigation.type === "preview")
        setGlanceScroll((offset) =>
          clampGlanceScroll(offset + navigation.offset, glanceLines.length, glanceVisibleLines),
        );
      else if (navigation.type === "preview-edge")
        setGlanceScroll(navigation.edge === "top" ? 0 : Number.MAX_SAFE_INTEGER);
    } else if (key.return && selected) {
      void activatePane(selected);
    } else if (input === "i" && selected) {
      inputGenerationRef.current += 1;
      setFocus("preview");
      setInputTarget(selected);
      setComposer(emptyComposer());
      setInputError("");
      setInputSending(false);
      setGlanceScroll(Number.MAX_SAFE_INTEGER);
    } else if (input === "s") {
      updatePrefs({ sort: nextSort(prefs.sort) });
    } else if (input === "f") {
      updatePrefs({ hide_stale: !prefs.hide_stale });
    } else if (input === "a") {
      updatePrefs({ crew: !prefs.crew });
    } else if (input === "c") {
      updatePrefs({ compact: !prefs.compact });
    } else if (input === "+" || input === "=") {
      updatePrefs({ preview: Math.min(0.85, Number((prefs.preview + 0.05).toFixed(2))) });
    } else if (input === "-") {
      updatePrefs({ preview: Math.max(0.2, Number((prefs.preview - 0.05).toFixed(2))) });
    } else if (key.ctrl && input === "r") {
      void refresh(false);
    }
  });

  const glanceBoxHeight = (() => {
    const measured = glanceNodeRef.current ? measureElement(glanceNodeRef.current).height : 0;
    if (measured > 0) return measured;
    return placement === "bottom" ? Math.max(5, bodyRows - cardHeight) : bodyRows;
  })();
  const glanceLines = glance.split("\n");
  // The glance body's own width: the box less its border (1 each side) and
  // paddingX (1 each side). Only used to bound what ink measures, so an
  // approximation is fine -- but it must not be wider than the box, or the
  // clipping stops collapsing anything.
  const glanceTextWidth = Math.max(
    1,
    Math.round((placement === "right" ? columns * share : columns) - 4),
  );
  const previewFocused = focus === "preview";
  const inputChromeRows = inputMode ? 2 + (inputError ? 1 : 0) : previewFocused ? 1 : 0;
  const glanceFrame = glanceViewport(glanceLines.length, glanceBoxHeight - inputChromeRows);
  const glanceVisibleLines = glanceFrame.visible;
  const glanceScrollMax = Math.max(0, glanceLines.length - glanceVisibleLines);
  const glanceOffset = clampGlanceScroll(glanceScroll, glanceLines.length, glanceVisibleLines);
  const glanceViewLines = glanceLines.slice(glanceOffset, glanceOffset + glanceVisibleLines);
  // Clipped per line, then joined into one string. An empty line becomes a
  // space so the row still occupies height, as it did when each line was its
  // own element.
  const glanceBody = glanceViewLines
    .map((line) => clipGlanceLine(line, glanceTextWidth) || " ")
    .join("\n");
  const glanceLine = [...glanceLines]
    .reverse()
    .find((line) => line.trim())
    ?.trim();
  const filterDraft = [...query];
  const filterBefore = filterDraft.slice(0, filter.query.cursor).join("");
  const filterCursor = filterDraft[filter.query.cursor] ?? " ";
  const filterAfter = filterDraft
    .slice(filter.query.cursor + (filterDraft[filter.query.cursor] ? 1 : 0))
    .join("");
  const draft = [...composer.text.replaceAll("\n", "↵")];
  const draftBefore = draft.slice(0, composer.cursor).join("");
  const draftCursor = draft[composer.cursor] ?? " ";
  const draftAfter = draft.slice(composer.cursor + (draft[composer.cursor] ? 1 : 0)).join("");

  const stateCounts = RENDER_PRIORITY.filter(
    (state) => dashStateCount(view, state, prefs.crew) > 0,
  ).map((state) => ({
    state,
    n: dashStateCount(view, state, prefs.crew),
  }));
  const crewCount = dashCrewCount(view);
  const footerMode: DashFooterMode = inputMode
    ? "input"
    : filter.editing
      ? "filter-editing"
      : query
        ? "filter-active"
        : "normal";

  return (
    <Box flexDirection="column" width={columns} height={terminalRows}>
      <Box>
        <Text bold color={DASH_CHROME_COLOR.accent}>
          {DASH_CHROME.robot}{" "}
        </Text>
        {stateCounts.length === 0 ? (
          <Text color={DASH_CHROME_COLOR.furniture}>no agents</Text>
        ) : (
          stateCounts.map(({ state, n }, index) => (
            <Text key={state}>
              {index > 0 ? <Dot /> : null}
              <Text bold color={DASH_COLOR[state]}>
                {DASH_GLYPH[state]} {state} {n}
              </Text>
            </Text>
          ))
        )}
        {crewCount > 0 ? (
          <>
            <Dot />
            <Text color={DASH_CHROME_COLOR.furniture}>
              {DASH_CHROME.crew} crew {crewCount}
            </Text>
          </>
        ) : null}
        <Dot />
        <Text color={DASH_CHROME_COLOR.info}>{fetchedText(view, now, refreshedAt)}</Text>
        <Dot />
        <Text color={DASH_CHROME_COLOR.accent}>sort </Text>
        <Text color={DASH_CHROME_COLOR.text}>{prefs.sort}</Text>
        {scroll ? (
          <>
            <Dot />
            <Text bold color={DASH_CHROME_COLOR.stale}>
              {scroll}
            </Text>
          </>
        ) : null}
        {/*
          The query and the cards it kept, next to counts that stay GLOBAL.
          The state tallies and the crew total answer "what is the fleet
          doing", and a filter narrowing those would make a typo look like
          agents disappearing. `N/M` is the only number the filter moves.
        */}
        {filter.editing || query ? (
          <>
            <Dot />
            <Text color={DASH_CHROME_COLOR.accent}>/</Text>
            {filter.editing ? (
              <Text color={DASH_CHROME_COLOR.text}>
                {filterBefore}
                <Text inverse>{filterCursor}</Text>
                {filterAfter}
              </Text>
            ) : (
              <Text color={DASH_CHROME_COLOR.text}>{terminalText(query)}</Text>
            )}
            <Text color={panes.length === 0 ? DASH_CHROME_COLOR.stale : DASH_CHROME_COLOR.info}>
              {" "}
              {panes.length}/{allPanes.length}
            </Text>
          </>
        ) : null}
      </Box>
      {notice ? <Text>{notice}</Text> : null}
      {helpOpen ? (
        <Help
          columns={columns}
          rows={bodyRows}
          view={{
            sort: prefs.sort,
            crew: prefs.crew,
            hideStale: prefs.hide_stale,
            compact: prefs.compact,
          }}
        />
      ) : null}
      {/*
        Hidden rather than unmounted, so the cards and the glance keep their
        measured nodes: unmounting would drop every `measureElement` ref the
        mouse handler reads, and closing help would then need a tick to make
        clicks land again.
      */}
      <Box
        display={helpOpen ? "none" : "flex"}
        flexDirection={placement === "right" ? "row" : "column"}
        flexGrow={1}
      >
        <Box
          ref={railNodeRef}
          flexDirection="column"
          width={placement === "right" ? `${Math.round((1 - share) * 100)}%` : "100%"}
          height={placement === "bottom" ? cardHeight : undefined}
        >
          {window.above > 0 ? (
            <Text color={DASH_CHROME_COLOR.stale}>↑ {window.above} more</Text>
          ) : null}
          {shown.map((pane) => {
            const key = paneKey(pane);
            return prefs.compact ? (
              <CompactRow
                key={key}
                pane={pane}
                selected={key === paneKey(selected ?? pane)}
                cardsFocused={focus === "cards"}
                width={railWidth}
                glanceLine={pane === selected ? glanceLine : undefined}
                now={now}
                elementRef={(node) => {
                  if (node) cardNodesRef.current.set(key, node);
                  else cardNodesRef.current.delete(key);
                }}
              />
            ) : (
              <Card
                key={key}
                pane={pane}
                selected={key === paneKey(selected ?? pane)}
                cardsFocused={focus === "cards"}
                glanceLine={pane === selected ? glanceLine : undefined}
                now={now}
                elementRef={(node) => {
                  if (node) cardNodesRef.current.set(key, node);
                  else cardNodesRef.current.delete(key);
                }}
              />
            );
          })}
          {window.below > 0 ? (
            <Text color={DASH_CHROME_COLOR.stale}>↓ {window.below} more</Text>
          ) : null}
        </Box>
        <Box
          ref={glanceNodeRef}
          borderStyle={previewFocused ? "double" : "single"}
          borderColor={
            inputMode
              ? DASH_CHROME_COLOR.accent
              : previewFocused
                ? DASH_CHROME_COLOR.info
                : undefined
          }
          flexDirection="column"
          width={placement === "right" ? `${Math.round(share * 100)}%` : "100%"}
          height={placement === "bottom" ? Math.max(5, bodyRows - cardHeight) : bodyRows}
          paddingX={1}
          overflow="hidden"
        >
          {previewFocused && previewPane ? (
            <Text
              bold
              backgroundColor={inputMode ? DASH_CHROME_COLOR.accent : DASH_CHROME_COLOR.info}
              color="#11111b"
              wrap="truncate-end"
            >
              {inputMode
                ? ` INPUT → ${terminalText(previewPane.host)}/${previewPane.pane} · ${inputSending ? "sending…" : "Enter send · Ctrl+E stop · Esc leave"} `
                : ` PREVIEW → ${terminalText(previewPane.host)}/${previewPane.pane} · Tab cards `}
            </Text>
          ) : null}
          {glanceFrame.chrome ? (
            <Text color={DASH_CHROME_COLOR.stale} wrap="truncate-end">
              {glanceOffset > 0 ? `↑ ${glanceOffset} more` : "↑ top"}
              {" · "}
              {glanceOffset + 1}–{Math.min(glanceLines.length, glanceOffset + glanceVisibleLines)}/
              {glanceLines.length}
              {" · "}
              {glanceOffset < glanceScrollMax
                ? `↓ ${glanceScrollMax - glanceOffset} more`
                : "↓ end"}
            </Text>
          ) : null}
          {/*
            ONE Text node for the whole body, not one per line.
            
            ink builds a yoga layout node per element and frees it on the next
            render. Yoga is WASM, and that create/free churn does not return to
            the OS -- measured at ~200MB/hour with a 1s tick, and near zero at
            10s, which is what proves the cost is per-render rather than
            per-second. Thirty-five line elements made the glance the largest
            contributor on every tick.
            
            Lines are clipped and joined here instead. Each is cut to the
            visible width first, so the single string cannot be wider than the
            box and `wrap="truncate-end"` has nothing left to do -- which is
            also what keeps ink's unevictable measurement cache from growing a
            key per distinct full-width line.
          */}
          <Text>{glanceBody}</Text>
          {inputError ? (
            <Text color={DASH_COLOR.crashed} wrap="truncate-end">
              {inputError}
            </Text>
          ) : null}
          {inputMode ? (
            <Text color={DASH_CHROME_COLOR.text} wrap="truncate-end">
              <Text bold color={DASH_CHROME_COLOR.accent}>
                {"> "}
              </Text>
              {draftBefore}
              <Text inverse>{draftCursor}</Text>
              {draftAfter}
            </Text>
          ) : null}
        </Box>
      </Box>
      <Footer columns={columns} mode={footerMode} />
      {message ? (
        <Box width={columns} height={1}>
          <Text color="red" wrap="truncate-end">
            {message}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Run `--goto` and report. Split out so the exit code and the message are
 * assertable without rendering a dash.
 */
export function dashGoto(
  mux: Mux = tmux,
  env: NodeJS.ProcessEnv = process.env,
  writeError: (message: string) => unknown = process.stderr.write.bind(process.stderr),
): boolean {
  const result = runGoto(mux, env);
  if (result.ok) return true;
  // stderr and a nonzero exit, even though the usual caller is `run-shell -b`
  // which shows neither: the same command is run by hand when the key "does
  // nothing", and that is the run that has to explain itself.
  writeError(`${result.message}\n`);
  process.exitCode = 1;
  return false;
}

export function registerDash(program: Command): void {
  program
    .command("dash")
    .description("Watch agents and glance at their panes")
    .option("--goto", "switch to the running dash, or leave a murmur-controlled remote session")
    .action(async (options: { goto?: boolean }) => {
      if (options.goto) {
        dashGoto();
        return;
      }
      if (!requireDashTmux()) return;
      const identity = requireIdentity();
      if (!identity) return;
      const store = openStore();
      const previousTitle = process.title;
      process.title = "murmur";
      // For the dash's MOUNTED LIFETIME, which is what `--goto` looks for. The
      // pane comes from $TMUX_PANE rather than from tmux: `display-message`
      // answers about whichever pane the server thinks is active, so asking
      // would let a dash started in a popup mark someone else's pane.
      const pane = process.env.TMUX_PANE;
      if (pane) tmux.markDashPane(asPaneId(pane));
      try {
        const instance = render(<App store={store} initial={status(store, identity)} />, {
          alternateScreen: true,
        });
        await instance.waitUntilExit();
      } finally {
        // Best effort: a SIGKILL leaves the option behind, which is exactly why
        // `gotoDecision` re-checks the pane against tmux's live list.
        //
        // Passes our own pane so the clear is conditional: another dash on this
        // server may have taken the mark since, and clearing its mark would
        // report no dash while one is running.
        if (pane) tmux.unmarkDashPane(asPaneId(pane));
        disableMouse(process.stdout);
        store.close();
        process.title = previousTitle;
      }
    });
}
