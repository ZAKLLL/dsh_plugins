/**
 * Render regression test.
 *
 * The browser is the only place these components normally run, and this session
 * has no browser control — so this test renders them in Node against a minimal
 * React runtime. It exists because a `const` referenced from a `useMemo`
 * dependency array *above* its own declaration (a temporal dead zone) shipped
 * once: `node --check` cannot see it, and the slot system's only outward sign
 * was `active: false` on an occupant.
 *
 *   node test/render.mjs
 *
 * It loads the real `client.js` through its own `window.__ModuleLoader__`
 * handshake, drives `apply()` with a stub Cordis context to capture the
 * registered components, and then renders them. `fetch` is forwarded to the real
 * Host route, so the data path the components actually use is exercised too.
 *
 * The React stand-in is deliberately small: a component is a plain function, a
 * function element is invoked eagerly, and hook cells persist per component
 * identity so a second pass sees the state the first pass's effects produced.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

/* ------------------------------------------------------------------ *
 * A minimal React
 * ------------------------------------------------------------------ */

const cells = new Map();
let frames = [];
let pathCounts = new Map();
let pendingEffects = [];
/**
 * Forces a specific `useState` initial value for the next render, so a branch
 * that a click normally reaches (the sidebar tab's mode) can be rendered
 * deterministically. Cleared by every ordinary render.
 */
let stateSeeds = null;

function useCell() {
  const frame = frames[frames.length - 1];
  const index = frame.index++;
  if (frame.cells[index] === undefined) frame.cells[index] = {};
  return frame.cells[index];
}

function renderComponent(type, props) {
  // React refuses an element whose type is neither a tag name nor a component,
  // and a component that crashes here is exactly what the Host reports as an
  // abdicated slot occupant (`active: false`). Without this check the harness
  // cheerfully rendered `h({...})` and hid a real crash.
  if (typeof type !== "string" && typeof type !== "function") {
    throw new TypeError(`invalid element type: ${Object.prototype.toString.call(type)}`);
  }
  const parent = frames.length > 0 ? frames[frames.length - 1].path : "";
  const path = `${parent}/${type.name || "anon"}`;
  const occurrence = (pathCounts.get(path) ?? 0) + 1;
  pathCounts.set(path, occurrence);
  const key = `${path}#${occurrence}`;

  let frame = cells.get(key);
  if (frame === undefined) {
    frame = { path, index: 0, cells: [] };
    cells.set(key, frame);
  }
  frame.index = 0;
  frames.push(frame);
  try {
    return type(props);
  } finally {
    frames.pop();
  }
}

const React = {
  Fragment: Symbol("Fragment"),
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    if (typeof type === "function") return renderComponent(type, merged);
    return { type, props: merged };
  },
  useState(initial) {
    const cell = useCell();
    if (!("value" in cell)) {
      // Keyed by String(initial) so a null-initial state (the live tile selection)
      // is reachable as well as a string one (the sidebar tab's mode).
      const seeded = stateSeeds !== null ? stateSeeds.get(String(initial)) : undefined;
      cell.value = seeded !== undefined ? seeded : typeof initial === "function" ? initial() : initial;
    }
    return [
      cell.value,
      (next) => {
        cell.value = typeof next === "function" ? next(cell.value) : next;
      },
    ];
  },
  useMemo: (compute) => compute(),
  useCallback: (fn) => fn,
  useEffect(fn) {
    pendingEffects.push(fn);
  },
  useRef(initial) {
    const cell = useCell();
    if (!("ref" in cell)) cell.ref = { current: initial ?? null };
    return cell.ref;
  },
  useSyncExternalStore(_subscribe, get) {
    return get();
  },
  memo: (fn) => fn,
};

/** One render pass: fresh traversal bookkeeping, effects collected for later. */
function render(type, props, seeds = null) {
  frames = [];
  pathCounts = new Map();
  pendingEffects = [];
  stateSeeds = seeds;
  let tree;
  try {
    tree = React.createElement(type, props);
  } finally {
    stateSeeds = null;
  }
  return { tree, effects: pendingEffects.slice() };
}

