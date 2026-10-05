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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { parseSshConfig } from "../environments.js";
import { mkdtemp, readFile } from "node:fs/promises";
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

/**
 * Keep this plugin's own files out of the real ones.
 *
 * The environment file remembers which machine the panel is pointed at, and this
 * test reads the real session stores on purpose. Pointing both at the same place
 * made the suite depend on the person's last switch: the day a remote host
 * became a saved environment, `list` began failing on a dead tunnel instead of on
 * what was being tested. Only pins, the hook spool and the chosen environment
 * move — `sessions/` stays real.
 */
process.env.DSH_SESSION_HUB_HOME = await mkdtemp(join(tmpdir(), "dsh-session-hub-state-"));

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

const FAKE_MESSAGES = {
  ok: true,
  agent: "claude",
  agentLabel: "Selftest Agent",
  title: "selftest conversation",
  cwd: "/tmp/selftest",
  model: "selftest-provider/selftest-model",
  models: null,
  key: "selftest",
  total: 5,
  truncated: false,
  messages: [
    { role: "user", text: "第一个请求", at: "2026-10-02 10:00", collapsed: null },
    { role: "assistant", text: "先看一下\n\n> tool: `Read`", at: "2026-10-02 10:01", collapsed: null },
    {
      role: "assistant",
      text: [
        "第一个**最终回答**，带 `行内代码`。",
        "",
        "```js",
        "const answer = 42;",
        "```",
        "",
        "- 第一点",
        "- 第二点",
        "",
        "[安全链接](https://example.com/x) 与 [危险链接](javascript:alert(1))",
      ].join("\n"),
      at: "2026-10-02 10:02",
      collapsed: null,
    },
    { role: "compacted", text: "CTX-SUMMARY-这段应该初始隐藏", at: "2026-10-02 10:30", collapsed: 2735 },
    { role: "user", text: "第二个请求", at: "2026-10-02 11:00", collapsed: null },
    { role: "assistant", text: "第二个最终回答", at: "2026-10-02 11:01", collapsed: null },
  ],
};

/**
 * When set, the client is told the panel is pointed at another machine.
 *
 * Only the `environment` answer is faked: every other operation still reaches
 * the real Host route, so the data path stays real. This is what makes the
 * client's remote-only branches — which are exactly the ones that must not fall
 * back to opening something local — reachable in a test at all.
 */
let answerAsRemote = false;

