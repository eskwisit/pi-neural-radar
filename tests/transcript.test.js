"use strict";

// Reading the transcript: "needs your reply", pending asktool cards, subagents, activity.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { loadMain, fakePi, user, assistant, tool } = require("./helpers.js");

const t = loadMain(fakePi()).__t;

describe("awaitingReply", () => {
  it("returns null when you replied last", () => {
    const messages = [
      user("Refactor the parser"),
      assistant("Done. Should I also update the docs?"),
      user("Yes please"),
    ];
    assert.equal(t.awaitingReply(messages), null);
  });

  it("returns null when the turn ended mid-tool", () => {
    const messages = [
      user("Run the tests"),
      assistant("Should I run the full suite?"),
      tool("Bash", { toolArgs: { command: "npm test" } }),
    ];
    assert.equal(t.awaitingReply(messages), null);
  });

  it("returns null when only an earlier paragraph asks", () => {
    const messages = [
      user("Check the build"),
      assistant("Why did the build fail? A missing import in parser.ts.\n\nI fixed it and the build is green now."),
    ];
    assert.equal(t.awaitingReply(messages), null);
  });

  it("returns null when the question is inside a code block", () => {
    const messages = [
      user("Show the snippet"),
      assistant("Here is the change:\n\n```js\nconst ok = confirm('Should I go on?');\n```"),
    ];
    assert.equal(t.awaitingReply(messages), null);
  });

  it("ignores a \"?\" inside inline code", () => {
    const messages = [user("Fix it"), assistant("Replaced the lookup with `user?.name`")];
    assert.equal(t.awaitingReply(messages), null);
  });

  it("returns null for empty or malformed transcripts", () => {
    assert.equal(t.awaitingReply([]), null);
    assert.equal(t.awaitingReply([null, undefined, {}]), null);
    assert.equal(t.awaitingReply([assistant("")]), null);
    assert.equal(t.awaitingReply([{ role: "assistant", content: 42 }]), null);
  });

  it("gives a vague \"Should I go with this?\" the context before it in the same message", () => {
    const messages = [
      user("Pick a caching strategy"),
      assistant("I compared the two caching strategies. The LRU option keeps memory flat at 40 MB, the TTL option is simpler.\n\nShould I go with this?"),
    ];
    const r = t.awaitingReply(messages);
    assert.ok(r, "expected an ask");
    assert.equal(r.ask, "Should I go with this?");
    assert.ok(r.context.length > 0, "expected context");
    assert.match(r.context, /LRU option/);
  });

  it("takes the context from earlier in the turn when the question stands alone", () => {
    const messages = [
      user("Speed up the parser"),
      assistant("I refactored the parser into three passes."),
      tool("Bash", { toolCompletedAt: 1, toolStatus: "success" }),
      assistant("Should I go with this?"),
    ];
    const r = t.awaitingReply(messages);
    assert.ok(r);
    assert.equal(r.ask, "Should I go with this?");
    assert.match(r.context, /three passes/);
  });

  it("does not reach back past your latest message for context", () => {
    const messages = [
      assistant("Earlier turn text that must not leak."),
      user("Next task"),
      assistant("Should I go with this?"),
    ];
    const r = t.awaitingReply(messages);
    assert.ok(r);
    assert.equal(r.context, "");
  });

  it("counts asking phrases without a question mark", () => {
    const r = t.awaitingReply([user("Deploy"), assistant("Staging is ready. Let me know when to promote it.")]);
    assert.ok(r);
    assert.match(r.ask, /let me know/i);
  });

  it("reads block-format messages", () => {
    const r = t.awaitingReply([
      user("Go"),
      { role: "assistant", blocks: [{ type: "text", text: "Two options remain. Which one do you prefer?" }] },
    ]);
    assert.ok(r);
    assert.match(r.ask, /Which one do you prefer\?/);
  });

  it("bounds the excerpt length", () => {
    const long = "word ".repeat(400) + "is that ok?";
    const r = t.awaitingReply([user("x"), assistant(long)]);
    assert.ok(r);
    assert.ok(r.ask.length <= 320, `ask is ${r.ask.length} chars`);
    assert.ok(r.context.length <= 280, `context is ${r.context.length} chars`);
  });
});

describe("askingPart", () => {
  it("ignores headings and table rows in the closing paragraph", () => {
    assert.equal(t.askingPart("Summary\n\n| a | b? |\n|---|---|\n| 1 | 2 |"), null);
    assert.equal(t.askingPart("Report\n\n## What next?"), null);
  });
});

