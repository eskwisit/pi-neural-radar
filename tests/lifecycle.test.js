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
 * A host with `sessions`; `running` decides agent/getStatus, `messages` session/get and `usage`
 * stats/getTokenUsageHistory (its argument is the request input).
 */
function host({ sessions, running = () => false, messages = () => [], plans = [], usage = () => ({ turns: [] }) }) {
  return (req) => {
    const [arg] = req.args;
    switch (req.operation) {
      case "session/list": return { sessions };
      case "plans/pending": return { plans };
      case "agent/getStatus": return { status: { isRunning: running(arg) } };
      case "session/get": return { messages: messages(arg.id) };
      case "stats/getTokenUsageHistory": return usage(arg);
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

  it("only reads: a poll sends no acting operation", async () => {
    const now = Date.now();
    const { pi, t } = fresh({
      respond: host({ sessions: [{ id: "s1", updatedAt: now }], running: () => true, messages: () => [user("go"), assistant("Should I?")] }),
    });
    await t.poll();
    await t.poll();
    const reads = new Set(["session/list", "plans/pending", "agent/getStatus", "session/get", "stats/getTokenUsageHistory"]);
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

  it("counts a session's tokens from its completed turns, not from the session list", async () => {
    const now = Date.now();
    const sessions = [{ id: "s1", updatedAt: now, totalTokens: 999 }, { id: "s2", updatedAt: now - 1 }];
    const usage = (input) => input.sessionId === "s1"
      ? { turns: [
          { sessionId: "s1", endedAt: now - 5000, totalTokens: 1000 },
          // no total: input + output + cache read + cache write
          { sessionId: "s1", endedAt: now - 4000, inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 4000 },
        ] }
      : { turns: [] };
    const { pi, t } = fresh({ respond: host({ sessions, usage, messages: () => [user("go"), assistant("done?")] }) });
    await t.poll();
    const tokens = Object.fromEntries(t.model.agents.map((a) => [a.id, a.tokens]));
    assert.deepEqual(tokens, { s1: 5330, s2: 0 });
    const req = pi.invocations.find((r) => r.operation === "stats/getTokenUsageHistory" && r.args[0].sessionId === "s1").args[0];
    assert.equal(req.limit, 500);
    assert.ok(req.toMs - req.fromMs <= 365 * 24 * 3600e3, "the host rejects windows over 365 days");
    assert.ok(!pi.invocations.some((r) => r.confirm));
  });

  it("adds the open turn's transcript usage, subagents included, to the completed turns", async () => {
    const now = Date.now();
    const usage = () => ({ turns: [{ sessionId: "s1", endedAt: now - 60e3, totalTokens: 1000 }] });
    const messages = () => [
      // part of the completed turn: already counted by the history
      assistant("earlier", { createdAt: now - 70e3, usage: { totalTokens: 400 } }),
      user("go", { createdAt: now - 30e3 }),
      assistant("on it", { createdAt: now - 20e3, usage: { totalTokens: 50 } }),
      { role: "tool", toolName: "Task", toolCallId: "c1", toolArgs: { agent: "explorer", description: "map" }, toolResult: { details: { delegationId: "d1", agent: "explorer", status: "running" } }, toolCompletedAt: now - 19e3, createdAt: now - 19e3 },
      assistant("found it", { createdAt: now - 10e3, parentToolCallId: "c1", agentName: "explorer", usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 8 } }),
    ];
    const { t } = fresh({ respond: host({ sessions: [{ id: "s1", updatedAt: now }], running: () => true, usage, messages }) });
    await t.poll();
    const [agent] = t.model.agents;
    assert.equal(agent.tokens, 1000 + 50 + 120);
    assert.deepEqual(agent.subs.map((s) => [s.id, s.tokens]), [["d1", 120]]);
  });

  it("follows the history's cursor and reads it once while the agent runs", async () => {
    const now = Date.now();
    const usage = (input) => input.cursor === "p2"
      ? { turns: [{ sessionId: "s1", endedAt: now - 1000, totalTokens: 2 }] }
      : { turns: [{ sessionId: "s1", endedAt: now - 2000, totalTokens: 1 }], nextCursor: "p2" };
    const { pi, t } = fresh({ respond: host({ sessions: [{ id: "s1", updatedAt: now }], running: () => true, usage }) });
    await t.poll();
    await t.poll();
    assert.equal(t.model.agents[0].tokens, 3);
    assert.equal(pi.invocations.filter((r) => r.operation === "stats/getTokenUsageHistory").length, 2);
  });

  it("falls back to the transcript when the usage history cannot be read", async () => {
    const now = Date.now();
    const usage = () => { throw permissionError(); };
    const messages = () => [user("go"), assistant("done?", { createdAt: now, usage: { totalTokens: 42 } })];
    const { t } = fresh({ respond: host({ sessions: [{ id: "s1", updatedAt: now }], usage, messages }) });
    await t.poll();
    assert.equal(t.model.agents[0].tokens, 42);
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
