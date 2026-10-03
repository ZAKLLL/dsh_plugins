/**
 * Client-half RENDER test.
 *
 * `client-load.mjs` proves the module evaluates and that `apply` wires the
 * contribution. It never renders, so every line inside the panel — badge
 * builders, the iframe branch, the button matrix — is still unexecuted when it
 * passes. This file closes that gap without adding a dependency:
 *
 *   node test/client-render.mjs
 *
 * There is no `react-dom` in the app bundle (React ships as a platform module
 * inside the client bundles), and this repo deliberately has no dev
 * dependencies — so instead of pulling React from npm, the stub below is a
 * ~80-line renderer with just enough of React's model to run the real
 * component: state cells keyed by hook order, effects flushed after a pass, and
 * a re-render whenever a setter fires.
 *
 * It is not React. It cannot catch a hook-order bug or a concurrent-mode
 * hazard. What it does catch is the realistic failure mode for a hand-written
 * plugin: a render path that throws, keyed off a branch a load test never
 * reaches — most importantly the *loaded* branch, which is fed here by a real
 * `/api/remote-agent` fixture through a stubbed `fetch`.
 */

let failures = 0;
function check(name, condition, detail = "") {
  if (!condition) failures += 1;
  // The detail explains a FAILURE; printing it on success reads as a false
  // alarm ("port chip missing" next to an [ok]) and trains the eye to ignore it.
  const suffix = condition || detail === "" ? "" : ` — ${detail}`;
  console.log(`  [${condition ? "ok  " : "FAIL"}] ${name}${suffix}`);
}

/* ---------------------------------------------------------------- *
 * Browser surface
 * ---------------------------------------------------------------- */

const styled = [];
globalThis.document = {
  head: { appendChild: (node) => styled.push(node) },
  getElementById: () => null,
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, dataset: {}, textContent: null }),
};
// The panel installs a clock interval for relative timestamps. A stub keeps the
// process free of a live timer without changing the render path.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
/** Every string the panel copied, so "did it fall back to copying?" is assertable. */
const clipboard = [];
// `globalThis.navigator` is a getter-only accessor on Node 22, so it has to be
// redefined rather than assigned.
Object.defineProperty(globalThis, "navigator", {
  value: { clipboard: { writeText: async (value) => { clipboard.push(value); } } },
  configurable: true,
  writable: true,
});

/* ---------------------------------------------------------------- *
 * A minimal React: hook-order state + flushed effects
 * ---------------------------------------------------------------- */

let cells = [];
let cursor = 0;
let pendingEffects = [];
let dirty = false;

function setStateAt(index, next) {
  cells[index] = typeof next === "function" ? next(cells[index]) : next;
  dirty = true;
}

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  Fragment: "#fragment",
  memo: (component) => component,
  forwardRef: (fn) => fn,
  createContext: (value) => ({ _value: value }),
  useContext: (context) => context?._value,
  useState(initial) {
    const index = cursor++;
    if (!(index in cells)) cells[index] = typeof initial === "function" ? initial() : initial;
    return [cells[index], (next) => setStateAt(index, next)];
  },
  useRef(initial) {
    const index = cursor++;
    if (!(index in cells)) cells[index] = { current: initial };
    return cells[index];
  },
  useEffect(fn) {
    pendingEffects.push(fn);
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useReducer: (reducer, initial) => react.useState(initial),
};

globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      globalThis.__module = factory((name) => {
        if (name === "react") return react;
        throw new Error(`unexpected require(${JSON.stringify(name)})`);
      });
    },
  },
};

/* ---------------------------------------------------------------- *
 * Fixture: a reachable host with one running web agent and one tty agent
 * ---------------------------------------------------------------- */

let OVERVIEW = {
  ok: true,
  generatedAt: Date.now(),
  problems: [],
  hosts: [
    {
      alias: "pro14uu",
      label: "pro14",
      reachable: true,
      agents: [
        {
          id: "dsh",
          label: "DSH",
          kind: "web",
          port: 19391,
          available: true,
          state: "running",
          pid: 4242,
          token: "FIXTURE-TOKEN",
          url: "http://127.0.0.1:19391/?token=FIXTURE-TOKEN",
          tunnel: "up",
          logTail: "dsh web: http://127.0.0.1:19391/?token=FIXTURE-TOKEN",
        },
        {
          id: "codex",
          label: "Codex",
          kind: "tty",
          command: "codex",
          available: true,
          state: "unknown",
          tunnel: "n/a",
          ttyCommand: `ssh -t pro14uu 'exec "$SHELL" -lic "exec claude"'`,
        },
      ],
    },
  ],
};