const stubFetch = async (url, init) => {
  if (String(url).includes("/api/session-hub")) {
    const payload = (() => {
      try {
        return JSON.parse(init?.body ?? "{}");
      } catch {
        return {};
      }
    })();
    if (payload.op === "environment" && answerAsRemote) {
      return Response.json({
        ok: true,
        active: { id: "fake", kind: "remote", label: "Fake", alias: "fake", reachable: true, error: null },
        environments: [
          { id: "local", kind: "local", label: "本机", alias: null },
          { id: "fake", kind: "remote", label: "Fake", alias: "fake" },
        ],
        problems: [],
      });
    }
    if (payload.op === "open" && answerOpenAsCommand !== null && payload.launch !== true) {
      return Response.json({ ok: true, kind: "terminal-command", command: answerOpenAsCommand, cwd: "/tmp", sessionId: "s" });
    }
    if (payload.op === "preview") {
      return Response.json({ ok: true, runningCount: 1, sessions: [FAKE_LIVE] });
    }
    // The reader's shape is asserted here, so it is supplied here: one turn with
    // working-out, one compaction, one plain exchange.
    if (payload.op === "messages") {
      return Response.json(FAKE_MESSAGES);
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

/**
 * This window's built-in terminal, as the client reaches it.
 *
 * Stateful on purpose: the client tells the new tab apart by snapshotting the
 * open tabs *before* asking for one, so a stub that always showed the tab would
 * make every run look like "the terminal tab did not appear".
 */
const terminalCalls = { opened: [], written: [] };
let openTerminalTabs = [];
const terminalFaces = {
  sidebarRight: {
    commandTarget: () => ({ sessionId: "selftest" }),
    openTabs: { getSnapshot: () => openTerminalTabs },
    openTabFromTarget: (kind, target) => {
      terminalCalls.opened.push({ kind, sessionId: target?.sessionId });
      openTerminalTabs = [{ id: "tab-1", kind: "terminal", sessionId: "selftest", contentId: "content-1" }];
    },
    tabDomain: { occurrence: () => ({ navigation: { getSnapshot: () => ({ params: {}, address: "content-1" }) } }) },
  },
  webTerminals: {
    view: () => ({
      attachmentId: "attachment-1",
      state: { getSnapshot: () => ({ writable: true }) },
      write: (text) => terminalCalls.written.push(text),
    }),
  },
};

/** When set, `open` answers with a command for the terminal instead of acting. */
let answerOpenAsCommand = null;

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
        if (name === "sidebarRight") scope.sidebarRight = terminalFaces.sidebarRight;
        if (name === "webTerminals") scope.webTerminals = terminalFaces.webTerminals;
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
  "shell.overlay#session-hub-config",
  "shell.overlay#session-hub-hosts",
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
const Config = registered.get("shell.overlay#session-hub-config");
const Hosts = registered.get("shell.overlay#session-hub-hosts");
const Bridge = registered.get("conversation.composer.dock#session-hub-bridge");
assert.equal(typeof SidebarTab, "function");
assert.equal(typeof TabTitle, "function");
assert.equal(typeof Overlay, "function");
assert.equal(typeof Confirm, "function");
assert.equal(typeof Spawn, "function");
assert.equal(typeof Preview, "function");
assert.equal(typeof Config, "function");
assert.equal(typeof Hosts, "function");
assert.equal(typeof Bridge, "function");

// The bridge and the confirm dialog are legitimately null-rendering here.
assert.equal(render(Confirm, {}).tree, null, "no pending delete means no dialog");
assert.equal(render(Spawn, {}).tree, null, "no pending project means no spawn dialog");
assert.equal(render(Preview, {}).tree, null, "no selected session means no reader");
assert.equal(render(Config, {}).tree, null, "the config editor is closed by default");
assert.equal(render(Hosts, {}).tree, null, "the machine manager is closed by default");
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
for (let attempt = 0; attempt < 10; attempt += 1) {
  // A scan reads every session's store, so leave room for a whole one: rendering
  // in a tight loop just issues another scan before the last has answered, and
  // then nothing ever settles.
  await new Promise((resolve) => setTimeout(resolve, 1500));
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
// The payload is synthetic (see FAKE_MESSAGES), so the assertions below describe
// a shape rather than whatever this machine happens to hold.
const titleNode = flatten(rows[0]).find(
  (node) => typeof node.props?.className === "string" && node.props.className.split(/\s+/).includes("sh-row-title-open"),
);
assert.ok(titleNode, "a row title must open the reader");
assert.equal(typeof titleNode.props.onClick, "function");
assert.equal(typeof titleNode.props.title, "string", "and say so on hover");
titleNode.props.onClick();

let reader = render(Preview, {});
for (const effect of reader.effects) {
  const cleanup = effect();
  if (typeof cleanup === "function") cleanups.push(cleanup);
}
for (let attempt = 0; attempt < 40; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  reader = render(Preview, {});
  if (hostElements(reader.tree, "sh-turn").length > 0) break;
}

const turns = hostElements(reader.tree, "sh-turn");
assert.ok(turns.length > 0, "the reader must render the session's turns");
assert.equal(hostElements(reader.tree, "sh-read-body").length, 1, "and scroll inside its own body");
assert.ok(hostElements(reader.tree, "sh-turn-user").length > 0, "user turns must be marked as such");
for (const who of hostElements(reader.tree, "sh-turn-who").map(textOf)) {
  assert.ok(who.length > 0, "every turn must name its speaker");
}
const prose = hostElements(reader.tree, "sh-turn-text").map(textOf).join("\n");
assert.ok(!/^>\s*tool:/m.test(prose), "no raw tool line may be left in what was said");
assert.ok(prose.includes("第一个"), "the agent's answer must be shown");

// ---- one turn is a request plus its answer ---------------------------
const turnGroups = hostElements(reader.tree, "sh-turn-group");
assert.equal(turnGroups.length, 3, "a request, a compaction and a second request are three turns");
assert.ok(
  !prose.includes("CTX-SUMMARY"),
  "a compaction summary starts hidden — it is a seam, not something that was said",
);

const toggles = hostElements(reader.tree, "sh-steps-toggle");
assert.equal(toggles.length, 2, "one turn has working-out and one is a compaction");
for (const toggle of toggles) {
  assert.equal(typeof toggle.props.onClick, "function");
  assert.equal(typeof toggle.props.title, "string", "the toggle needs a tooltip");
  assert.equal(toggle.props["aria-expanded"], false, "and starts collapsed");
}

const before = hostElements(reader.tree, "sh-turn").length;
toggles[0].props.onClick();
await new Promise((resolve) => setTimeout(resolve, 400));
reader = render(Preview, {});
assert.ok(
  hostElements(reader.tree, "sh-turn").length > before,
  "opening the working-out must reveal the messages it was hiding",
);

const compactionToggle = hostElements(reader.tree, "sh-steps-toggle").find((node) =>
  flatten(node).some((child) => typeof child.props?.className === "string" && child.props.className.includes("sh-compacted-label")),
);
assert.ok(compactionToggle, "the compaction must be its own labelled seam");
compactionToggle.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 400));
reader = render(Preview, {});
assert.ok(
  hostElements(reader.tree, "sh-turn-text").map(textOf).join("\n").includes("CTX-SUMMARY"),
  "opening the compaction must show what the context was replaced with",
);
assert.ok(
  hostElements(reader.tree, "sh-compacted-count").length > 0,
  "and how much it folded away",
);
// ---- markdown is rendered, not printed raw ---------------------------
// A transcript is prose: code, lists and emphasis are the shape of what an agent
// said, and showing the asterisks instead of the emphasis makes it unreadable.
const all = flatten(reader.tree);
assert.ok(hostElements(reader.tree, "sh-md-code").length > 0, "inline code must be rendered");
assert.ok(all.some((node) => node.type === "strong"), "bold must be rendered as emphasis");
assert.ok(hostElements(reader.tree, "sh-md-list").length > 0, "a list must become a list");
assert.equal(
  all.filter((node) => node.type === "li").length,
  2,
  "two bullets must become two items",
);
const pre = hostElements(reader.tree, "sh-md-pre");
assert.equal(pre.length, 1, "a fenced block must become one code block");
assert.ok(
  flatten(pre[0]).some((node) => node.type === "code" && textOf(node).includes("const answer = 42;")),
  "and must keep the code it fenced",
);
assert.ok(
  flatten(pre[0]).some((node) => textOf(node) === "js"),
  "and label its language",
);

// Links are rendered, but only for schemes we will actually hand to the OS: a
// transcript holds whatever the session quoted, `javascript:` included.
const links = all.filter((node) => node.type === "a");
assert.equal(links.length, 1, `only the safe link may become a link: ${JSON.stringify(links.map((l) => l.props.href))}`);
assert.equal(links[0].props.href, "https://example.com/x");
assert.equal(links[0].props.rel, "noreferrer", "an external link must not carry the opener");
assert.equal(links[0].props.target, "_blank");
assert.ok(
  !all.some((node) => node.type === "a" && /^javascript:/i.test(String(node.props?.href ?? ""))),
  "a javascript: URL must never become a link",
);
assert.ok(
  hostElements(reader.tree, "sh-turn-text").map(textOf).join("\n").includes("危险链接"),
  "an unlinkable URL must still show its text, just not as a link",
);
console.log(`markdown: ${pre.length} code block(s), ${links.length} link(s), 1 unsafe URL kept as text`);

console.log(`turns: ${turnGroups.length} grouped, ${toggles.length} collapsible seams`);

// Every turn says when it happened.
const stamps = hostElements(reader.tree, "sh-turn-at").map(textOf);
assert.ok(stamps.length > 0, "turns must show their time");
for (const stamp of stamps) {
  assert.match(stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, `a turn time must be a readable stamp: ${stamp}`);
}
// The reader names the model it is showing, beside the agent.
const readerModel = hostElements(reader.tree, "sh-read-model");
assert.equal(readerModel.length, 1, "the reader must name the model");
assert.ok(textOf(readerModel[0]).length > 0, "and the name must not be empty");
assert.equal(typeof readerModel[0].props.title, "string", "with a tooltip");

// ---- every interactive control explains itself ------------------------
// Walked over everything that actually rendered, not over the source: a source
// grep cannot see which branch ran, and its window cuts off mid-props.
const buttons = flatten(second.tree).filter((node) => node.type === "button");
assert.ok(buttons.length > 0, "the panel must render buttons");
const bare = buttons.filter((node) => typeof node.props?.title !== "string" || node.props.title === "");
if (bare.length > 0) {
  const where = bare
    .map((node) => `${String(node.props?.className ?? "?")}[${JSON.stringify(textOf(node).slice(0, 24))}]`)
    .join(", ");
  assert.equal(bare.length, 0, `${bare.length} of ${buttons.length} buttons have no tooltip: ${where}`);
}
console.log(`tooltips: all ${buttons.length} rendered buttons explain themselves`);

// ---- which model answered last ---------------------------------------
// Read from the end of each store during the scan, so it is on the row itself
// rather than only in the live detail panel.
const models = hostElements(second.tree, "sh-row-model");
assert.ok(models.length > 0, "a row must name the model that answered last");
for (const chip of models) {
  const name = textOf(chip);
  assert.ok(name.length > 0, "the model name must not be empty");
  assert.equal(chip.props.title, name, "and must be readable in full on hover, since the row truncates it");
}
console.log(`model: ${models.length} rows name their model`);

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

// ---- the config editor ----------------------------------------------
// A click cannot be dispatched, but the node carries its handler, and the
// component reads its open state from a store — so calling the handler is
// exactly what the seat does. This is the only route to a state that a click
// normally reaches, and it must not throw: a TDZ or a bad hook order here is
// what leaves the slot occupant `active: false` in the real app.
const configChips = flatten(second.tree).filter(
  (node) => node.type === "button" && textOf(node) === "configMode",
);
assert.ok(configChips.length >= 1, "the panel must offer a way into the config editor");
configChips[0].props.onClick();

const dialog = render(Config, {});
assert.ok(dialog.tree !== null, "an opened config editor must render");
assert.equal(hostElements(dialog.tree, "sh-card-config").length, 1, "it must render in its own wider frame");
for (const effect of dialog.effects) {
  const cleanup = effect();
  if (typeof cleanup === "function") cleanups.push(cleanup);
}

// The list is fetched from the real Host, so give it the same room the scan gets.
let filled = dialog;
for (let attempt = 0; attempt < 6; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  filled = render(Config, {});
  for (const effect of filled.effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  if (hostElements(filled.tree, "sh-config-file").length > 0) break;
}
const configFiles = hostElements(filled.tree, "sh-config-file");
assert.ok(configFiles.length > 0, "the config editor must list the declared files");
const configGroups = hostElements(filled.tree, "sh-config-agent-name");
assert.ok(configGroups.length >= 4, `every agent that declares config must be grouped: ${configGroups.length}`);

// Opening a file is the other half. The first file in the catalogue is DSH's
// credential store, which is deliberately masked until it is revealed — so this
// asserts the mask first, then the reveal, then an ordinary file.
const credentials = configFiles.find((node) => textOf(node).startsWith(".credentials.yaml"));
assert.ok(credentials !== undefined, "the credential store must be listed");

/**
 * Click, wait for the request the click starts, then render.
 *
 * Effects are deliberately *not* run here. This harness has no dependency
 * comparison and no `useCallback` memoisation, so the panel's one-shot load
 * effect would re-run on every pass and clear the selection the click just
 * made. Real React does not re-run it — the dependencies are `[load, envId]` and
 * neither changed — so rendering without effects is the faithful comparison.
 */
const afterClick = async (node, delay = 600) => {
  node.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, delay));
  return render(Config, {});
};

const masked = await afterClick(credentials);
assert.equal(hostElements(masked.tree, "sh-config-editor").length, 0, "a credential file must not be shown just because it was opened");
const reveal = flatten(masked.tree).find((node) => node.type === "button" && textOf(node) === "configReveal");
assert.ok(reveal !== undefined, "a masked file must offer a way to reveal it");

const editor = await afterClick(reveal, 150);
const revealed = hostElements(editor.tree, "sh-config-editor");
assert.equal(revealed.length, 1, "revealing must open exactly one editor");
assert.ok(revealed[0].props.value.length > 0, "the revealed editor must hold the file's body");
assert.equal(typeof revealed[0].props.onChange, "function", "and must be editable");
assert.ok(hostElements(editor.tree, "sh-config-file").length === 0, "the list must give way to the editor");

// And an ordinary file opens directly, with no reveal step.
const back = flatten(editor.tree).find((node) => node.type === "button" && textOf(node).startsWith("‹ "));
assert.ok(back !== undefined, "the editor must offer a way back to the list");
const listed = await afterClick(back, 150);
const settings = hostElements(listed.tree, "sh-config-file").find((node) => textOf(node).startsWith("settings.json"));
assert.ok(settings !== undefined, "an ordinary file must be listed");
const ordinaryEditor = await afterClick(settings);
const ordinary = hostElements(ordinaryEditor.tree, "sh-config-editor");
assert.equal(ordinary.length, 1, "an ordinary file must open directly");
assert.ok(ordinary[0].props.value.includes("{"), "a JSON config must be readable as text");
console.log(`config: ${configGroups.length} agent groups, ${configFiles.length} files, ${ordinary[0].props.value.length} chars in settings.json`);

/* ------------------------------------------------------------------ *
 * A remote DSH session must not be opened as a local one
 * ------------------------------------------------------------------ */

/**
 * The client's DSH shortcut hands a session to *this* machine's workspace
 * registry. On a remote environment that is the worst possible answer: it opens
 * a local session with a remote id, which looks like it worked.
 *
 * The two branches are told apart by which toast they produce. This harness has
 * no `uiWorkspace` at all, so the local shortcut reports `failed`; going to the
 * Host instead reports `openNone`. Neither is a real outcome — the point is
 * *which* one happens.
 */
const dshOpenButton = (tree) =>
  flatten(tree).find(
    (node) => node.type === "button" && node.props?.title === "openInDsh",
  );

/**
 * A rendered DSH row to click.
 *
 * Three things have to be true, and all three are things a person does rather
 * than special cases for the test: the tab has to be in list mode (the live-view
 * section left it on the live view), the list has to be filtered to dsh (the
 * first page happens to be claude and codex), and each group has to be opened
 * (the list collapses all but one).
 *
 * Everything comes from a **fresh** render, and the inventory is refetched: the
 * live-view section clears the hook cells on purpose so its seed takes effect,
 * which wipes the panel's loaded sessions too — and a handler captured from a
 * tree built before that writes to an orphaned cell, so nothing would happen.
 */
async function findDshRow() {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 500));
  const runEffects = (tree) => {
    for (const effect of tree.effects) {
      const cleanup = effect();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    }
  };

  let tree = render(SidebarTab, { sessionId: "selftest", inputActions: null });
  const listMode = flatten(tree.tree).find((node) => node.type === "button" && textOf(node) === "modeList");
  if (listMode !== undefined) listMode.props.onClick();
  tree = render(SidebarTab, { sessionId: "selftest", inputActions: null });
  runEffects(tree);

  for (let attempt = 0; attempt < 10 && hostElements(tree.tree, "sh-group-head").length === 0; attempt += 1) {
    await tick();
    tree = render(SidebarTab, { sessionId: "selftest", inputActions: null });
    runEffects(tree);
  }
  assert.ok(hostElements(tree.tree, "sh-group-head").length > 0, "the list must load again after the cells were cleared");

  const chip = flatten(tree.tree).find((node) => node.type === "button" && textOf(node).startsWith("DSH"));
  assert.ok(chip !== undefined, "the agent filter must offer dsh");
  chip.props.onClick();
  tree = render(SidebarTab, { sessionId: "selftest", inputActions: null });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const collapsed = hostElements(tree.tree, "sh-group-head").filter((node) => node.props?.["aria-expanded"] === false);
    if (collapsed.length === 0) break;
    for (const head of collapsed) head.props.onClick();
    tree = render(SidebarTab, { sessionId: "selftest", inputActions: null });
  }
  return { tree, button: dshOpenButton(tree.tree) };
}

