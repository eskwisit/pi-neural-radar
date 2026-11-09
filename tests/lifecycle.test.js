"use strict";

// Polling, bounds, auto-open, host failures on the poll path, and load/unload cleanup.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { loadMain, fakePi, permissionError, user, assistant } = require("./helpers.js");

const loaded = [];
function fresh(options) {
  const pi = fakePi(options);
  const main = loadMain(pi);
  loaded.push(main);
  return { pi, main, t: main.__t };
}
afterEach(async () => {
  while (loaded.length) await loaded.pop().onUnload();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeouts = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;

/**
 * A host with `sessions`; `running` decides agent/getStatus and `messages` session/get.
 */
function host({ sessions, running = () => false, messages = () => [], plans = [] }) {
  return (req) => {
    const [arg] = req.args;
    switch (req.operation) {
      case "session/list": return { sessions };
      case "plans/pending": return { plans };
      case "agent/getStatus": return { status: { isRunning: running(arg) } };
      case "session/get": return { messages: messages(arg.id) };
      default: return {};
    }
  };
}

describe("poll: bounds", () => {
  it("reads at most 8 candidate sessions plus the active one, 60 messages each", async () => {
    const now = Date.now();
    const sessions = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, updatedAt: now - i * 1000 }));
    const { pi, t } = fresh({ respond: host({ sessions }), active: { sessionId: "s11" } });
    await t.poll();
    const status = pi.invocations.filter((r) => r.operation === "agent/getStatus").map((r) => r.args[0]);
    assert.deepEqual(status, ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s11"]);
    const gets = pi.invocations.filter((r) => r.operation === "session/get");
    assert.ok(gets.length <= 9);
    for (const g of gets) assert.equal(g.args[0].messageLimit, 60);
    assert.equal(pi.invocations.filter((r) => r.operation === "plans/pending").length, 1);
  });

  it("skips sessions untouched for more than 6 hours", async () => {
    const now = Date.now();
    const sessions = [{ id: "old", updatedAt: now - 7 * 3600e3 }, { id: "new", updatedAt: now }];
    const { pi, t } = fresh({ respond: host({ sessions }) });
    await t.poll();
    assert.deepEqual(pi.invocations.filter((r) => r.operation === "agent/getStatus").map((r) => r.args[0]), ["new"]);
  });

  it("keeps a new, empty session (\"New task\") off the radar, also when it is the active one", async () => {
    const now = Date.now();
    const sessions = [{ id: "empty", title: "New task", updatedAt: now }, { id: "used", title: "Work", updatedAt: now }];
    const messages = (id) => (id === "used" ? [user("do it", now)] : []);
    const { t } = fresh({ respond: host({ sessions, messages }), active: { sessionId: "empty" } });
    await t.poll();
    assert.deepEqual(t.model.agents.map((a) => a.id), ["used"]);
  });

  it("only reads: a poll sends no acting operation", async () => {
    const now = Date.now();
    const { pi, t } = fresh({
      respond: host({ sessions: [{ id: "s1", updatedAt: now }], running: () => true, messages: () => [user("go"), assistant("Should I?")] }),
    });
    await t.poll();
    await t.poll();
    const reads = new Set(["session/list", "plans/pending", "agent/getStatus", "session/get"]);
    for (const r of pi.invocations) assert.ok(reads.has(r.operation), r.operation);
    assert.ok(pi.invocations.every((r) => !r.confirm));
    assert.deepEqual(pi.suggestions, []);
  });
});

