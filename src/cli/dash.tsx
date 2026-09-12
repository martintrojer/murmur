import type { Command } from "commander";
import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentLabel, jumpToAgent, terminalText } from "../agents.js";
import { ssh } from "../channel.js";
import { COLLECT_FLOOR_MS } from "../collector.js";
import { DASH_CHROME, DASH_CHROME_COLOR, DASH_COLOR, DASH_GLYPH } from "../dash-paint.js";
import { type DashPrefs, type DashSort, loadDashPrefs, saveDashPrefs } from "../dash-prefs.js";
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

function fetchedText(view: Status, now: number): string {
  if (view.peers.length === 0) return "local";
  if (view.peers.some((peer) => peer.fetched_at === null)) return "fetched never";
  const fetched = view.peers.flatMap((peer) => (peer.fetched_at === null ? [] : [peer.fetched_at]));
  const oldest = Math.min(...fetched);
  return `fetched ${age(now - oldest) || "now"} ago`;
}

function count(view: Status, state: (typeof RENDER_PRIORITY)[number]): number {
  const needsHuman = state === "crashed" || state === "blocked";
  return view.counts[state] + (needsHuman ? view.orchestrated_counts[state] : 0);
}

function Card({
  pane,
  selected,
  glanceLine,
}: {
  pane: PaneView;
  selected: boolean;
  glanceLine?: string;
}) {
  const state = renderState(pane);
  const stale = pane.freshness === "stale";
  const stream = pane.workstream ?? pane.session_name;
  const summary = oneLiner(pane, glanceLine);
  const elapsed = age(pane.updated_at === null ? null : Date.now() - pane.updated_at);

  return (
    <Box
      borderStyle={selected ? "bold" : "single"}
      borderColor={selected ? DASH_COLOR[state] : undefined}
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
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(Date.now());
  const [collectRevision, setCollectRevision] = useState(0);
  const panes = useMemo(() => dashRows(view.panes, prefs, now), [view, prefs, now]);
  const selectedIndex = Math.max(
    0,
    panes.findIndex((pane) => paneKey(pane) === selectedKey),
  );
  const selected = panes[selectedIndex];
  const glanceRequestRef = useRef({ selected, peers: view.peers });
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
    const { selected: current, peers } = glanceRequestRef.current;
    setGlance(current ? previewText(store, current, peers) : "No agents");
    // A glance refresh belongs to selection and collection, not the redraw tick.
    void selectedKey;
    void collectRevision;
  }, [selectedKey, collectRevision, store]);

  useEffect(() => {
    if (selected && selectedKey !== paneKey(selected)) setSelectedKey(paneKey(selected));
  }, [selected, selectedKey]);

  const move = useCallback(
    (offset: number) => {
      if (panes.length === 0) return;
      const index = (selectedIndex + offset + panes.length) % panes.length;
      const pane = panes[index];
      if (pane) setSelectedKey(paneKey(pane));
    },
    [panes, selectedIndex],
  );

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    } else if (input === "j" || key.downArrow) {
      move(1);
    } else if (input === "k" || key.upArrow) {
      move(-1);
    } else if (key.return && selected) {
      const result = selected.attached_pane
        ? tmux.attach(selected.attached_pane)
          ? { ok: true as const }
          : { ok: false as const, message: `could not focus ${selected.attached_pane}` }
        : jumpToAgent(store, selected);
      setMessage(result.ok ? "" : result.message);
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

  const notice = sessionNotice(view.peers, now);
  const placement = glancePlacement(columns);
  const share = glanceShare(placement, prefs.preview);
  const headerRows = notice ? 2 : 1;
  const bodyRows = Math.max(5, terminalRows - headerRows - 2);
  const cardHeight =
    placement === "bottom" ? Math.max(4, Math.floor(bodyRows * (1 - share))) : bodyRows;
  const visibleCards = Math.max(1, Math.floor(cardHeight / 5));
  const first = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(visibleCards / 2), panes.length - visibleCards),
  );
  const shown = panes.slice(first, first + visibleCards);
  const glanceLines = glance.split("\n");
  const glanceLine = [...glanceLines]
    .reverse()
    .find((line) => line.trim())
    ?.trim();

  return (
    <Box flexDirection="column" width={columns} height={terminalRows}>
      <Box gap={2}>
        <Text color={DASH_CHROME_COLOR.furniture}>{DASH_CHROME.robot}</Text>
        {RENDER_PRIORITY.filter((state) => count(view, state) > 0).map((state) => (
          <Text key={state} color={DASH_COLOR[state]} bold>
            {DASH_GLYPH[state]} {count(view, state)}
          </Text>
        ))}
        <Text dimColor>{fetchedText(view, now)}</Text>
        <Text dimColor>sort {prefs.sort}</Text>
      </Box>
      {notice ? <Text>{notice}</Text> : null}
      <Box flexDirection={placement === "right" ? "row" : "column"} flexGrow={1}>
        <Box
          flexDirection="column"
          width={placement === "right" ? `${Math.round((1 - share) * 100)}%` : "100%"}
          height={placement === "bottom" ? cardHeight : undefined}
        >
          {shown.map((pane) => (
            <Card
              key={paneKey(pane)}
              pane={pane}
              selected={paneKey(pane) === paneKey(selected ?? pane)}
              glanceLine={pane === selected ? glanceLine : undefined}
            />
          ))}
        </Box>
        <Box
          borderStyle="single"
          flexDirection="column"
          width={placement === "right" ? `${Math.round(share * 100)}%` : "100%"}
          height={placement === "bottom" ? Math.max(5, bodyRows - cardHeight) : undefined}
          paddingX={1}
        >
          <Text wrap="truncate-end">{glance}</Text>
        </Box>
      </Box>
      <Text>
        <Text bold>j/k</Text> select <Text bold>enter</Text> jump <Text bold>s</Text> sort:
        <Text bold>{prefs.sort}</Text> <Text bold>f</Text> stale:
        <Text bold>{prefs.hide_stale ? "off" : "on"}</Text> <Text bold>a</Text> crew:
        <Text bold>{prefs.crew ? "on" : "off"}</Text> <Text bold>+/-</Text> preview{" "}
        <Text bold>^r</Text> refresh <Text bold>q</Text> quit
      </Text>
      {message ? <Text color="red">{message}</Text> : null}
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
        const instance = render(<App store={store} initial={status(store, identity)} />);
        await instance.waitUntilExit();
      } finally {
        store.close();
      }
    });
}
