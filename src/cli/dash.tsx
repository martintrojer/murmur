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
  editComposer,
  emptyComposer,
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
  type DashFocus,
  dashFooterHints,
  dashNavigation,
  fetchedText,
  fitFooterHints,
  glanceNeedsRefresh,
  glanceViewport,
  moveIndex,
  paneFingerprint,
  scrollLabel,
} from "../dash-tick.js";
import { dashRows } from "../dash-view.js";
import { tmux } from "../mux.js";
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

const REDRAW_MS = 1_000;
const INPUT_PREVIEW_MS = 500;
const SORTS: DashSort[] = ["priority", "node", "age"];

type DashProps = {
  store: Store;
  initial: Status;
};

function paneKey(pane: PaneView): string {
  return `${pane.host_id}:${pane.pane}`;
}

function nextSort(sort: DashSort): DashSort {
  return SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length] ?? "priority";
}

function count(view: Status, state: (typeof RENDER_PRIORITY)[number]): number {
  const needsHuman = state === "crashed" || state === "blocked";
  return view.counts[state] + (needsHuman ? view.orchestrated_counts[state] : 0);
}

/** Middle-dot cluster separator — floats between header/footer items. */
function Dot() {
  return <Text color={DASH_CHROME_COLOR.furniture}> · </Text>;
}

/**
 * One footer hint: coloured chord, dim verb, optional value in text weight.
 * Bold-everything made the line one slab; this keeps key ≠ label ≠ state.
 */
function Hint({ chord, label, value }: { chord: string; label: string; value?: string }) {
  return (
    <Text>
      <Text color={DASH_CHROME_COLOR.accent}>{chord}</Text>
      {label ? <Text dimColor> {label}</Text> : null}
      {value !== undefined ? <Text color={DASH_CHROME_COLOR.text}> {value}</Text> : null}
    </Text>
  );
}

function Footer({
  columns,
  prefs,
  inputMode,
  focus,
}: {
  columns: number;
  prefs: DashPrefs;
  inputMode: boolean;
  focus: DashFocus;
}) {
  const hints = fitFooterHints(
    inputMode
      ? [
          { chord: "enter", label: "send", drop: 0 },
          { chord: "^e", label: "stop", drop: 1 },
          { chord: "esc", label: "leave", drop: 2 },
        ]
      : dashFooterHints(prefs, focus),
    columns,
  );
  return (
    <Box width={columns} height={1}>
      {hints.map((hint, index) => (
        <Text key={`${hint.chord}:${hint.label}:${hint.value ?? ""}`}>
          {index > 0 ? <Dot /> : null}
          <Hint chord={hint.chord} label={hint.label} value={hint.value} />
        </Text>
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
  const summary = oneLiner(pane, glanceLine);
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

function App({ store, initial }: DashProps) {
  const { exit } = useApp();
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
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(Date.now());
  const [collectRevision, setCollectRevision] = useState(0);
  const panes = useMemo(() => dashRows(view.panes, prefs, now), [view, prefs, now]);
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
      setView(updated);
      setNow(Date.now());
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
  const visibleCards = Math.max(1, Math.floor(cardHeight / 5));
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
    (pane: PaneView) => {
      const result = pane.attached_pane
        ? tmux.attach(pane.attached_pane)
          ? { ok: true as const }
          : { ok: false as const, message: `could not focus ${pane.attached_pane}` }
        : jumpToAgent(store, pane);
      setMessage(result.ok ? "" : result.message);
    },
    [store],
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
              if (pane) live.activatePane(pane);
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

    if (input === "q" || (key.ctrl && input === "c")) {
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
      activatePane(selected);
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
  const previewFocused = focus === "preview";
  const inputChromeRows = inputMode ? 2 + (inputError ? 1 : 0) : previewFocused ? 1 : 0;
  const glanceFrame = glanceViewport(glanceLines.length, glanceBoxHeight - inputChromeRows);
  const glanceVisibleLines = glanceFrame.visible;
  const glanceScrollMax = Math.max(0, glanceLines.length - glanceVisibleLines);
  const glanceOffset = clampGlanceScroll(glanceScroll, glanceLines.length, glanceVisibleLines);
  const glanceViewLines = glanceLines.slice(glanceOffset, glanceOffset + glanceVisibleLines);
  const glanceLine = [...glanceLines]
    .reverse()
    .find((line) => line.trim())
    ?.trim();
  const draft = [...composer.text.replaceAll("\n", "↵")];
  const draftBefore = draft.slice(0, composer.cursor).join("");
  const draftCursor = draft[composer.cursor] ?? " ";
  const draftAfter = draft.slice(composer.cursor + (draft[composer.cursor] ? 1 : 0)).join("");

  const stateCounts = RENDER_PRIORITY.filter((state) => count(view, state) > 0).map((state) => ({
    state,
    n: count(view, state),
  }));

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
        <Dot />
        <Text color={DASH_CHROME_COLOR.info}>{fetchedText(view, now)}</Text>
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
      </Box>
      {notice ? <Text>{notice}</Text> : null}
      <Box flexDirection={placement === "right" ? "row" : "column"} flexGrow={1}>
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
            return (
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
          {glanceViewLines.map((line, slot) => {
            const lineNo = glanceOffset + slot;
            return (
              <Text key={lineNo} wrap="truncate-end">
                {line.length > 0 ? line : " "}
              </Text>
            );
          })}
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
      <Footer columns={columns} prefs={prefs} inputMode={inputMode} focus={focus} />
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

export function registerDash(program: Command): void {
  program
    .command("dash")
    .description("Watch agents and glance at their panes")
    .action(async () => {
      const identity = requireIdentity();
      if (!identity) return;
      const store = openStore();
      const previousTitle = process.title;
      process.title = "murmur";
      try {
        const instance = render(<App store={store} initial={status(store, identity)} />, {
          alternateScreen: true,
        });
        await instance.waitUntilExit();
      } finally {
        disableMouse(process.stdout);
        store.close();
        process.title = previousTitle;
      }
    });
}
