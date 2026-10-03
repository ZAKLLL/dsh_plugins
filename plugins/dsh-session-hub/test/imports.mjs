/**
 * Static import check.
 *
 * The plugin README has claimed since the adapter refactor that "a static check
 * compares the names a module uses against its import list". It did not exist —
 * so this is it, and it checks both directions, because both have already cost
 * real time here:
 *
 *   **used but not imported.** `sources/codex.js` called `readFileSync` without
 *   importing it. Its own `try/catch` swallowed the `ReferenceError`, so the
 *   only symptom was every Codex title quietly falling back to `(untitled)`.
 *   Nothing else can see this: the module still parses, and the failure is
 *   inside a branch.
 *
 *   **imported but unused.** The same wound from the other side. Three adapters
 *   still imported all of `node:fs/promises` after their reads moved into the
 *   engine — and an adapter that *looks* like it may touch the filesystem is
 *   exactly where the two remote-mode bugs hid (one read the local disk while
 *   the panel was pointed at another machine).
 *
 * Only the Host half is checked. `client.js` runs in the browser, where the
 * global set is different and unknown names are legitimately provided by the
 * module loader.
 *
 *   node test/imports.mjs
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/**
 * Names that need no import.
 *
 * Deliberately a short, explicit list rather than "anything capitalised": a
 * check that guesses turns a real finding into a coin flip, and the whole point
 * of this file is to be believed when it fails.
 */
const GLOBALS = new Set([
  // Language and standard library
  "Array", "ArrayBuffer", "BigInt", "Boolean", "Buffer", "Date", "Error", "Infinity", "Intl", "JSON", "Map", "Math",
  "NaN", "Number", "Object", "Promise", "Proxy", "RangeError", "ReferenceError", "RegExp", "Set", "String", "Symbol",
  "SyntaxError", "TypeError", "URIError", "URL", "URLSearchParams", "WeakMap", "WeakSet",
  // Functions
  "clearInterval", "clearTimeout", "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "fetch",
  "isFinite", "isNaN", "parseFloat", "parseInt", "queueMicrotask", "require", "setInterval", "setTimeout",
  "structuredClone",
  // Platform
  "AbortController", "AbortSignal", "FormData", "Headers", "Request", "Response", "TextDecoder", "TextEncoder",
  "console", "globalThis", "process",
]);

/**
 * Strip comments and literals, leaving only code.
 *
 * Not optional: without it, every JSDoc `@property {() => …} readTail` and every
 * `if (` inside a comment reads as a call to an undefined function. A regex
 * literal is skipped too, because `/["']/` otherwise looks like the start of a
 * string and would swallow the rest of the file.
 */
function codeOnly(source) {
  const text = String(source);
  let out = "";
  let at = 0;
  /** Whether a `/` here starts a regex rather than a division. */
  const regexAllowed = () => {
    for (let back = out.length - 1; back >= 0; back -= 1) {
      const ch = out[back];
      if (/\s/.test(ch)) continue;
      return "=(,:[!&|?{};+-*%<>~^".includes(ch);
    }
    return true;
  };
  while (at < text.length) {
    const two = text.slice(at, at + 2);
    if (two === "//") {
      while (at < text.length && text[at] !== "\n") at += 1;
      continue;
    }
    if (two === "/*") {
      at += 2;
      while (at < text.length && text.slice(at, at + 2) !== "*/") at += 1;
      at += 2;
      continue;
    }
    const ch = text[at];
    if (ch === '"' || ch === "'") {
      at += 1;
      while (at < text.length && text[at] !== ch) {
        if (text[at] === "\\") at += 1;
        at += 1;
      }
      at += 1;
      out += " ";
      continue;
    }
    if (ch === "`") {
      // A template's `${…}` is code and must survive: blanking the whole literal
      // reported `shq` as unused in `environments.js`, where every use of it is
      // inside `printf '…' ${shq(x)}`. That false positive removed a needed
      // import, and only the other half of this check (and the suite) caught it.
      at += 1;
      let depth = 0;
      while (at < text.length) {
        const c = text[at];
        if (c === "\\") {
          at += 2;
          continue;
        }
        if (depth === 0 && c === "`") {
          at += 1;
          break;
        }
        if (c === "$" && text[at + 1] === "{") {
          depth += 1;
          at += 2;
          out += " { ";
          continue;
        }
        if (c === "}" && depth > 0) {
          depth -= 1;
          at += 1;
          out += " } ";
          continue;
        }
        if (depth > 0) out += c;
        at += 1;
      }
      out += " ";
      continue;
    }
    if (ch === "/" && regexAllowed()) {
      at += 1;
      let inClass = false;
      while (at < text.length) {
        const c = text[at];
        if (c === "\\") at += 1;
        else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (c === "\n") break;
        at += 1;
      }
      at += 1;
      out += " ";
      continue;
    }
    out += ch;
    at += 1;
  }
  return out;
}