const clickAndRead = async (node) => {
  node.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 250));
  return hostElements(render(SidebarTab, { sessionId: "selftest", inputActions: null }).tree, "sh-toast")
    .map(textOf)
    .join(" ");
};

const localRow = await findDshRow();
assert.ok(localRow.button !== undefined, "a DSH row must offer an open control");
const localToast = await clickAndRead(localRow.button);
assert.ok(
  localToast.includes("failed"),
  `on this machine the DSH shortcut is taken (no uiWorkspace here, so it fails): ${JSON.stringify(localToast)}`,
);

// Now answer as a remote environment, and let the bar's effect pick it up.
answerAsRemote = true;
let remoteTree = render(SidebarTab, { sessionId: "selftest", inputActions: null });
for (const effect of remoteTree.effects) {
  const cleanup = effect();
  if (typeof cleanup === "function") cleanups.push(cleanup);
}
await new Promise((resolve) => setTimeout(resolve, 250));
remoteTree = render(SidebarTab, { sessionId: "selftest", inputActions: null });

const remoteRow = await findDshRow();
assert.ok(remoteRow.button !== undefined, "the DSH row must still offer an open control on a remote environment");
const remoteToast = await clickAndRead(remoteRow.button);
assert.ok(
  !remoteToast.includes("failed"),
  `a remote environment must NOT take the local DSH shortcut: ${JSON.stringify(remoteToast)}`,
);
assert.ok(
  remoteToast.includes("openNone"),
  `it must ask the Host instead, which is what knows the machine: ${JSON.stringify(remoteToast)}`,
);
answerAsRemote = false;
console.log("remote: a DSH session is not opened in the local DSH");

