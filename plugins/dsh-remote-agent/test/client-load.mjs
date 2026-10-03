/**
 * Client-half load test.
 *
 * The browser artifact never sees a bundler here: `client.js` is served raw and
 * registers itself through `window.__ModuleLoader__`. That means a typo, an
 * undefined helper, or an `apply` that touches a service the Context does not
 * have fails **in the browser**, on the user's screen, with nothing in any log
 * this side can read.
 *
 * So this test supplies the smallest loader, React and Context the module
 * actually touches, then runs the factory and `apply` for real:
 *
 *   node test/client-load.mjs
 *
 * It does not render, so component bodies only run as far as `apply` goes. What
 * it does prove is that the module evaluates, that the factory returns the
 * shape the loader expects (`{ name, inject, apply }`), that `apply` registers
 * the locale dictionary and the Sidebar tab, that it asks only for the services
 * it actually needs, and that it does not reach for a terminal namespace it
 * could not use anyway.
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
const fakeDocument = {
  head: { appendChild: (node) => styled.push(node) },
  getElementById: () => null,
  // `installStyles` looks for its own tag before adding one, and writes through
  // `dataset`, so the stub has to offer both or it fails a healthy plugin.
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, dataset: {}, textContent: null }),
};
globalThis.document = fakeDocument;

/** Only `createElement` and the hook identities are needed to reach `apply`. */
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol("Fragment"),
  memo: (component) => component,
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useReducer: (reducer, initial) => [initial, () => {}],
  createContext: (value) => ({ Provider: null, _value: value }),
  useContext: (context) => context?._value,
  forwardRef: (fn) => fn,
};

const modulesRequested = [];
let registered = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      const module = factory((name) => {
        modulesRequested.push(name);
        if (name === "react") return react;
        throw new Error(`unexpected require(${JSON.stringify(name)})`);
      });
      registered = { id, module };
    },
  },
};

/* ---------------------------------------------------------------- *
 * Context surface
 * ---------------------------------------------------------------- */

const localeRegistrations = [];
const slotRegistrations = [];
const tabRegistrations = [];
const injectedKeys = [];

function scopedFor(key) {
  return {
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    remote: { terminal: { create: () => {}, write: () => {} } },
    "remote.terminal": { create: () => {}, write: () => {} },
    sidebarRightTabs: {
      register: (definition) => {
        tabRegistrations.push(definition);
        return () => {};
      },
    },
    slots: {
      inject: (slotName, callback) => {
        callback();
        return () => {};
      },
      register: (definition) => {
        // Record the scope, never overwrite the plugin's own `key`: the plugin
        // passes `key: TAB_ID` and that is precisely what the assertion checks.
        slotRegistrations.push({ ...definition, scope: key });
        return () => {};
      },
    },
  };
}

const ctx = {
  effect: (fn) => {
    const dispose = fn();
    return typeof dispose === "function" ? dispose : () => {};
  },
  inject: (keys, callback) => {
    injectedKeys.push(keys.join("+"));
    callback(scopedFor(keys.join("+")));
    return () => {};
  },
  locale: {
    register: (namespace, dictionaries) => {
      localeRegistrations.push({ namespace, languages: Object.keys(dictionaries) });
      return () => {};
    },
    bind: () => (key) => `t:${key}`,
  },
  slots: {
    inject: (slotName, callback) => {
      callback();
      return () => {};
    },
    register: (definition) => {
      slotRegistrations.push(definition);
      return () => {};
    },
  },
};

/* ---------------------------------------------------------------- *
 * Run
 * ---------------------------------------------------------------- */

console.log("\n1. module registers with the browser module table");
await import("../client.js");
check("exactly one load() call", registered !== null, "the module never called window.__ModuleLoader__.load");
check("registered under the package name", registered?.id === "dsh-remote-agent", String(registered?.id));
check(
  "only baseline modules were required",
  modulesRequested.every((name) => name === "react"),
  modulesRequested.join(", "),
);

const plugin = registered?.module;
check("factory returned an object", plugin !== null && typeof plugin === "object");
check("declares its name", plugin?.name === "dsh-remote-agent", String(plugin?.name));
check(
  "declares slots + locale",
  Array.isArray(plugin?.inject) && plugin.inject.includes("slots") && plugin.inject.includes("locale"),
  (plugin?.inject ?? []).join(", "),
);
check("exports apply", typeof plugin?.apply === "function");

console.log("\n2. apply() wires the contribution");
let thrown = null;
try {
  plugin.apply(ctx);
} catch (error) {
  thrown = error;
}
check("apply does not throw", thrown === null, thrown?.message ?? "");

check(
  "registers the locale dictionary in both languages",
  localeRegistrations.some((r) => r.namespace === "dsh-remote-agent" && r.languages.length === 2),
  JSON.stringify(localeRegistrations),
);
check(
  "asks only for services it can use without them",
  injectedKeys.length > 0 &&
    injectedKeys.every((key) =>
      ["sidebarRightTabs", "sidebarRight", "webTerminals"].includes(key),
    ) &&
    injectedKeys.includes("sidebarRightTabs"),
  injectedKeys.join(", "),
);
// The terminal is a builtin Sidebar tab type whose lifecycle belongs to the
// terminal UI (see `copyCommand` in client.js): a third-party plugin cannot
// obtain a visible terminal or write into one, so reaching for
// `remote.terminal` would be a button that only reports its own failure.
check(
  "reaches the terminal through the services a plugin is given, not the Remote namespace",
  injectedKeys.includes("webTerminals") && injectedKeys.includes("sidebarRight"),
  injectedKeys.join(", "),
);
check(
  "registers the right-Sidebar tab type",
  tabRegistrations.some((t) => t.id === "remote-agent" && t.kind === "remote-agent"),
  JSON.stringify(tabRegistrations.map((t) => t.id)),
);
check(
  "registers a tab body and a tab title under that key",
  slotRegistrations.some((s) => s.name === "sidebar.right.pane.tab" && s.key === "remote-agent")
    && slotRegistrations.some((s) => s.name === "sidebar.right.pane.tab.title" && s.key === "remote-agent"),
  slotRegistrations.map((s) => s.name).join(", "),
);
check("injects its stylesheet", styled.length >= 1, `${styled.length} node(s)`);

console.log(failures === 0 ? "\nclient half loads cleanly\n" : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
