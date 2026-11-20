"use strict";

// Question cards and tool permission prompts: read with agent/pendingInteractive (PI-Desktop
// 0.23+), answered from the drawer with agent/askTool/resolve and tool/resolvePermission (both
// "dangerous": sent with confirm), and the transcript fallback on a host without the read.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { loadMain, fakePi, user, assistant, tool } = require("./helpers.js");

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

const ASK = {
  requestId: "ask-1",
  sessionId: "s1",
  toolCallId: "call-ask",
  questions: [
    { question: "Which database?", options: [{ label: "Postgres", description: "the usual" }, "SQLite"], multiSelect: false },
    { question: "Which extras?", options: ["cache", "search"], multiSelect: true },
  ],
};
const PERMISSION = { requestId: "perm-1", sessionId: "s1", toolName: "Bash", argsPreview: { command: "rm -rf build && npm run build" }, reason: "runs a shell command", risk: "high", agentName: "fixer" };

/** A running session s1 whose host answers agent/pendingInteractive with `interactive`. */
function host({ interactive = { asks: [], permissions: [] }, messages = [user("set up the app"), assistant("Looking at it.")], id = "s1" } = {}) {
  return (req) => {
    switch (req.operation) {
      case "session/list": return { sessions: [{ id, title: "App", updatedAt: Date.now() }] };
      case "plans/pending": return { plans: [] };
      case "agent/getStatus": return { status: { isRunning: true } };
      case "session/get": return { messages };
      case "agent/pendingInteractive":
        if (interactive instanceof Error) throw interactive;
        return interactive;
      default: return {};
    }
  };
}
const notExposed = () => Object.assign(new Error("operation is not exposed: agent/pendingInteractive"), { code: "NOT_FOUND" });

describe("poll: pending question cards and permission prompts", () => {
  it("reads agent/pendingInteractive for a running session, without confirm", async () => {
    const { pi, t } = fresh({ respond: host() });
    await t.poll();
    const reads = pi.invocations.filter((r) => r.operation === "agent/pendingInteractive");
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0].args, [{ sessionId: "s1" }]);
    assert.equal(reads[0].confirm, undefined);
    assert.equal(t.model.agents[0].status, "run");
  });

  it("turns an open question card into an answerable question", async () => {
    const messages = [user("set up the app"), assistant("I need two choices first."), tool("asktool", { toolCallId: "call-ask", toolArgs: { questions: ASK.questions } })];
    const { t } = fresh({ respond: host({ interactive: { asks: [ASK], permissions: [] }, messages }) });
    await t.poll();
    const [a] = t.model.agents;
    assert.equal(a.status, "answer"); // "Awaiting answer", not "Needs you"
    assert.equal(a.question.requestId, "ask-1");
    assert.equal(a.question.q, "Which database?");
    assert.equal(a.question.more, 1);
    assert.deepEqual(a.question.opts, ["Postgres", "SQLite"]);
    assert.deepEqual(a.question.questions[0].opts, [{ label: "Postgres", description: "the usual" }, { label: "SQLite" }]);
    assert.equal(a.question.questions[1].multi, true);
    assert.match(a.question.ctx, /two choices/);
  });

  it("turns a pending tool permission into a permission prompt", async () => {
    const { t } = fresh({ respond: host({ interactive: { asks: [], permissions: [PERMISSION] } }) });
    await t.poll();
    const [a] = t.model.agents;
    assert.equal(a.status, "need");
    assert.equal(a.question, null);
    assert.equal(a.permission.requestId, "perm-1");
    assert.equal(a.permission.tool, "Bash");
    assert.equal(a.permission.risk, "high");
    assert.equal(a.permission.agentName, "fixer");
    assert.equal(a.permission.target, "rm -rf");
    assert.match(a.permission.args, /rm -rf build/);
  });

  it("trusts the host over the transcript: an asktool the host no longer lists is not open", async () => {
    const messages = [user("go"), tool("asktool", { toolArgs: { questions: [{ question: "Old?" }] } })];
    const { t } = fresh({ respond: host({ messages }) });
    await t.poll();
    assert.equal(t.model.agents[0].question, null);
    assert.equal(t.model.agents[0].status, "run");
  });

  it("falls back to the transcript on a host without the operation, and stops asking it", async () => {
    const messages = [user("go"), tool("asktool", { toolArgs: { questions: [{ question: "Proceed?", options: ["yes", "no"] }] } })];
    const { pi, t } = fresh({ respond: host({ interactive: notExposed(), messages }) });
    await t.poll();
    const [a] = t.model.agents;
    assert.equal(a.status, "answer");
    assert.equal(a.question.q, "Proceed?");
    assert.equal(a.question.requestId, undefined);
    assert.equal(a.permission, null);
    await t.poll();
    assert.equal(pi.invocations.filter((r) => r.operation === "agent/pendingInteractive").length, 1);
  });

  it("keeps asking after a passing failure, using the transcript meanwhile", async () => {
    const { pi, t } = fresh({ respond: host({ interactive: new Error("timeout") }) });
    await t.poll();
    await t.poll();
    assert.equal(pi.invocations.filter((r) => r.operation === "agent/pendingInteractive").length, 2);
  });

  it("notifies when a question card opens, and again for the next one", async () => {
    let asks = [];
    const { pi, t } = fresh({ respond: (req) => host({ interactive: { asks, permissions: [] } })(req) });
    await t.poll(); // the first poll only learns the baseline
    asks = [ASK];
    await t.poll();
    asks = [{ ...ASK, requestId: "ask-2" }];
    await t.poll();
    await new Promise((r) => setTimeout(r, 10));
    const notices = pi.notifications.filter((n) => n.kind === "notice");
    assert.equal(notices.length, 2);
    assert.match(notices[0].title, /has a question for you/);
  });

  it("notifies again for a new permission prompt while the agent already needed you", async () => {
    let interactive = { asks: [], permissions: [PERMISSION] };
    const { pi, t } = fresh({ respond: (req) => host({ interactive })(req) });
    await t.poll(); // the first poll only learns the baseline
    interactive = { asks: [], permissions: [{ ...PERMISSION, requestId: "perm-2", toolName: "Write" }] };
    await t.poll();
    await new Promise((r) => setTimeout(r, 10));
    const notices = pi.notifications.filter((n) => n.kind === "notice");
    assert.equal(notices.length, 1);
    assert.match(notices[0].title, /permission to run Write/);
  });
});

