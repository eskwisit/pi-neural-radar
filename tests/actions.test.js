"use strict";

// The drawer's actions (radar.action → act) and the panel bridge: validation, the exact host
// operations sent, the confirm flag on plans/resolve, and host failures / denied permissions.

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { loadMain, fakePi, permissionError } = require("./helpers.js");

const loaded = [];
function fresh(options) {
  const pi = fakePi(options);
  const main = loadMain(pi);
  loaded.push(main);
  return { pi, main, t: main.__t };
}
// every action schedules a quick re-poll: unload so no timer outlives the test
afterEach(async () => {
  while (loaded.length) await loaded.pop().onUnload();
});

const action = (main, payload) => main.onPanelInvoke("radar.action", payload);

describe("panel bridge", () => {
  it("answers radar.state with the model", async () => {
    const { main } = fresh();
    const r = await main.onPanelInvoke("radar.state", {});
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.model.agents));
  });

  it("rejects an unknown channel without calling the host", async () => {
    const { main, pi } = fresh();
    const r = await main.onPanelInvoke("radar.exec", { action: "open", sessionId: "s1" });
    assert.equal(r.ok, false);
    assert.deepEqual(pi.invocations, []);
  });
});

describe("act: input validation", () => {
  it("rejects a missing sessionId", async () => {
    const { main, pi } = fresh();
    for (const payload of [{ action: "open" }, { action: "stop", sessionId: "" }, { action: "abort", sessionId: null }, {}, null, undefined]) {
      const r = await action(main, payload);
      assert.equal(r.ok, false, JSON.stringify(payload));
    }
    assert.deepEqual(pi.invocations, []);
    assert.deepEqual(pi.suggestions, []);
  });

  it("rejects an unknown action", async () => {
    const { main, pi } = fresh();
    const r = await action(main, { action: "delete", sessionId: "s1" });
    assert.equal(r.ok, false);
    assert.deepEqual(pi.invocations, []);
  });

  it("does not send an empty or blank message", async () => {
    const { main, pi } = fresh();
    for (const text of ["", "   \n ", undefined, null]) {
      const r = await action(main, { action: "send", sessionId: "s1", text });
      assert.equal(r.ok, false);
    }
    assert.deepEqual(pi.invocations, []);
  });

  it("refuses a plan decision without a complete pending proposal", async () => {
    const { main, pi } = fresh();
    for (const proposal of [undefined, {}, { proposalId: "p1" }, { proposalId: "p1", turnId: "t1" }]) {
      const r = await action(main, { action: "plan", sessionId: "s1", decision: "approve", proposal });
      assert.equal(r.ok, false);
    }
    assert.deepEqual(pi.invocations, []);
  });
});

describe("act: host operations", () => {
  it("open → session/open", async () => {
    const { main, pi } = fresh();
    assert.equal((await action(main, { action: "open", sessionId: "s1" })).ok, true);
    assert.deepEqual(pi.invocations, [{ operation: "session/open", args: ["s1"] }]);
  });

  it("send → agent/prompt with the trimmed text, no confirm flag", async () => {
    const { main, pi } = fresh();
    assert.equal((await action(main, { action: "send", sessionId: "s1", text: "  go on  " })).ok, true);
    assert.deepEqual(pi.invocations, [{ operation: "agent/prompt", args: [{ sessionId: "s1", content: "go on" }] }]);
  });

  it("stop → agent/stop and abort → agent/abort (the view asks for the second click)", async () => {
    const { main, pi } = fresh();
    await action(main, { action: "stop", sessionId: "s1" });
    await action(main, { action: "abort", sessionId: "s1" });
    assert.deepEqual(pi.invocations, [
      { operation: "agent/stop", args: [{ sessionId: "s1" }] },
      { operation: "agent/abort", args: [{ sessionId: "s1" }] },
    ]);
  });

  it("prefill is no longer an action and touches neither the session nor the composer", async () => {
    const { main, pi } = fresh();
    assert.equal((await action(main, { action: "prefill", sessionId: "s1", text: "try the cache" })).ok, false);
    assert.deepEqual(pi.invocations, []);
    assert.deepEqual(pi.suggestions, []);
  });

  const proposal = { proposalId: "p1", turnId: "t1", toolCallId: "c1", version: 3 };

  it("approve → plans/resolve sent with confirm: true, in the safe \"ask\" mode by default", async () => {
    const { main, pi } = fresh();
    assert.equal((await action(main, { action: "plan", sessionId: "s1", decision: "approve", proposal })).ok, true);
    assert.equal(pi.invocations.length, 1);
    const [req] = pi.invocations;
    assert.equal(req.operation, "plans/resolve");
    assert.equal(req.confirm, true);
    assert.deepEqual(req.args, [{ proposalId: "p1", sessionId: "s1", turnId: "t1", toolCallId: "c1", action: "approve", version: 3, targetPermissionMode: "ask" }]);
  });

  it("reject → plans/resolve with confirm: true and no permission mode", async () => {
    const { main, pi } = fresh();
    await action(main, { action: "plan", sessionId: "s1", decision: "reject", proposal });
    const [req] = pi.invocations;
    assert.equal(req.confirm, true);
    assert.equal(req.args[0].action, "reject");
    assert.equal("targetPermissionMode" in req.args[0], false);
  });

  it("anything but decision \"approve\" rejects", async () => {
    const { main, pi } = fresh();
    await action(main, { action: "plan", sessionId: "s1", decision: "yes", proposal });
    assert.equal(pi.invocations[0].args[0].action, "reject");
  });

  for (const [mode, expected] of [["accept-edits", "accept-edits"], ["auto", "auto"], ["bypass-everything", "ask"], ["", "ask"]]) {
    it(`approve keeps the session's permission mode only when it is known (${mode || "none"} → ${expected})`, async () => {
      const now = Date.now();
      const { main, pi, t } = fresh({
        respond: ({ operation }) => (operation === "session/list" ? { sessions: [{ id: "s1", updatedAt: now, permissionMode: mode }] } : {}),
      });
      await t.poll();
      pi.invocations.length = 0;
      await action(main, { action: "plan", sessionId: "s1", decision: "approve", proposal });
      assert.equal(pi.invocations[0].args[0].targetPermissionMode, expected);
    });
  }
});