/* ------------------------------------------------------------------ *
 * A remote session is typed into this window's own terminal
 * ------------------------------------------------------------------ */

/**
 * The one-click path for another machine: the Host hands back the command (it
 * cannot type into a browser tab) and the client puts it into the Sidebar's
 * built-in terminal — the tab the person already has, rather than a new cmux
 * workspace or a Terminal.app window.
 *
 * The timing here is the part that cannot be reasoned about from the source:
 * `view.write()` is a SILENT no-op until the terminal is mounted and writable,
 * so the client polls, and a test that skipped the poll would pass while the
 * real thing did nothing.
 */
answerOpenAsCommand = `ssh -t 'pro14uu' 'exec "$SHELL" -lic "exec claude --resume abc"'`;
const terminalRow = await findDshRow();
assert.ok(terminalRow.button !== undefined, "the DSH row must still offer an open control");
terminalRow.button.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 400));

assert.equal(terminalCalls.opened.length, 1, "a terminal tab must be asked for exactly once");
assert.equal(terminalCalls.opened[0].kind, "terminal", "and it must be the built-in terminal kind");
assert.equal(terminalCalls.written.length, 1, "the command must be typed, not just copied");
assert.equal(terminalCalls.written[0], `${answerOpenAsCommand}\n`, "with a newline, so the shell runs it");
answerOpenAsCommand = null;
console.log("terminal: a remote open is typed into this window's terminal tab");