/** Every host element in the produced tree, in order. */
function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  out.push(node);
  flatten(node.props?.children, out);
  return out;
}

/** Host elements carrying an exact class token — `sh-row` must not match `sh-row-title`. */
const hostElements = (tree, className) =>
  flatten(tree).filter(
    (node) =>
      typeof node.type === "string" &&
      typeof node.props?.className === "string" &&
      node.props.className.split(/\s+/).includes(className),
  );

/** The concatenated text under a node, so a failure can quote what rendered. */
function textOf(node) {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node === null || node === undefined || typeof node !== "object") return "";
  return textOf(node.props?.children);
}

/* ------------------------------------------------------------------ *
 * The Host half, so `load()` has something real to talk to
 * ------------------------------------------------------------------ */

const host = await import("../index.js");
let route = null;
host.apply({
  connection: { fetch: { register: (registered) => { route = registered; } } },
  effect: (callback) => {
    const dispose = callback();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  get: () => undefined,
});
assert.ok(route !== null, "the Host half must register its route");

const realFetch = globalThis.fetch;
/** The bundle runs inside a vm sandbox, so `fetch` has to be handed to it too. */
/**
 * One synthetic running agent, so the live branch renders the same content on
 * every machine instead of depending on what happens to be running here.
 */
const FAKE_LIVE = {
  key: "claude:/tmp/render-fixture.jsonl",
  agent: "claude",
  agentLabel: "Claude Code",
  title: "render fixture session",
  project: "render-fixture",
  cwd: "/tmp/render-fixture",
  file: "/tmp/render-fixture.jsonl",
  sessionId: "00000000-0000-4000-8000-000000000000",
  resumeCommand: "claude --resume 00000000-0000-4000-8000-000000000000",
  input: "the prompt that started it",
  output: "the latest thing it said",
  phase: "working",
  at: Date.now(),
  source: "store",
  pid: 4242,
  startedAt: Date.now() - 5 * 60 * 1000,
  elapsedMs: 5 * 60 * 1000,
  model: "selftest-provider/selftest-model",
  models: {
    "selftest-provider/selftest-model": { input: 4719, output: 235, cacheRead: 1024, cacheWrite: 0, total: 5978 },
    "selftest-provider/other-model": { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, total: 1100 },
  },
  tokens: { input: 5719, output: 335, cacheRead: 1024, cacheWrite: 0, total: 7078 },
  pending: { kind: "approval", label: "plugin_manager", count: 1 },
};

const stubFetch = async (url, init) => {
  if (String(url).includes("/api/session-hub")) {
    const payload = (() => {
      try {
        return JSON.parse(init?.body ?? "{}");
      } catch {
        return {};
      }
    })();
    if (payload.op === "preview") {
      return Response.json({ ok: true, runningCount: 1, sessions: [FAKE_LIVE] });
    }
    return route.fetch(new Request("http://127.0.0.1/api/session-hub", init));
  }
  return realFetch(url, init);
};
globalThis.fetch = stubFetch;

/* ------------------------------------------------------------------ *
 * Load client.js exactly the way the browser module table does
 * ------------------------------------------------------------------ */

const source = await readFile(new URL("../client.js", import.meta.url), "utf8");
let factory = null;
const loadedIds = [];
const window = {
  // `useEscape` listens on the window; without this a dialog that renders fine
  // in a browser throws in the sandbox.
  addEventListener: () => {},
  removeEventListener: () => {},
  __ModuleLoader__: {
    load: ({ id, factory: register }) => {
      loadedIds.push(id);
      factory = register;
    },
  },
};
// `File` has to be handed in too: the drag payload builds one, and without it
// the sandbox throws where a browser would not.
vm.runInNewContext(source, { window, console, fetch: stubFetch, setTimeout, clearTimeout, setInterval, clearInterval, File });

assert.deepEqual(loadedIds, ["dsh-session-hub"], "the bundle must register itself under its package name");
assert.equal(typeof factory, "function");

const plugin = factory((specifier) => {
  if (specifier === "react") return React;
  throw new Error(`unexpected require("${specifier}")`);
});
assert.equal(plugin.name, "dsh-session-hub");
// Spread into this realm: the bundle's arrays come from the vm context.
assert.deepEqual([...plugin.inject], ["slots", "locale"]);

/* ------------------------------------------------------------------ *
 * Capture what the plugin registers
 * ------------------------------------------------------------------ */

const registered = new Map();
/** Keyed by slot name *and* cell key: the right-Sidebar body and its chip share one key. */
const slotId = (options) => `${options.name}#${options.key ?? options.id}`;
const slots = {
  inject: (_key, callback) => {
    callback();
    return () => {};
  },
  register: (options, component) => {
    registered.set(slotId(options), component);
    return () => {};
  },
};

function makeContext() {
  const ctx = {
    slots,
    effect: (fn) => {
      const disposer = typeof fn === "function" ? fn() : undefined;
      return () => {
        if (typeof disposer === "function") disposer();
      };
    },
    inject: (names, fn) => {
      const scope = makeContext();
      for (const name of names) {
        if (name === "sidebarRightTabs") scope.sidebarRightTabs = { register: () => () => {} };
        if (name === "uiWorkspace") scope.uiWorkspace = undefined;
      }
      fn(scope);
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    get: () => undefined,
  };
  return ctx;
}

plugin.apply(makeContext());

const expected = [
  "sidebar.footer.action#session-hub",
  "shell.overlay#session-hub-panel",
  "shell.overlay#session-hub-confirm",
  "shell.overlay#session-hub-spawn",
  "shell.overlay#session-hub-preview",
  "conversation.composer.dock#session-hub-bridge",
  "sidebar.right.pane.tab#dsh-session-hub",
  "sidebar.right.pane.tab.title#dsh-session-hub",
];
for (const id of expected) assert.ok(registered.has(id), `apply() must register "${id}"`);
assert.equal(registered.size, expected.length, "apply() must not register anything else");
console.log(`registered ${registered.size} components`);

/* ------------------------------------------------------------------ *
 * Render everything that can render
 * ------------------------------------------------------------------ */

const SidebarTab = registered.get("sidebar.right.pane.tab#dsh-session-hub");
const TabTitle = registered.get("sidebar.right.pane.tab.title#dsh-session-hub");
const Overlay = registered.get("shell.overlay#session-hub-panel");
const Confirm = registered.get("shell.overlay#session-hub-confirm");
const Spawn = registered.get("shell.overlay#session-hub-spawn");
const Preview = registered.get("shell.overlay#session-hub-preview");
const Bridge = registered.get("conversation.composer.dock#session-hub-bridge");
assert.equal(typeof SidebarTab, "function");
assert.equal(typeof TabTitle, "function");
assert.equal(typeof Overlay, "function");
assert.equal(typeof Confirm, "function");
assert.equal(typeof Spawn, "function");
assert.equal(typeof Preview, "function");
assert.equal(typeof Bridge, "function");

// The bridge and the confirm dialog are legitimately null-rendering here.
assert.equal(render(Confirm, {}).tree, null, "no pending delete means no dialog");
assert.equal(render(Spawn, {}).tree, null, "no pending project means no spawn dialog");
assert.equal(render(Preview, {}).tree, null, "no selected session means no reader");
assert.equal(render(Bridge, { sessionId: "s", inputActions: null }).tree, null, "the bridge renders nothing");
// `Overlay` is gated on its store, which starts closed.
assert.equal(render(Overlay, {}).tree, null, "the overlay is closed by default");
// The chip is a small leaf component.
assert.ok(render(TabTitle, {}).tree !== null, "the tab chip must render");

// The first pass runs the component bodies with no data yet, which is exactly
// where a temporal-dead-zone reference in a dependency array throws.
const first = render(SidebarTab, { sessionId: "selftest", inputActions: null });
assert.ok(first.tree !== null, "the sidebar tab must render a tree");

// Run the effects the first pass scheduled — `load()` fetches the real inventory.
// Their cleanups matter: the live-state poll leaves an interval behind.
const cleanups = [];
for (const effect of first.effects) {
  const cleanup = effect();
  if (typeof cleanup === "function") cleanups.push(cleanup);
}

// The first `list` of a process walks every session store, so give it room and
// re-render until the data lands rather than guessing at one delay.
let second = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  second = render(SidebarTab, { sessionId: "selftest", inputActions: null });
  for (const effect of second.effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  if (hostElements(second.tree, "sh-group-head").length > 0) break;
}
assert.ok(second !== null, "the second pass must produce a tree");

// One more pass: state an effect wrote (the group collapse default) only shows
// on the render after it ran.
second = render(SidebarTab, { sessionId: "selftest", inputActions: null });
for (const effect of second.effects) {
  const cleanup = effect();
  if (typeof cleanup === "function") cleanups.push(cleanup);
}

const rows = hostElements(second.tree, "sh-row");
const groups = hostElements(second.tree, "sh-group-head");
const carets = hostElements(second.tree, "sh-caret-btn");
const pins = hostElements(second.tree, "sh-pin-btn");

if (process.env.RENDER_DEBUG === "1") {
  for (const node of flatten(second.tree)) {
    if (typeof node.type === "string") console.log(`  <${node.type} class="${node.props?.className ?? ""}"> ${JSON.stringify(textOf(node).slice(0, 60))}`);
  }
}
const said = hostElements(second.tree, "sh-empty").map(textOf).join(" | ");
assert.ok(groups.length > 0, `the second pass must render project groups — the panel said: ${JSON.stringify(said)}`);
assert.ok(rows.length > 0, "the second pass must render session rows");
assert.ok(pins.length >= rows.length, "every row must offer a pin toggle");

// The row cap is part of the contract: a group opens on its newest page.
const perGroup = new Map();
for (const row of rows) {
  perGroup.set(row, (perGroup.get(row) ?? 0) + 1);
}
console.log(`rendered: ${groups.length} group headers, ${rows.length} rows, ${carets.length} disclosure toggles, ${pins.length} pin toggles`);

// The right Sidebar tab must offer both modes, and the project header must keep
// its controls on the header line rather than wrapping them below it.
const modes = hostElements(second.tree, "sh-modes");
assert.equal(modes.length, 1, "the sidebar tab must render exactly one mode switch");
assert.equal(hostElements(second.tree, "sh-chip").filter((node) => modes[0].props.children.includes(node)).length, 2, "the switch must hold two modes");
assert.equal(hostElements(second.tree, "sh-group-line").length, 0, "the stray group separator must be gone");
const groupActions = hostElements(second.tree, "sh-group-actions");
assert.ok(groupActions.length > 0, "every project header must carry its controls");
assert.equal(groupActions.length, groups.length, "one control cluster per project header");
for (const cluster of groupActions) {
  const controls = flatten(cluster).filter((node) => node.type === "button");
  assert.equal(controls.length, 4, "a project header must offer editor, new-session, pin and delete");
  assert.ok(
    controls.every((control) => typeof control.props.title === "string" && control.props.title !== ""),
    "every project control needs a tooltip",
  );
}

// Every project header states when that project was last touched, so a
// collapsed group still says how recent it is.
const groupTimes = hostElements(second.tree, "sh-group-time");
assert.equal(groupTimes.length, groups.length, "every project header must show its last-activity time");
for (const node of groupTimes) {
  const text = textOf(node);
  assert.ok(text.length > 0 && text !== "\u2014", `a project time must be a real reading: ${JSON.stringify(text)}`);
  assert.ok(
    typeof node.props.title === "string" && node.props.title.length > 0,
    "the project time must explain itself on hover",
  );
}

// ---- what a drag actually carries ----------------------------------
// The composer inserts `text/plain` literally, and the attachment layer takes
// any `Files` item — so a payload that only names the store reads as a stray
// file name. This drives the real handler and inspects what it sets.
const dragRow = rows[0];
assert.ok(dragRow, "a row is needed to test the drag payload");

// Hover first: `dragstart` cannot await, so the transcript has to be cached
// before the drag begins. That ordering is the whole point of the prefetch.
const transferFor = (captured) => ({
  effectAllowed: null,
  items: { add: (file) => captured.files.push(file) },
  setData: (type, value) => {
    if (type === "text/plain") captured.plain = value;
  },
});

dragRow.props.onPointerEnter();
const captured = { plain: null, files: [] };
for (let attempt = 0; attempt < 40; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  captured.plain = null;
  captured.files.length = 0;
  dragRow.props.onDragStart({ dataTransfer: transferFor(captured) });
  if (captured.files.length > 0) break;
}

assert.equal(typeof captured.plain, "string", "a drag must set a text payload");
assert.ok(
  !/^\(history still loading|.*\.jsonl/m.test(captured.plain) || captured.plain.startsWith("# Session:"),
  `the text payload must be the history, not a path: ${captured.plain.slice(0, 120)}`,
);
assert.ok(
  captured.plain.startsWith("# Session:"),
  `the prefetched history must be what the drag carries: ${captured.plain.slice(0, 120)}`,
);
assert.equal(captured.files.length, 1, "and it must also offer the history as a file");
assert.ok(
  captured.files[0].name.endsWith(".md") && !/^claude-|^codex-|^dsh-/.test(captured.files[0].name),
  `the attachment must be named after the session, not the store: ${captured.files[0].name}`,
);
assert.ok(captured.files[0].size > 0, "the attachment must not be empty");
console.log(`drag: ${captured.files[0].name} (${captured.files[0].size} bytes), text payload is the history`);

// Only the topmost group opens by default; the rest start collapsed, or a
// corpus of hundreds of sessions across dozens of projects is just noise.
const opened = groups.filter((head) =>
  flatten(head).some(
    (node) => typeof node.props?.className === "string" && node.props.className.split(/\s+/).includes("sh-group-arrow-open"),
  ),
);
assert.equal(opened.length, 1, "exactly one project must be expanded on open");
assert.equal(hostElements(second.tree, "sh-rowlist").length, 1, "only the expanded group may render rows");
assert.ok(rows.length > 0, "the expanded group must render its page");
assert.ok(rows.length <= 400, "the render must stay bounded by paging");

// No element may carry a NaN or an `undefined` child where text belongs.
for (const node of flatten(second.tree)) {
  if (typeof node.props?.className !== "string") continue;
  if (node.props.className.includes("sh-row-title")) {
    assert.ok(typeof node.props.children === "string", "a row title must be a string");
    assert.ok(!node.props.children.includes("undefined"), `a row title leaked undefined: ${node.props.children}`);
  }
}

// ---- the live mode: same verbs, same drag --------------------------
// Reached by seeding the mode state, since a click cannot be dispatched here.
// The preview payload is synthetic so this asserts the same thing everywhere.
// Hook cells are cleared first: a seed only applies to a state's first render.
cells.clear();
const liveSeeds = new Map([
  ["sessions", "live"],
  // Seed the tile selection too: a click cannot be dispatched here, and the
  // detail panel is only reachable through it.
  ["null", FAKE_LIVE.key],
]);
let live = render(SidebarTab, { sessionId: "selftest", inputActions: null }, liveSeeds);
for (const effect of live.effects) {
  const cleanup = effect();
  if (typeof cleanup === "function") cleanups.push(cleanup);
}
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  live = render(SidebarTab, { sessionId: "selftest", inputActions: null }, liveSeeds);
  if (hostElements(live.tree, "sh-lp-card").length > 0) break;
}

const tiles = hostElements(live.tree, "sh-tile");
assert.equal(tiles.length, 1, "the seeded preview must render one tile");
assert.equal(tiles[0].props.draggable, true, "a tile must drag into the composer");
assert.equal(typeof tiles[0].props.onDragStart, "function");
assert.equal(typeof tiles[0].props.onPointerEnter, "function", "a tile must prefetch on hover");
assert.equal(tiles[0].props.role, "button", "a tile must be clickable and focusable");
assert.ok(
  flatten(tiles[0]).some((node) => node.props?.className === "sh-tile-badge sh-tile-badge-wait"),
  "a session waiting on approval must be badged on its tile",
);
// The title is what makes a tile useful: without it the grid only says that
// something is running, not what.
const tileTitleNodes = flatten(live.tree).filter(
  (node) => typeof node.props?.className === "string" && node.props.className.split(/\s+/).includes("sh-tile-title"),
);
assert.equal(tileTitleNodes.length, 1, "every tile must carry the session title");
assert.equal(textOf(tileTitleNodes[0]), FAKE_LIVE.title, "the tile must show that session's own title");
assert.ok(
  flatten(live.tree).some((node) => typeof node.props?.className === "string" && node.props.className.split(/\s+/).includes("sh-tile-head")),
  "a tile must lay its agent and duration out on a head row",
);

// The detail panel is what a click opens; the selection is seeded above.
// A tile jumps straight out, so the grid answers "where is it" without a detour
// through the detail panel — and that click must not also select the tile.
const tileButtons = flatten(tiles[0]).filter((node) => node.type === "button");
assert.equal(tileButtons.length, 1, "a tile must offer a quick jump");
assert.ok(
  typeof tileButtons[0].props.title === "string" && tileButtons[0].props.title !== "",
  "the jump needs a tooltip, because the same icon means focus or resume",
);
let jumpStopped = false;
tileButtons[0].props.onClick({ stopPropagation: () => { jumpStopped = true; } });
assert.equal(jumpStopped, true, "the jump must not also toggle the tile selection");

const detail = hostElements(live.tree, "sh-lp-card");
assert.equal(detail.length, 1, "selecting a tile must render its detail panel");
assert.equal(detail[0].props.draggable, true, "the detail panel must drag too");

const liveActions = hostElements(live.tree, "sh-lp-actions");
assert.equal(liveActions.length, 1, "the detail panel must carry its own action cluster");
const liveButtons = flatten(liveActions[0]).filter((node) => node.type === "button");
assert.equal(liveButtons.length, 3, "the detail panel must offer continue, resume and close");
for (const button of liveButtons) assert.equal(typeof button.props.title, "string", "each action needs a tooltip");

// Every fact the detail panel exists for must actually be on it.
const lineText = hostElements(live.tree, "sh-lp-v").map(textOf);
// Labels as well as values: the per-model rows put the model name in the label
// and its usage in the value, so reading only the values hides the name.
const joined = [...lineText, ...hostElements(live.tree, "sh-lp-k").map(textOf)].join(" | ");
assert.ok(joined.includes(FAKE_LIVE.cwd), `the detail must show the directory: ${joined}`);
assert.ok(/5m/.test(joined), `the detail must show how long it has been up: ${joined}`);
for (const label of ["tokIn", "tokOut", "tokTotal"]) {
  assert.ok(joined.includes(label), `the detail must break the token total down: ${joined}`);
}
assert.ok(joined.includes("7.1k") || joined.includes("7078"), `the detail must show the total it spent: ${joined}`);
// A session that switched models must name each one and show its own usage.
assert.ok(joined.includes(FAKE_LIVE.model), `the detail must name the model in effect: ${joined}`);
assert.ok(
  joined.includes("selftest-provider/other-model"),
  `the detail must show every model the session used, not only the last: ${joined}`,
);
assert.ok(joined.includes("plugin_manager"), `the detail must name what it waits on: ${joined}`);
assert.deepEqual(
  lineText.slice(-2),
  [FAKE_LIVE.input, FAKE_LIVE.output],
  "the detail must still show the input and the latest output",
);
const kinds = hostElements(live.tree, "sh-lp-kind").map(textOf);
assert.equal(kinds.length, 1, "the detail must state its source");
assert.ok(kinds[0].length > 0, `the source line must not be empty: ${JSON.stringify(kinds[0])}`);
assert.ok(
  flatten(detail[0]).some((node) => typeof node.props?.className === "string" && node.props.className.includes("sh-lp-mono")),
  "the directory must be rendered as a path, not prose",
);
console.log(`live: 1 tile, 1 detail panel, ${liveButtons.length} actions, drag enabled, source stated`);

// ---- the reader -----------------------------------------------------
// Transcripts carry far more `> tool:` lines than turns (216 against 43 in one
// session here), so the reader must pull them out of the prose — otherwise it is
// a wall of call names. Find a row that actually has some.
// Transcripts carry far more `> tool:` lines than turns (216 against 43 in one
// session here), so the reader must lift them out of the prose — otherwise it is
// a wall of call names. A rendered row does not carry its key, so walk the rows
// until one whose turns actually contain a tool call is found.
let reader = null;
let sawTitle = false;
for (const candidate of rows.slice(0, 8)) {
  const titleNode = flatten(candidate).find(
    (node) => typeof node.props?.className === "string" && node.props.className.split(/\s+/).includes("sh-row-title-open"),
  );
  if (titleNode === undefined) continue;
  if (!sawTitle) {
    assert.equal(typeof titleNode.props.onClick, "function", "a row title must open the reader");
    assert.equal(typeof titleNode.props.title, "string", "and say so on hover");
    sawTitle = true;
  }

  titleNode.props.onClick();
  let view = render(Preview, {});
  for (const effect of view.effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    view = render(Preview, {});
    if (hostElements(view.tree, "sh-turn").length > 0) break;
  }
  reader = view;
  if (hostElements(view.tree, "sh-turn-tool").length > 0) break;
}

assert.ok(sawTitle, "a row title must open the reader");
assert.ok(reader !== null, "the reader must render");
const turns = hostElements(reader.tree, "sh-turn");
assert.ok(turns.length > 0, "the reader must render the session's turns");
assert.equal(hostElements(reader.tree, "sh-read-body").length, 1, "and scroll inside its own body");
assert.ok(hostElements(reader.tree, "sh-turn-user").length > 0, "user turns must be marked as such");
for (const who of hostElements(reader.tree, "sh-turn-who").map(textOf)) {
  assert.ok(who.length > 0, "every turn must name its speaker");
}
for (const dot of hostElements(reader.tree, "sh-turn-dot")) {
  const cls = String(dot.props.className);
  assert.ok(cls.includes("sh-turn-dot-user") || cls.includes("sh-turn-dot-assistant"), "each speaker line carries its role dot");
}
const chips = hostElements(reader.tree, "sh-turn-tool");
assert.ok(chips.length > 0, "tool calls must be lifted out of the prose");
const prose = hostElements(reader.tree, "sh-turn-text").map(textOf).join("\n");
assert.ok(!/^>\s*tool:/m.test(prose), "no raw tool line may be left in what was said");
console.log(`reader: ${turns.length} turns, ${chips.length} tool chips lifted out of the prose`);
// The reader names the model it is showing, beside the agent.
const readerModel = hostElements(reader.tree, "sh-read-model");
assert.equal(readerModel.length, 1, "the reader must name the model");
assert.ok(textOf(readerModel[0]).length > 0, "and the name must not be empty");
assert.equal(typeof readerModel[0].props.title, "string", "with a tooltip");

// ---- the agent signs itself in the row head -------------------------
// The short tag replaces a plain-text name that sat among the hover actions and
// read as a stray label there.
const tags = hostElements(second.tree, "sh-agent-tag");
assert.ok(tags.length > 0, "rows must carry the agent tag");
const tagClasses = tags.map((tag) => String(tag.props.className));
for (const tag of tags) {
  assert.equal(typeof tag.props.title, "string", "the tag must name the agent in full on hover");
  assert.ok(tag.props.title.length > 0, "and the name must not be empty");
  assert.ok(
    ["claude", "codex", "gemini", "pi", "dsh", "opencode"].includes(textOf(tag)),
    `the tag must read as the agent id, not an abbreviation: ${JSON.stringify(textOf(tag))}`,
  );
}
assert.ok(
  tagClasses.every((cls) => /sh-agent-dot-[a-z]+/.test(cls)),
  "the tag must take its colour from the agent's own class rather than a second palette",
);
assert.ok(
  tagClasses.every((cls) => !cls.split(/\s+/).includes("sh-agent-dot")),
  "and only the colour class — the sizing one would make it a dot again",
);
assert.equal(
  hostElements(second.tree, "sh-row-agent").length,
  0,
  "the old plain-text label must be gone from the action cluster",
);
console.log(`tag: ${tags.length} agent tags in the row head`);

for (const cleanup of cleanups) cleanup();
globalThis.fetch = realFetch;
console.log("\nrender test: all assertions passed");