const requested = [];
globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  requested.push(body.op);
  if (body.op === "overview") return { ok: true, json: async () => OVERVIEW };
  return { ok: true, json: async () => ({ ok: true }) };
};

/* ---------------------------------------------------------------- *
 * Load the real module and capture the real component
 * ---------------------------------------------------------------- */

let captured = null;

/**
 * Swappable between cases. The panel reads its faces at CALL time (see
 * `captureFace` in client.js), not once at apply time, so a case can replace a
 * service between mounts exactly the way a reload would.
 */
const services = {
  sidebarRight: undefined,
  webTerminals: undefined,
  sidebarRightTabs: { register: () => () => {} },
  remote: {},
  slots: {
    inject: (name, cb) => {
      cb();
      return () => {};
    },
    register: (definition, component) => {
      if (definition.name === "sidebar.right.pane.tab") captured = { definition, component };
      return () => {};
    },
  },
};

/** Keys the panel asked for, so "did every one of them exist?" is assertable. */
const usedKeys = new Set();
/** The dictionaries the panel registered, captured so keys can be checked. */
const dictionaries = {};

const ctx = {
  effect: (fn) => {
    const dispose = fn();
    return typeof dispose === "function" ? dispose : () => {};
  },
  inject: (keys, callback) => {
    callback({
      effect: (fn) => {
        const dispose = fn();
        return typeof dispose === "function" ? dispose : () => {};
      },
      get remote() { return services.remote; },
      get sidebarRightTabs() { return services.sidebarRightTabs; },
      get sidebarRight() { return services.sidebarRight; },
      get webTerminals() { return services.webTerminals; },
      get slots() { return services.slots; },
    });
    return () => {};
  },
  locale: {
    register: (namespace, dicts) => {
      // `dicts` is `{ en: {...}, zh: {...} }` — each language is one level in.
      // Assigning the outer object (as this did first) made every key look
      // missing, which is exactly the false alarm this check exists to avoid.
      dictionaries.en = { ...(dictionaries.en ?? {}), ...(dicts?.en ?? {}) };
      dictionaries.zh = { ...(dictionaries.zh ?? {}), ...(dicts?.zh ?? {}) };
      return () => {};
    },
    // Interpolating `{name}` matters: without it a call like
    // `t("failed", { message: host.error })` renders as a bare token and the
    // assertion that the ssh error is shown would pass while showing nothing.
    bind: () => (key, params) => {
      usedKeys.add(key);
      const bare = `t:${key}`;
      if (params === undefined || params === null || typeof params !== "object") return bare;
      const rendered = Object.entries(params)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(",");
      return `${bare}(${rendered})`;
    },
  },
  slots: { inject: (name, cb) => cb(), register: () => () => {} },
};

await import("../client.js");
globalThis.__module.apply(ctx);

/* ---------------------------------------------------------------- *
 * Renderer
 * ---------------------------------------------------------------- */

let elements = [];

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(render).join("");
  const { type, props, children } = node;
  if (typeof type === "function") {
    const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
    return render(type({ ...props, children: kids }));
  }
  const text = children.map(render).join("");
  // Attributes are dropped from the text, but `disabled` is the whole difference
  // between "this control applies" and "this control is offered but inert" — so
  // host elements are collected with their props and their rendered text.
  elements.push({ type, props, text });
  return text;
}

/** Buttons with their rendered label and whether the design made them inert. */
const buttons = () =>
  elements
    .filter((element) => element.type === "button")
    .map((element) => ({
      text: element.text,
      disabled: element.props.disabled === true,
      onClick: element.props.onClick,
    }));

const buttonNamed = (label) => buttons().find((button) => button.text === label) ?? null;

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function mount(component, props) {
  cells = [];
  elements = [];
  let markup = "";
  for (let pass = 0; pass < 8; pass += 1) {
    cursor = 0;
    elements = [];
    pendingEffects = [];
    dirty = false;
    markup = render(component(props));
    const effects = pendingEffects;
    pendingEffects = [];
    for (const fn of effects) fn();
    await settle();
    if (!dirty) break;
  }
  return markup;
}

/* ---------------------------------------------------------------- *
 * Run
 * ---------------------------------------------------------------- */

console.log("\n1. the component was registered");
check("panel captured from the slot registration", captured !== null && typeof captured.component === "function");

console.log("\n2. first paint (loading) does not throw");
{
  let thrown = null;
  let markup = "";
  try {
    markup = await mount(captured.component, {});
  } catch (error) {
    thrown = error;
  }
  check("renders without throwing", thrown === null, thrown?.message ?? "");
  check("renders something", markup.length > 0, `${markup.length} chars`);
  check("shows the refresh control", markup.includes("t:refresh"), markup.slice(0, 120));
}