describe("act: answering from the drawer", () => {
  const action = (main, payload) => main.onPanelInvoke("radar.action", payload);

  it("answer → agent/askTool/resolve with confirm", async () => {
    const { pi, main } = fresh();
    const r = await action(main, { action: "answer", sessionId: "s1", requestId: "ask-1", answers: [["Postgres"], [" cache ", "", "search"]] });
    assert.equal(r.ok, true);
    assert.deepEqual(pi.invocations[0], { operation: "agent/askTool/resolve", args: [{ sessionId: "s1", requestId: "ask-1", answers: [["Postgres"], ["cache", "search"]] }], confirm: true });
  });

  it("declining sends null for every question", async () => {
    const { pi, main } = fresh();
    assert.equal((await action(main, { action: "answer", sessionId: "s1", requestId: "ask-1", answers: [null, null] })).ok, true);
    assert.deepEqual(pi.invocations[0].args[0].answers, [null, null]);
  });

  it("refuses an answer without a request id or with malformed answers", async () => {
    const { pi, main } = fresh();
    for (const payload of [
      { requestId: "", answers: [["a"]] },
      { requestId: "ask-1", answers: [] },
      { requestId: "ask-1", answers: "a" },
      { requestId: "ask-1", answers: [[1]] },
      { requestId: "ask-1", answers: ["a"] },
    ]) {
      const r = await action(main, { action: "answer", sessionId: "s1", ...payload });
      assert.equal(r.ok, false, JSON.stringify(payload));
    }
    assert.deepEqual(pi.invocations, []);
  });

  it("permission → tool/resolvePermission with confirm, for each decision", async () => {
    for (const decision of ["allow-once", "allow-session", "deny"]) {
      const { pi, main } = fresh();
      const r = await action(main, { action: "permission", sessionId: "s1", requestId: "perm-1", decision });
      assert.equal(r.ok, true);
      assert.deepEqual(pi.invocations[0], { operation: "tool/resolvePermission", args: [{ requestId: "perm-1", decision }], confirm: true });
    }
  });

  it("refuses an unknown permission decision or a missing request id", async () => {
    const { pi, main } = fresh();
    assert.equal((await action(main, { action: "permission", sessionId: "s1", requestId: "perm-1", decision: "allow-always" })).ok, false);
    assert.equal((await action(main, { action: "permission", sessionId: "s1", decision: "deny" })).ok, false);
    assert.deepEqual(pi.invocations, []);
  });

  it("reports a declined host confirmation as a failure", async () => {
    const denied = Object.assign(new Error("user declined tool/resolvePermission"), { code: "PERMISSION_DENIED" });
    const { main } = fresh({ respond: () => { throw denied; } });
    const r = await action(main, { action: "permission", sessionId: "s1", requestId: "perm-1", decision: "allow-once" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "PERMISSION_DENIED");
  });
});
