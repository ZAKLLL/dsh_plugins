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
      const seeded = stateSeeds !== null && typeof initial === "string" ? stateSeeds.get(initial) : undefined;
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
  __ModuleLoader__: {
    load: ({ id, factory: register }) => {
      loadedIds.push(id);
      factory = register;
    },
  },
};
vm.runInNewContext(source, { window, console, fetch: stubFetch, setTimeout, clearTimeout, setInterval, clearInterval });

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
const Bridge = registered.get("conversation.composer.dock#session-hub-bridge");
assert.equal(typeof SidebarTab, "function");
assert.equal(typeof TabTitle, "function");
assert.equal(typeof Overlay, "function");
assert.equal(typeof Confirm, "function");
assert.equal(typeof Bridge, "function");

// The bridge and the confirm dialog are legitimately null-rendering here.
assert.equal(render(Confirm, {}).tree, null, "no pending delete means no dialog");
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
const liveSeeds = new Map([["sessions", "live"]]);
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

const cards = hostElements(live.tree, "sh-lp-card");
assert.equal(cards.length, 1, "the seeded preview must render one live card");
assert.equal(cards[0].props.draggable, true, "a live card must drag into the composer");
assert.equal(typeof cards[0].props.onDragStart, "function");
assert.equal(typeof cards[0].props.onPointerEnter, "function", "a live card must prefetch on hover");

const liveActions = hostElements(live.tree, "sh-lp-actions");
assert.equal(liveActions.length, 1, "the live card must carry its own action cluster");
const liveButtons = flatten(liveActions[0]).filter((node) => node.type === "button");
assert.equal(liveButtons.length, 2, "the live card must offer continue and resume");
for (const button of liveButtons) assert.equal(typeof button.props.title, "string", "each action needs a tooltip");

// The reading itself, and where it came from, must both be on the card.
const kinds = hostElements(live.tree, "sh-lp-kind").map(textOf);
assert.equal(kinds.length, 1, "the live card must state its source");
assert.ok(kinds[0].length > 0, `the source line must not be empty: ${JSON.stringify(kinds[0])}`);
const values = hostElements(live.tree, "sh-lp-v").map(textOf);
assert.deepEqual(values, [FAKE_LIVE.input, FAKE_LIVE.output], "the card must show the input and the latest output");
console.log(`live: 1 card, ${liveButtons.length} actions, drag enabled, source stated`);

for (const cleanup of cleanups) cleanup();
globalThis.fetch = realFetch;
console.log("\nrender test: all assertions passed");