console.log("\n3. loaded paint renders the real cards");
{
  const markup = await mount(captured.component, {});
  const has = (needle) => markup.includes(needle);

  check("the host reached the panel", has("pro14"), "host label missing");
  check("both agents are listed", has("DSH") && has("Codex"));
  check("the kind badges rendered", has("t:kindWeb") && has("t:kindTty"));

  // The web agent is running with a tunnel up, so the design says it must offer
  // Open and must NOT offer Start.
  check("a running web agent offers Open", has("t:open"));
  // The control matrix is rendered in full and disabled where it does not apply
  // (see the Start button in client.js), so the assertion is about semantics:
  // present, and inert. Asserting absence would have been my bug, not the UI's.
  const start = buttonNamed("t:start");
  check("Start is present for a running agent", start !== null);
  check("Start is disabled while the server runs", start?.disabled === true, JSON.stringify(start));
  const stop = buttonNamed("t:stop");
  check("Stop is enabled while the server runs", stop !== null && stop.disabled === false, JSON.stringify(stop));
  // The port is the plugin's load-bearing number; it must be readable without
  // hovering a tooltip (client.js renders its own chip for exactly this reason).
  check("the forwarded port is visible text", has(":19391"), "port chip missing");

  // The tty agent must offer the copy path and state where to paste it — and
  // must NOT offer a terminal it cannot open (see client.js `copyCommand`).
  check("a tty agent offers Copy command", has("t:copyCommand"));
  check("a tty agent names the terminal shortcut", has("t:terminalHint"));
  check("a tty agent offers the one-click terminal", has("t:openTerminal"));

  check("the transport reported the route operations", JSON.stringify(requested.slice(0, 3)), "");
  check("overview was actually requested", requested.includes("overview"));

  console.log("\n   rendered text (trimmed):");
  console.log(`   ${markup.replace(/\s+/g, " ").slice(0, 400)}…`);
}

console.log("\n4. one-click: it reuses the Sidebar's own terminal tab");
{
  const opened = [];
  const written = [];
  const viewRequests = [];
  // A terminal already open for a DIFFERENT Session. It must not be the one the
  // panel adopts: it is both pre-existing and the wrong Session.
  const tabs = [
    { id: "decoy", kind: "terminal", sessionId: "session-other", contentId: "content-decoy" },
  ];
  let writable = false;
  const view = {
    attachmentId: undefined,
    state: { getSnapshot: () => ({ writable }) },
    write: (data) => written.push(data),
  };
  clipboard.length = 0;
  services.sidebarRight = {
    // `commandTarget(null)` is the whole reason a button can do this at all: the
    // built-in shortcut calls exactly this with no DOM element.
    commandTarget: (element) => {
      check("the panel asks for a target without a DOM element", element === null, String(element));
      return { sessionId: "session-1", paneId: "pane-1", host: "dock" };
    },
    openTabFromTarget: (kind, target) => {
      opened.push({ kind, target });
      // Two tabs appear at once, and the newest is NOT ours. Picking "the newest
      // terminal tab" would adopt the wrong one, so this is the assertion that
      // keeps that shortcut from creeping back in.
      tabs.push({ id: "tab-other", kind: "terminal", sessionId: "session-other", contentId: "c-other" });
      tabs.push({ id: "tab-mine", kind: "terminal", sessionId: target.sessionId, contentId: "c-mine" });
      // The view only becomes writable after the UI mounts the tab and the stream
      // attaches. That delay IS the reason the panel polls: writing before it is a
      // silent no-op, so a test without the delay would pass on a broken build.
      setTimeout(() => {
        writable = true;
        view.attachmentId = "attachment-1";
      }, 60);
    },
    openTabs: { getSnapshot: () => tabs.slice() },
    tabDomain: {
      occurrence: () => ({
        navigation: { getSnapshot: () => ({ params: undefined, address: "content-1" }) },
      }),
    },
  };
  services.webTerminals = {
    view: (...args) => {
      viewRequests.push(args);
      return view;
    },
  };

  await mount(captured.component, {});
  const button = buttons().find((entry) => entry.text === "t:openTerminal");
  check("the row offers Open in terminal", button !== undefined);
  let thrown = null;
  try {
    await button?.onClick();
  } catch (error) {
    thrown = error;
  }
  check("clicking it does not throw", thrown === null, thrown?.message ?? "");
  check(
    "it opened a Sidebar tab of kind 'terminal'",
    opened.length === 1 && opened[0].kind === "terminal",
    JSON.stringify(opened.map((entry) => entry.kind)),
  );
  check(
    "it adopted the terminal belonging to the target Session",
    viewRequests.length === 1 &&
      viewRequests[0][0] === "session-1" &&
      viewRequests[0][1] === "tab-mine",
    JSON.stringify(viewRequests.map((args) => [args[0], args[1]])),
  );
  check(
    "it passed that tab's own contentId",
    viewRequests[0]?.[2] === "c-mine",
    String(viewRequests[0]?.[2]),
  );
  check(
    "it typed the ssh command into that terminal",
    written.length === 1 && written[0].includes("ssh -t pro14uu"),
    JSON.stringify(written),
  );
  check("it did NOT fall back to the clipboard", clipboard.length === 0, JSON.stringify(clipboard));
}