describe("poll: model", () => {
  it("passes transcript text through unchanged (the view escapes it)", async () => {
    const now = Date.now();
    const evil = "<img src=x onerror=alert(1)> Should I?";
    const { t } = fresh({ respond: host({ sessions: [{ id: "s1", updatedAt: now }], messages: () => [user("go"), assistant(evil)] }) });
    await t.poll();
    const [agent] = t.model.agents;
    assert.equal(agent.status, "need");
    assert.equal(agent.reply, evil);
  });

  it("counts a subagent's tokens from its transcript messages only", async () => {
    const now = Date.now();
    const messages = () => [
      user("go", { createdAt: now - 30e3 }),
      assistant("on it", { createdAt: now - 20e3, usage: { totalTokens: 50 } }),
      { role: "tool", toolName: "Task", toolCallId: "c1", toolArgs: { agent: "explorer", description: "map" }, toolResult: { details: { delegationId: "d1", agent: "explorer", status: "running" } }, toolCompletedAt: now - 19e3, createdAt: now - 19e3 },
      assistant("found it", { createdAt: now - 10e3, parentToolCallId: "c1", agentName: "explorer", usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 8 } }),
    ];
    const { t } = fresh({ respond: host({ sessions: [{ id: "s1", updatedAt: now }], running: () => true, messages }) });
    await t.poll();
    const [agent] = t.model.agents;
    assert.deepEqual(agent.subs.map((s) => [s.id, s.tokens]), [["d1", 120]]);
  });

  const launch = (now, id, agent, description) => ({ role: "tool", toolName: "Task", toolCallId: `c-${id}`, toolArgs: { agent, description }, toolResult: { details: { delegationId: id, agent, status: "running" } }, toolCompletedAt: now - 19e3, createdAt: now - 19e3 });

  it("keeps the subagents of a single main agent around the session", async () => {
    const now = Date.now();
    const messages = () => [
      user("fix the bug and document it", { id: "u1", createdAt: now - 30e3 }),
      launch(now, "a1", "fixer", "fix the bug"),
      launch(now, "a2", "writer", "document it"),
    ];
    const { t } = fresh({ respond: host({ sessions: [{ id: "s1", title: "Team", updatedAt: now }], running: () => true, messages }) });
    await t.poll();
    assert.deepEqual(t.model.agents.map((a) => a.id), ["s1"]);
    assert.deepEqual(t.model.agents[0].subs.map((s) => s.id), ["a1", "a2"]);
  });

  it("keeps all subagents of one turn on the session, also with the agent's notes between launches", async () => {
    const now = Date.now();
    const messages = () => [
      user("fix the bug and document it", { id: "u1", createdAt: now - 40e3 }),
      assistant("Two parts. First the fix.", { id: "m1", createdAt: now - 39e3 }),
      launch(now, "a1", "fixer", "fix the bug"),
      launch(now, "a2", "explorer", "find the callers"),
      assistant("Now the docs.", { id: "m2", createdAt: now - 20e3 }),
      launch(now, "b1", "writer", "document it"),
      assistant("patched", { createdAt: now - 10e3, parentToolCallId: "c-a1", agentName: "fixer", usage: { totalTokens: 40 } }),
    ];
    const { t } = fresh({ respond: host({ sessions: [{ id: "s1", title: "Team", updatedAt: now }], running: () => true, messages }) });
    await t.poll();
    assert.deepEqual(t.model.agents.map((a) => a.id), ["s1"]);
    const [s] = t.model.agents;
    assert.deepEqual(s.subs.map((x) => [x.id, x.tokens]), [["a1", 40], ["a2", 0], ["b1", 0]]);
    assert.deepEqual(s.log.filter((l) => l.kind === "say").map((l) => l.text), ["Now the docs.", "Two parts. First the fix."]); // newest first
  });

  // turn 1 launches a1 and leaves it running; turn 2 launches b1
  const twoTurns = (now, first) => {
    let turn = 1;
    const messages = () => [
      user("fix the bug", { id: "u1", createdAt: now - 60e3 }),
      assistant("First the fix.", { id: "m1", createdAt: now - 59e3 }),
      first,
      ...(turn > 1 ? [
        user("and document it", { id: "u2", createdAt: now - 30e3 }),
        assistant("Now the docs.", { id: "m2", createdAt: now - 29e3 }),
        launch(now, "b1", "writer", "document it"),
      ] : []),
    ];
    return { messages, next: () => { turn = 2; } };
  };

  it("gives an earlier turn whose subagents still run its own main-agent cluster", async () => {
    const now = Date.now();
    const { messages, next } = twoTurns(now, launch(now, "a1", "fixer", "fix the bug"));
    const { t } = fresh({ respond: host({ sessions: [{ id: "s1", title: "Team", updatedAt: now }], running: () => true, messages }) });
    await t.poll();
    next();
    await t.poll();
    const byId = new Map(t.model.agents.map((a) => [a.id, a]));
    assert.deepEqual([...byId.keys()], ["s1", "s1::main:u1"]);
    assert.deepEqual(byId.get("s1").subs.map((x) => x.id), ["b1"]);
    const m = byId.get("s1::main:u1");
    assert.deepEqual(m.subs.map((x) => x.id), ["a1"]);
    assert.equal(m.child, true);
    assert.equal(m.parent, "s1");
    assert.equal(m.session, "s1");
    assert.equal(m.status, "run");
    assert.equal(m.task, "fix the bug");
    assert.deepEqual(m.log.filter((l) => l.kind === "say").map((l) => l.text), ["First the fix."]); // chat text only, no Task launch
  });

  it("carries the effort next to the model for the session, its main agents and its subagents", async () => {
    const now = Date.now();
    const first = { ...launch(now, "a1", "fixer", "fix the bug"), toolResult: { details: { delegationId: "a1", agent: "fixer", status: "running", modelId: "claude-opus-5-5", thinkingLevel: "high" } } };
    const { messages, next } = twoTurns(now, first);
    const sessions = [{ id: "s1", title: "Team", updatedAt: now, modelId: "gpt-5", thinkingLevel: "medium" }];
    const { t } = fresh({ respond: host({ sessions, running: () => true, messages }) });
    await t.poll();
    next();
    await t.poll();
    const byId = new Map(t.model.agents.map((a) => [a.id, a]));
    assert.deepEqual([...byId.values()].map((a) => [a.id, a.model, a.effort]), [
      ["s1", "gpt-5", "medium"], ["s1::main:u1", "gpt-5", "medium"],
    ]);
    assert.deepEqual(byId.get("s1::main:u1").subs.map((s) => [s.id, s.model, s.effort]), [["a1", "claude-opus-5-5", "high"]]);
    // a subagent whose launch reported neither keeps them empty
    assert.deepEqual(byId.get("s1").subs.map((s) => [s.id, s.model, s.effort]), [["b1", "", ""]]);
  });

  it("does not open the view on the first poll, then opens it when an agent starts working", async () => {
    const now = Date.now();
    let run = false;
    const { pi, t } = fresh({ respond: host({ sessions: [{ id: "s1", updatedAt: now }], running: () => run }) });
    await t.poll();
    assert.deepEqual(pi.reveals, []);
    run = true;
    await t.poll();
    assert.deepEqual(pi.reveals, [{ viewId: "radar" }]);
  });

  it("never opens the view when the setting is \"off\"", async () => {
    const now = Date.now();
    let run = false;
    const { pi, main, t } = fresh({ respond: host({ sessions: [{ id: "s1", updatedAt: now }], running: () => run }), settings: { autoOpen: "off" } });
    await main.onLoad();
    await t.poll();
    run = true;
    await t.poll();
    assert.deepEqual(pi.reveals, []);
  });
});