describe("pendingQuestionFrom", () => {
  const ask = (extra = {}) => tool("asktool", {
    toolCallId: "c1",
    toolArgs: { questions: [{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] }, { question: "Second?" }] },
    ...extra,
  });

  it("returns an unanswered asktool question with its options and context", () => {
    const q = t.pendingQuestionFrom([user("Set up storage"), assistant("Two databases fit the load profile."), ask()]);
    assert.ok(q);
    assert.equal(q.q, "Which database?");
    assert.equal(q.more, 1);
    assert.deepEqual(q.opts, ["Postgres", "SQLite"]);
    assert.match(q.ctx, /Two databases/);
  });

  it("ignores an asktool call that was answered (completedAt)", () => {
    assert.equal(t.pendingQuestionFrom([user("x"), ask({ toolCompletedAt: Date.now() })]), null);
  });

  it("ignores an asktool call that carries answers", () => {
    assert.equal(t.pendingQuestionFrom([user("x"), ask({ toolResult: { details: { answers: ["Postgres"] } } })]), null);
  });

  it("ignores an asktool call with a final status", () => {
    assert.equal(t.pendingQuestionFrom([user("x"), ask({ toolStatus: "success" })]), null);
    assert.equal(t.pendingQuestionFrom([user("x"), ask({ toolStatus: "error" })]), null);
  });

  it("only looks at the latest asktool call", () => {
    const messages = [user("x"), ask(), assistant("ok"), ask({ toolCallId: "c2", toolCompletedAt: 1 })];
    assert.equal(t.pendingQuestionFrom(messages), null);
  });

  it("returns null for an asktool call without questions and for malformed input", () => {
    assert.equal(t.pendingQuestionFrom([tool("asktool", { toolArgs: {} })]), null);
    assert.equal(t.pendingQuestionFrom([null, {}, { role: "tool", toolName: "asktool" }]), null);
    assert.equal(t.pendingQuestionFrom([]), null);
  });

  it("caps the options at six", () => {
    const opts = Array.from({ length: 10 }, (_, i) => ({ label: `o${i}` }));
    const q = t.pendingQuestionFrom([tool("asktool", { toolArgs: { questions: [{ question: "Pick", options: opts }] } })]);
    assert.equal(q.opts.length, 6);
  });
});

describe("delegationsFrom", () => {
  const launch = (id, agent, description, extra = {}) => tool("Task", {
    toolCallId: `call-${id}`,
    toolArgs: { agent, description },
    toolResult: { details: { delegationId: id, agent, status: "running" } },
    toolCompletedAt: 1,
    ...extra,
  });

  it("lists a running subagent of the current turn", () => {
    const subs = t.delegationsFrom([user("go"), launch("d1", "explorer", "map the repo")]);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].role, "explorer");
    assert.equal(subs[0].status, "run");
    assert.equal(subs[0].earlier, false);
  });

  it("marks a subagent done once TaskWait reports it completed", () => {
    const subs = t.delegationsFrom([
      user("go"),
      launch("d1", "fixer", "fix it"),
      tool("TaskWait", { toolResult: { details: { delegations: [{ delegationId: "d1", status: "completed" }] } }, toolCompletedAt: 2 }),
    ]);
    assert.equal(subs[0].status, "done");
  });

  it("drops a finished subagent from an earlier turn", () => {
    const subs = t.delegationsFrom([
      user("first"),
      launch("d1", "fixer", "fix it"),
      tool("TaskWait", { toolResult: { details: { delegations: [{ delegationId: "d1", status: "completed" }] } }, toolCompletedAt: 2 }),
      user("second"),
    ]);
    assert.deepEqual(subs, []);
  });

  it("treats an unknown status as stopped, and a failed launch as nothing", () => {
    const subs = t.delegationsFrom([
      user("go"),
      launch("d1", "fixer", "fix", { toolResult: { details: { delegationId: "d1", status: "weird" } } }),
      tool("Task", { toolCallId: "c9", toolArgs: { agent: "x" }, toolResult: { details: {} }, toolCompletedAt: 1 }),
    ]);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].status, "stopped");
  });

  it("survives malformed messages", () => {
    assert.deepEqual(t.delegationsFrom([null, {}, { role: "tool", toolName: "TaskWait" }]), []);
  });
});

describe("mergeSubs", () => {
  const sub = (id, status) => ({ id, role: "fixer", description: "", status, model: "" });

  it("marks running subagents done when the agent is idle", () => {
    const out = t.mergeSubs([sub("a", "run"), sub("b", "run")], [sub("b", "run")], false);
    assert.deepEqual(out.map((x) => [x.id, x.status]), [["a", "done"], ["b", "done"]]);
  });

  it("keeps a subagent that left the transcript window while the agent runs", () => {
    const out = t.mergeSubs([sub("a", "run")], [], true);
    assert.deepEqual(out.map((x) => [x.id, x.status]), [["a", "run"]]);
  });

  it("forgets finished subagents that are no longer in the transcript", () => {
    assert.deepEqual(t.mergeSubs([sub("a", "done")], [], true), []);
  });

  it("lets fresh data win and accepts a missing previous list", () => {
    const out = t.mergeSubs(undefined, [sub("a", "done")], true);
    assert.deepEqual(out.map((x) => x.status), ["done"]);
    const out2 = t.mergeSubs([sub("a", "run")], [sub("a", "done")], true);
    assert.deepEqual(out2.map((x) => x.status), ["done"]);
  });
});

describe("activityLog (structure only; its wording is localized)", { skip: typeof t.activityLog !== "function" && "activityLog not present" }, () => {
  it("returns at most 12 entries with a time and a text", () => {
    const messages = [];
    for (let i = 0; i < 30; i++) messages.push(i % 2 ? assistant(`step ${i}`, { createdAt: i }) : user(`ask ${i}`, { createdAt: i }));
    const log = t.activityLog(messages);
    assert.ok(Array.isArray(log));
    assert.ok(log.length > 0 && log.length <= 12);
    for (const entry of log) {
      assert.equal(typeof entry, "object");
      assert.equal(typeof entry.t, "number");
    }
    // newest first
    for (let i = 1; i < log.length; i++) assert.ok(log[i - 1].t >= log[i].t);
  });

  it("survives malformed messages", () => {
    assert.ok(Array.isArray(t.activityLog([null, {}, { role: "tool", toolName: "Bash" }])));
  });
});
