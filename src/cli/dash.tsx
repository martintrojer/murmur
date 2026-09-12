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
  dashFooterHints,
  fetchedText,
  fitFooterHints,
  glanceNeedsRefresh,
  moveIndex,
  paneFingerprint,
  scrollLabel,
} from "../dash-tick.js";
import { dashRows } from "../dash-view.js";
import { tmux } from "../mux.js";
import { glancePlacement, glanceShare, previewText, sessionNotice } from "../paint.js";
import { type Status, status, statusWithCollect } from "../status.js";
import { openStore, type Store } from "../store.js";
import { age, oneLiner, type PaneView, RENDER_PRIORITY, renderState } from "../view.js";
import { requireIdentity } from "./identity-guard.js";

const REDRAW_MS = 1_000;
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

function Footer({ columns, prefs }: { columns: number; prefs: DashPrefs }) {
  const hints = fitFooterHints(dashFooterHints(prefs), columns);
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
  glanceLine,
  now,
  elementRef,
}: {
  pane: PaneView;
  selected: boolean;
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
      borderStyle={selected ? "double" : "single"}
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
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(Date.now());
  const [collectRevision, setCollectRevision] = useState(0);
  const panes = useMemo(() => dashRows(view.panes, prefs, now), [view, prefs, now]);
  const selectedIndex = Math.max(
    0,
    panes.findIndex((pane) => paneKey(pane) === selectedKey),
  );
  const selected = panes[selectedIndex];
  const selectedFingerprint = selected ? paneFingerprint(selected) : null;
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
  glanceRequestRef.current = { selected, peers: view.peers };

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
      return;
    }
    // Local store changes can refresh each tick. Remote previews wait for a
    // selection or collect so their SSH capture cannot fire every second.
    if (selectionChanged || collectionChanged || (current.local && fingerprintChanged)) {
      setGlance(previewText(store, current, peers));
      setGlanceScroll(0);
    }
  }, [selectedKey, collectRevision, selectedFingerprint, store]);

  useEffect(() => {
    if (selected && selectedKey !== paneKey(selected)) setSelectedKey(paneKey(selected));
  }, [selected, selectedKey]);

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
  const halfPage = Math.max(1, Math.floor(visibleCards / 2));

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
    glanceLineCount: 0,
    glanceVisibleLines: 1,
  });
  mouseLiveRef.current = {
    panes,
    move,
    activatePane,
    glanceLineCount: glance.split("\n").length,
    glanceVisibleLines: Math.max(
      1,
      (placement === "bottom" ? Math.max(5, bodyRows - cardHeight) : bodyRows) - 2,
    ),
  };

  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    enableMouse(process.stdout);
    let rest = "";
    const onData = (buffer: Buffer) => {
      const parsed = parseMouseEvents(rest + buffer.toString("utf8"));
      rest = parsed.rest;
      const live = mouseLiveRef.current;
      for (const event of parsed.events) {
        if (event.kind === "press" && event.button === "left") {
          for (const [key, node] of cardNodesRef.current) {
            if (!pointInRect(event.x, event.y, measureElement(node))) continue;
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
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    } else if (input === "j" || key.downArrow) {
      move(1);
    } else if (input === "k" || key.upArrow) {
      move(-1);
    } else if (key.pageDown || (key.ctrl && input === "d")) {
      move(key.pageDown ? visibleCards : halfPage, "clamp");
    } else if (key.pageUp || (key.ctrl && input === "u")) {
      move(-(key.pageUp ? visibleCards : halfPage), "clamp");
    } else if (input === "g" || key.home) {
      jumpTo(0);
    } else if (input === "G" || key.end) {
      jumpTo(panes.length - 1);
    } else if (key.return && selected) {
      activatePane(selected);
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

  const glanceLines = glance.split("\n");
  const glanceVisibleLines = Math.max(
    1,
    (placement === "bottom" ? Math.max(5, bodyRows - cardHeight) : bodyRows) - 2,
  );
  const glanceScrollMax = Math.max(0, glanceLines.length - glanceVisibleLines);
  const glanceOffset = clampGlanceScroll(glanceScroll, glanceLines.length, glanceVisibleLines);
  const glanceView = glanceLines.slice(glanceOffset, glanceOffset + glanceVisibleLines).join("\n");
  const glanceLine = [...glanceLines]
    .reverse()
    .find((line) => line.trim())
    ?.trim();

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
          borderStyle="single"
          flexDirection="column"
          width={placement === "right" ? `${Math.round(share * 100)}%` : "100%"}
          height={placement === "bottom" ? Math.max(5, bodyRows - cardHeight) : undefined}
          paddingX={1}
        >
          {glanceScrollMax > 0 ? (
            <Text color={DASH_CHROME_COLOR.furniture} wrap="truncate-end">
              {glanceOffset > 0 ? "↑ " : "  "}
              {glanceOffset + 1}–{Math.min(glanceLines.length, glanceOffset + glanceVisibleLines)}/
              {glanceLines.length}
              {glanceOffset < glanceScrollMax ? " ↓" : ""}
            </Text>
          ) : null}
          <Text wrap="truncate-end">{glanceView}</Text>
        </Box>
      </Box>
      <Footer columns={columns} prefs={prefs} />
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
      try {
        const instance = render(<App store={store} initial={status(store, identity)} />, {
          alternateScreen: true,
        });
        await instance.waitUntilExit();
      } finally {
        disableMouse(process.stdout);
        store.close();
      }
    });
}
