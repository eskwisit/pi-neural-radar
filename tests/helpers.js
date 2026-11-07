"use strict";

/**
 * Test helpers for Neural Radar. No dependencies: main.js is compiled as a fresh CommonJS module
 * per test with its own fake `pi` global, and a few internal functions are re-exported under
 * `__t` so the logic can be exercised directly.
 */

const fs = require("node:fs");
const path = require("node:path");

const MAIN = path.join(__dirname, "..", "main.js");

// internal names re-exported for the tests; a name that no longer exists comes back undefined
const INTERNALS = [
  "awaitingReply", "pendingQuestionFrom", "askingPart", "activityLog", "mergeSubs", "describeTask", "toolTarget", "toolTokens", "estimateTokens",
  "delegationsFrom", "act", "onPanelInvoke", "onLoad", "onUnload", "poll", "loop", "pollSoon",
];

/** Compile a fresh copy of main.js bound to `pi`. Returns `{ ...exports, __t }`. */
function loadMain(pi) {
  const src = fs.readFileSync(MAIN, "utf8");
  const exportsLine =
    "\nmodule.exports.__t = {" +
    INTERNALS.map((n) => `${n}: typeof ${n} === "undefined" ? undefined : ${n}`).join(", ") +
    ", get model() { return model; }, get autoOpen() { return autoOpen; } };\n";
  // bind `pi` per instance, keeping the "use strict" directive first so strict mode stays on
  const bind = "const pi = module.__pi;";
  const m = new module.constructor(MAIN, module);
  m.filename = MAIN;
  m.paths = module.paths;
  m.__pi = pi;
  const directive = /^\s*(["'])use strict\1;?/;
  const body = directive.test(src) ? src.replace(directive, (d) => `${d} ${bind}`) : `${bind}\n${src}`;
  m._compile(body + exportsLine, MAIN);
  return m.exports;
}

/** A permission error shaped like the host's. */
function permissionError(permission = "desktop.control") {
  const e = new Error(`Permission denied: ${permission}`);
  e.code = "PERMISSION_DENIED";
  return e;
}

/**
 * A fake `pi` with spies. `respond(request)` answers pi.desktop.invoke; it may throw/reject.
 */
function fakePi({ respond = () => ({}), active = null, settings = { autoOpen: "working" }, nativeShown = true, locale = "en" } = {}) {
  const invocations = [];
  const suggestions = [];
  const reveals = [];
  const notifications = []; // { kind: "native" | "notice", title, body }
  const on = [];
  const off = [];
  const registered = [];
  const unregistered = [];
  const pi = {
    invocations, suggestions, reveals, notifications, on, off, registered, unregistered,
    respond,
    desktop: {
      invoke: async (request) => {
        invocations.push(request);
        return pi.respond(request);
      },
    },
    session: { getActive: async () => active },
    composer: { suggest: async (s) => { suggestions.push(s); return { ok: true }; } },
    ui: {
      revealView: async (v) => { reveals.push(v); },
      showNativeNotification: async (n) => { if (nativeShown) notifications.push({ kind: "native", ...n }); return { shown: nativeShown, permission: nativeShown ? "granted" : "denied" }; },
      notify: async (n) => { notifications.push({ kind: "notice", ...n }); },
    },
    app: { getLocale: async () => locale },
    plugin: { getSettings: async () => settings },
    commands: {
      register: async (c) => { registered.push(c); },
      unregister: async (id) => { unregistered.push(id); },
    },
    events: {
      on: (name, fn) => { on.push([name, fn]); },
      off: (name, fn) => { off.push([name, fn]); },
    },
    ops: () => invocations.map((r) => r.operation),
  };
  return pi;
}

const user = (content, extra = {}) => ({ role: "user", content, ...extra });
const assistant = (content, extra = {}) => ({ role: "assistant", content, ...extra });
const tool = (toolName, extra = {}) => ({ role: "tool", toolName, toolArgs: {}, ...extra });

module.exports = { loadMain, fakePi, permissionError, user, assistant, tool };