describe("poll: host failures", () => {
  it("a failing session/list becomes model.error, not a crash", async () => {
    const { main, t } = fresh({ respond: () => { throw new Error("host unavailable"); } });
    await assert.doesNotReject(t.loop());
    assert.match(t.model.error, /host unavailable/);
    const r = await main.onPanelInvoke("radar.state", {});
    assert.equal(r.ok, true);
    assert.match(r.model.error, /host unavailable/);
  });

  it("a denied desktop.control is surfaced in the model", async () => {
    const { main, t } = fresh({ respond: () => Promise.reject(permissionError()) });
    await t.loop();
    const r = await main.onPanelInvoke("radar.state", {});
    assert.match(r.model.error, /Permission denied: desktop\.control/);
  });

  it("failing per-session reads are skipped and the poll completes", async () => {
    const now = Date.now();
    const { t } = fresh({
      respond: (req) => {
        if (req.operation === "session/list") return { sessions: [{ id: "s1", updatedAt: now }] };
        throw permissionError();
      },
    });
    await assert.doesNotReject(t.loop());
    assert.equal(t.model.error, null);
    assert.equal(t.model.agents.length, 1);
  });

  it("a failing pi.session.getActive / pi.ui.revealView does not break the poll", async () => {
    const now = Date.now();
    let run = false;
    const { pi, t } = fresh({ respond: host({ sessions: [{ id: "s1", updatedAt: now }], running: () => run }) });
    pi.session.getActive = () => Promise.reject(new Error("no window"));
    pi.ui.revealView = () => Promise.reject(permissionError("ui.view"));
    await t.loop();
    run = true;
    await t.loop();
    assert.equal(t.model.error, null);
  });

  it("malformed host answers do not break the poll", async () => {
    for (const answer of [null, undefined, 42, "x", { sessions: "nope" }, { sessions: [null, {}, { id: 7 }] }]) {
      const { t } = fresh({ respond: () => answer });
      await assert.doesNotReject(t.loop(), JSON.stringify(answer));
    }
  });
});