/* ------------------------------------------------------------------ *
 * The machine manager
 * ------------------------------------------------------------------ */

/**
 * The list is answered by the real Host, which reads this machine's actual
 * `~/.ssh/config` — so the assertion is that whatever aliases that file holds
 * are *offered*, not a fixed set. Row provenance is asserted too: an alias a
 * file owns is not removable from here, and a manager that did not say so would
 * look broken when "forget" did nothing.
 */
const managerEntry = flatten(render(SidebarTab, { sessionId: "selftest", inputActions: null }).tree).find(
  (node) => node.type === "button" && textOf(node) === "hostsMode",
);
assert.ok(managerEntry !== undefined, "the panel must offer a way into the machine manager");
managerEntry.props.onClick();

const manager = render(Hosts, {});
assert.ok(
  flatten(manager.tree).some((node) => node.type === "button" && node.props?.title === "close"),
  "the manager must render when opened",
);
for (const effect of manager.effects) {
  const cleanup = effect();
  if (typeof cleanup === "function") cleanups.push(cleanup);
}

let managerFilled = manager;
for (let attempt = 0; attempt < 8; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  managerFilled = render(Hosts, {});
  for (const effect of managerFilled.effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  if (hostElements(managerFilled.tree, "sh-hosts-row").length > 0) break;
}

const hostRows = hostElements(managerFilled.tree, "sh-hosts-row");
assert.ok(hostRows.length > 0, "the manager must list machines");
const hostText = hostRows.map(textOf).join(" | ");
const sshText = await readFile(join(homedir(), ".ssh", "config"), "utf8").catch(() => "");
const declared = parseSshConfig(sshText);
for (const host of declared) {
  assert.ok(hostText.includes(host.alias), `an alias ssh already knows must be listed: ${host.alias}`);
}
assert.ok(
  // The harness's `t` returns the key, so this is the locale key that must be
  // on the row — which is the point: a row that did not name its source would
  // make "forget" look broken on an alias a file owns.
  declared.length === 0 || hostText.includes("hostsSourceSsh"),
  "and each row must say which file it came from",
);

// The add form is how the first machine gets added at all.
const addButton = flatten(managerFilled.tree).find((node) => node.type === "button" && textOf(node) === "hostsAdd");
assert.ok(addButton !== undefined, "the manager must offer a way to add a machine");
addButton.props.onClick();
const adding = render(Hosts, {});
assert.ok(
  flatten(adding.tree).some((node) => node.type === "input" && node.props?.placeholder === "hostsAlias"),
  "opening the add form must ask for an ssh alias",
);
console.log(`hosts: ${hostRows.length} machines listed, ${declared.length} from ~/.ssh/config`);

for (const cleanup of cleanups) cleanup();
globalThis.fetch = realFetch;
console.log("\nrender test: all assertions passed");