describe("act: host failures and denied permissions", () => {
  it("a failing host operation comes back as an error, not a throw", async () => {
    const { main } = fresh({ respond: () => { throw new Error("session not found"); } });
    for (const payload of [
      { action: "open", sessionId: "s1" },
      { action: "send", sessionId: "s1", text: "hi" },
      { action: "stop", sessionId: "s1" },
      { action: "abort", sessionId: "s1" },
      { action: "plan", sessionId: "s1", decision: "approve", proposal: { proposalId: "p", turnId: "t", toolCallId: "c" } },
    ]) {
      const r = await action(main, payload);
      assert.equal(r.ok, false, payload.action);
      assert.match(r.message, /session not found/);
    }
  });

  it("a denied desktop.control is surfaced with its code", async () => {
    const { main } = fresh({ respond: () => Promise.reject(permissionError("desktop.control")) });
    const r = await action(main, { action: "abort", sessionId: "s1" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "PERMISSION_DENIED");
    assert.match(r.message, /desktop\.control/);
  });

  it("a non-Error rejection is still reported as a message", async () => {
    const { main } = fresh({ respond: () => Promise.reject("boom") });
    const r = await action(main, { action: "open", sessionId: "s1" });
    assert.deepEqual({ ok: r.ok, message: r.message }, { ok: false, message: "boom" });
  });
});

describe("act: messages to a busy agent wait in a queue", () => {
  const now = Date.now();
  const busyError = () => Object.assign(new Error("the session already has an active turn"), { code: "AGENT_BUSY" });
  /** A host with one session s1; `state.running` drives agent/getStatus, `state.busy` agent/prompt. */
  function host(state) {
    return ({ operation }) => {
      switch (operation) {
        case "session/list": return { sessions: [{ id: "s1", updatedAt: now, title: "S1" }] };
        case "agent/getStatus": return { status: { isRunning: state.running } };
        case "session/get": return { messages: [] };
        case "agent/prompt": if (state.busy) throw busyError(); return { accepted: true };
        default: return {};
      }
    };
  }
  const prompts = (pi) => pi.invocations.filter((r) => r.operation === "agent/prompt").map((r) => r.args[0].content);

  it("an idle agent takes the message at once: delivery \"sent\"", async () => {
    const { main, pi } = fresh({ respond: host({ running: false }) });
    const r = await action(main, { action: "send", sessionId: "s1", text: "go" });
    assert.deepEqual({ ok: r.ok, delivery: r.delivery }, { ok: true, delivery: "sent" });
    assert.deepEqual(prompts(pi), ["go"]);
  });

  it("AGENT_BUSY from the host queues the message instead of failing", async () => {
    const { main, t } = fresh({ respond: host({ running: false, busy: true }) });
    const r = await action(main, { action: "send", sessionId: "s1", text: "later" });
    assert.deepEqual({ ok: r.ok, delivery: r.delivery, position: r.position }, { ok: true, delivery: "queued", position: 1 });
    assert.deepEqual(t.model.agents, []); // nothing on the radar yet: the queue shows on the next poll
  });

  it("a running agent queues without asking the host, keeps the order and sends one per turn end", async () => {
    const state = { running: true };
    const { main, pi, t } = fresh({ respond: host(state) });
    await t.poll(); // learns s1 is running
    pi.invocations.length = 0;
    assert.equal((await action(main, { action: "send", sessionId: "s1", text: "first" })).delivery, "queued");
    assert.equal((await action(main, { action: "send", sessionId: "s1", text: "second" })).position, 2);
    assert.deepEqual(prompts(pi), []);
    assert.deepEqual(t.model.agents.find((a) => a.id === "s1").queued.map((x) => x.text), ["first", "second"]);

    await t.poll(); // still running: nothing goes out
    assert.deepEqual(prompts(pi), []);
    state.running = false;
    await t.poll(); // the turn ended: the first goes out and the agent counts as running again
    assert.deepEqual(prompts(pi), ["first"]);
    assert.deepEqual(t.model.agents.find((a) => a.id === "s1").queued.map((x) => x.text), ["second"]);
    assert.deepEqual(t.model.events.map((e) => [e.kind, e.sessionId, e.text]), [["delivered", "s1", "first"]]);
    await t.poll();
    assert.deepEqual(prompts(pi), ["first", "second"]);
    assert.deepEqual(t.model.agents.find((a) => a.id === "s1").queued, []);
  });

  it("a delivery refused as busy stays queued; another failure drops it with a \"failed\" event", async () => {
    const state = { running: true, busy: true };
    const { main, t, pi } = fresh({ respond: host(state) });
    await t.poll();
    await action(main, { action: "send", sessionId: "s1", text: "a" });
    state.running = false;
    await t.poll();
    assert.deepEqual(t.model.agents.find((a) => a.id === "s1").queued.map((x) => x.text), ["a"]);
    assert.deepEqual(t.model.events, []);
    pi.respond = ({ operation }) => (operation === "agent/prompt" ? Promise.reject(new Error("session not found")) : host(state)({ operation }));
    await t.poll();
    assert.deepEqual(t.model.agents.find((a) => a.id === "s1").queued, []);
    assert.deepEqual(t.model.events.map((e) => [e.kind, e.message]), [["failed", "session not found"]]);
  });
});