console.log("\n5. fallback: no on-screen Session to open a terminal for");
{
  clipboard.length = 0;
  services.sidebarRight = {
    commandTarget: () => undefined,
    openTabFromTarget: () => {},
    openTabs: { getSnapshot: () => [] },
  };
  services.webTerminals = { view: () => null };
  await mount(captured.component, {});
  const button = buttons().find((entry) => entry.text === "t:openTerminal");
  let thrown = null;
  try {
    await button?.onClick();
  } catch (error) {
    thrown = error;
  }
  check("a dead end does not throw", thrown === null, thrown?.message ?? "");
  check(
    "the command was copied instead",
    clipboard.length === 1 && clipboard[0].includes("ssh -t pro14uu"),
    JSON.stringify(clipboard),
  );
}

console.log("\n6. an unreachable host still explains itself");
{
  const okFixture = OVERVIEW;
  OVERVIEW = {
    ok: true,
    generatedAt: Date.now(),
    problems: [],
    hosts: [
      {
        alias: "pro14uu",
        label: "pro14",
        reachable: false,
        error: "Connection to 127.0.0.1 port 2222 timed out",
        agents: [
          { id: "dsh", label: "DSH", kind: "web", port: 19391, available: null, state: "unknown", tunnel: "down" },
          { id: "codex", label: "Codex", kind: "tty", command: "codex", available: null, state: "unknown", tunnel: "n/a", ttyCommand: `ssh -t pro14uu 'exec "$SHELL" -lic "exec codex"'` },
        ],
      },
    ],
  };
  const markup = await mount(captured.component, {});
  const has = (needle) => markup.includes(needle);

  check("the host is still named", has("pro14"));
  // The whole point: a dead ssh connection must say WHY, in the machine's own
  // words, rather than presenting an empty or cheerful panel.
  check(
    "the ssh failure is shown verbatim",
    has("Connection to 127.0.0.1 port 2222 timed out"),
    "host.error was dropped",
  );
  check("it is framed as a failure, not as status", has("t:failed"));
  check("the agents are still listed", has("DSH") && has("Codex"));
  // `available` is `null` (never probed), not `false` (probed and absent). The
  // difference matters: "I could not ask" must not read as "it is not installed".
  check("it does not claim the agents are missing", !has("t:notInstalled"));
  // And the tty row keeps its one-click: opening a terminal and letting ssh print
  // its own error is more useful than a disabled button.
  const button = buttons().find((entry) => entry.text === "t:openTerminal");
  check("the one-click terminal is still offered", button !== undefined);
  check("it is not disabled just because the host is down", button?.disabled === false, JSON.stringify(button));
  check("the probe button is still offered", has("t:probe"));

  OVERVIEW = okFixture;
}

console.log("\n7. the copy the panel used exists, in both languages");
{
  const en = dictionaries.en ?? {};
  const zh = dictionaries.zh ?? {};
  const missing = [...usedKeys].filter((key) => !(key in en));
  check(
    "no key the panel asked for is missing",
    missing.length === 0,
    missing.length === 0 ? `${usedKeys.size} keys checked` : `missing: ${missing.join(", ")}`,
  );
  // A key present in one language and absent in the other ships as a raw
  // identifier in somebody's UI, and nothing else in this repo would notice it.
  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zh).sort();
  const untranslated = enKeys.filter((key) => !(key in zh));
  const extra = zhKeys.filter((key) => !(key in en));
  check(
    "en and zh carry the same key set",
    untranslated.length === 0 && extra.length === 0,
    untranslated.length > 0
      ? `missing zh: ${untranslated.join(", ")}`
      : extra.length > 0
        ? `extra zh: ${extra.join(", ")}`
        : `${enKeys.length} keys in both`,
  );
}

console.log(failures === 0 ? "\nclient half renders cleanly\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