/** Every module the Host half is made of. */
async function hostModules() {
  const files = ["index.js", "shared.js", "store.js", "host.js", "ssh.js", "environments.js", "hook.mjs"];
  const sources = await readdir(join(root, "sources"));
  for (const name of sources) {
    if (name.endsWith(".js")) files.push(join("sources", name));
  }
  return files;
}

/** The bindings a module pulls in, by local name. */
function importsOf(source) {
  const names = new Set();
  const pattern = /^[ \t]*import\s+([\s\S]*?)\s+from\s+["'][^"']+["']\s*;?[ \t]*$/gm;
  for (const match of source.matchAll(pattern)) {
    const clause = match[1];
    const braced = /\{([\s\S]*?)\}/.exec(clause);
    const outside = clause.replace(/\{[\s\S]*?\}/, " ");
    for (const word of outside.split(/[,\s]+/)) {
      if (word === "" || word === "*" || word === "as") continue;
      names.add(word);
    }
    if (braced !== null) {
      for (const part of braced[1].split(",")) {
        const trimmed = part.trim();
        if (trimmed === "") continue;
        names.add(trimmed.split(/\s+as\s+/).pop().trim());
      }
    }
  }
  return names;
}

/** Names the module itself declares or binds. */
function declarationsOf(code) {
  const names = new Set();
  for (const match of code.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  for (const match of code.matchAll(/(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
  for (const match of code.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  for (const match of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/[\s:]/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // Object-literal shorthand methods: `readTail(path) { … }`. They are function
  // definitions, not calls, and reading them as calls is what made the first
  // version of this file useless.
  for (const match of code.matchAll(/(?:^|\n)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/g)) {
    names.add(match[1]);
  }
  // Parameters, so a callback is not reported as missing.
  for (const match of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const token of match[1].split(/[,\s.]+/)) {
      const name = token.replace(/^\.\.\./, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/** Names the module *calls*, which is what a missing import breaks. */
function calledOf(code) {
  const names = new Set();
  for (const match of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) names.add(match[1]);
  for (const keyword of KEYWORDS) names.delete(keyword);
  return names;
}

/** Syntax, not functions. */
const KEYWORDS = new Set([
  "async", "await", "case", "catch", "class", "const", "default", "delete", "do", "else", "export", "extends",
  "finally", "for", "function", "if", "import", "in", "instanceof", "let", "new", "of", "return", "switch", "this",
  "throw", "try", "typeof", "var", "void", "while", "with", "yield",
]);

let checks = 0;
const problems = [];

function check(condition, message) {
  checks += 1;
  if (!condition) problems.push(message);
}

for (const relative of await hostModules()) {
  const source = await readFile(join(root, relative), "utf8");
  const code = codeOnly(source);
  const imported = importsOf(source);
  const declared = declarationsOf(code);

  // One: something is called that nothing here provides.
  const known = new Set([...imported, ...declared, ...GLOBALS]);
  for (const name of calledOf(code)) {
    check(
      known.has(name),
      `${relative}: calls ${name}() but neither imports nor declares it (the codex.js ReferenceError class)`,
    );
  }

  // Two: something is imported and then never mentioned again.
  // Import statements are removed from the *code-only* text, where the lexer has
  // already blanked the quoted module path — matching on quotes here silently
  // matched nothing, which made this half of the check pass on everything.
  const body = code.replace(/^[ \t]*import\s[\s\S]*?;[ \t]*$/gm, "");
  for (const name of imported) {
    const used = new RegExp(`(?<![.\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(body);
    check(used, `${relative}: imports ${name} and never uses it (an adapter that looks like it touches things it does not)`);
  }
}

if (problems.length > 0) {
  console.error(`imports: ${problems.length} problem(s)\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`imports: all ${checks} assertions passed`);
}