describe("lifecycle", () => {
  it("onLoad registers three events and the command; onUnload removes the same handlers", async () => {
    const { pi, main } = fresh({ respond: host({ sessions: [] }) });
    await main.onLoad();
    assert.deepEqual(pi.on.map(([n]) => n).sort(), ["plugin:settingsChanged", "session:activated", "session:turnEnded"]);
    assert.deepEqual(pi.registered.map((c) => c.id), ["neural-radar.open"]);
    await main.onUnload();
    assert.equal(pi.off.length, pi.on.length);
    for (const [name, fn] of pi.on) assert.ok(pi.off.some(([n, f]) => n === name && f === fn), `${name} not removed`);
    assert.deepEqual(pi.unregistered, ["neural-radar.open"]);
  });

  it("onUnload stops the poll timer", async () => {
    const before = timeouts();
    const { pi, main } = fresh({ respond: host({ sessions: [] }) });
    await main.onLoad(); // schedules the first poll after 800 ms
    assert.ok(timeouts() > before);
    await main.onUnload();
    assert.equal(timeouts(), before);
    await sleep(900);
    assert.deepEqual(pi.invocations, []);
  });

  it("no poll is scheduled after unload, even when a poll was in flight", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const before = timeouts();
    const { main, t } = fresh({ respond: async () => { await gate; return { sessions: [] }; } });
    const running = t.loop();
    await main.onUnload();
    release();
    await running;
    assert.equal(timeouts(), before);
  });

  it("events and actions after unload do not restart polling", async () => {
    const before = timeouts();
    const { pi, main } = fresh({ respond: host({ sessions: [] }) });
    await main.onLoad();
    const turnEnded = pi.on.find(([n]) => n === "session:turnEnded")[1];
    await main.onUnload();
    turnEnded();
    await main.onPanelInvoke("radar.action", { action: "open", sessionId: "s1" });
    assert.equal(timeouts(), before);
    assert.deepEqual(pi.ops(), ["session/open"]);
  });

  it("the command opens the radar view", async () => {
    const { pi, main } = fresh({ respond: host({ sessions: [] }) });
    await main.onLoad();
    await pi.registered[0].run();
    assert.deepEqual(pi.reveals, [{ viewId: "radar" }]);
  });

  it("load survives a failing command registration and settings read", async () => {
    const { pi, main, t } = fresh({ respond: host({ sessions: [] }) });
    pi.commands.register = () => Promise.reject(permissionError("commands"));
    pi.plugin.getSettings = () => Promise.reject(new Error("no settings"));
    await assert.doesNotReject(main.onLoad());
    assert.equal(t.autoOpen, "working");
  });

  it("unload survives a failing command unregistration", async () => {
    const { pi, main } = fresh({ respond: host({ sessions: [] }) });
    await main.onLoad();
    pi.commands.unregister = () => Promise.reject(new Error("gone"));
    await assert.doesNotReject(main.onUnload());
  });

  it("notifies once when an agent starts needing you, with what it asks", async () => {
    const now = Date.now();
    let ask = false;
    const messages = () => (ask ? [user("go"), assistant("Should I delete the old files?")] : [user("go")]);
    const { pi, t } = fresh({ respond: host({ sessions: [{ id: "s1", title: "Cleanup", updatedAt: now }], running: () => !ask, messages }) });
    await t.poll();
    assert.deepEqual(pi.notifications, []);
    ask = true;
    await t.poll();
    await sleep(0);
    // the in-app notice always goes out too: a "shown" system notification can still never appear
    assert.deepEqual(pi.notifications, [
      { kind: "native", title: "Cleanup is waiting for your reply", body: "Should I delete the old files?" },
      { kind: "notice", title: "Cleanup is waiting for your reply", body: "Should I delete the old files?" },
    ]);
    await t.poll(); // still waiting: no second notification
    await sleep(0);
    assert.equal(pi.notifications.length, 2);
  });

  it("falls back to an in-app notice and follows the language and the notify setting", async () => {
    const now = Date.now();
    let ask = false;
    const messages = () => (ask ? [user("go"), assistant("Should I?")] : [user("go")]);
    const settings = { autoOpen: "working", notify: true };
    const { pi, main, t } = fresh({ respond: host({ sessions: [{ id: "s1", title: "", updatedAt: now }], running: () => !ask, messages }), nativeShown: false, locale: "zh-CN", settings });
    await main.onLoad();
    await t.poll();
    ask = true;
    await t.poll();
    await sleep(0);
    assert.deepEqual(pi.notifications, [{ kind: "notice", title: "未命名会话 正在等待你的回复", body: "Should I?" }]);
    // turned off: nothing more, even for a new need
    settings.notify = false;
    pi.on.find(([n]) => n === "plugin:settingsChanged")[1]();
    await sleep(0);
    ask = false;
    await t.poll();
    ask = true;
    await t.poll();
    await sleep(0);
    assert.equal(pi.notifications.length, 1);
  });

  it("still shows the in-app notice when the system notification fails, and logs the attempt", async () => {
    const now = Date.now();
    let ask = false;
    const messages = () => (ask ? [user("go"), assistant("Should I?")] : [user("go")]);
    const { pi, t } = fresh({ respond: host({ sessions: [{ id: "s1", title: "Build", updatedAt: now }], running: () => !ask, messages }) });
    pi.ui.showNativeNotification = () => Promise.reject(Object.assign(new Error("no"), { code: "UNAVAILABLE" }));
    const logged = [];
    const log = console.log;
    console.log = (...a) => { logged.push(a.join(" ")); };
    try {
      await t.poll();
      ask = true;
      await t.poll();
      await sleep(0);
    } finally {
      console.log = log;
    }
    assert.deepEqual(pi.notifications, [{ kind: "notice", title: "Build is waiting for your reply", body: "Should I?" }]);
    assert.deepEqual(logged, ["notify reply for session s1: system failed (UNAVAILABLE), in-app shown"]);
  });

  it("only accepts known autoOpen values and re-reads them when settings change", async () => {
    const settings = { autoOpen: "rm -rf" };
    const { pi, main, t } = fresh({ respond: host({ sessions: [] }), settings });
    await main.onLoad();
    assert.equal(t.autoOpen, "working");
    settings.autoOpen = "attention";
    pi.on.find(([n]) => n === "plugin:settingsChanged")[1]();
    await sleep(0);
    assert.equal(t.autoOpen, "attention");
  });
});
