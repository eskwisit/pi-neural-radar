"use strict";

/**
 * Neural Radar — PI-Desktop plugin main process.
 *
 * Watches the agents (sessions) and their subagents (Task delegations), turns them into a
 * radar model for the work-panel view, opens the view automatically according to the
 * `autoOpen` setting, and carries out the actions the user picks in the view's drawer.
 *
 * Data comes from the host's desktop control operations (`desktop.control`):
 *   session/list, agent/getStatus, session/get, plans/pending    — read
 *   session/open, agent/prompt, agent/stop, agent/abort          — act on the user's click
 *   plans/resolve                                                — "dangerous": sent with confirm
 * The host has no "turn started" event for plugins, so the radar polls. It polls fast while
 * something is running and slowly while everything is idle.
 * When an agent starts needing you, a system notification tells you (`notify`; an in-app notice
 * when the system does not show it), unless the `notify` setting is off.
 *
 * Not reachable for plugins: question cards an agent opens mid-turn (`asktool`) and tool
 * permission prompts (a command waiting for your approval). `agent/askTool/resolve` and
 * `tool/resolvePermission` exist, but the request ids they need only come from
 * `agent/pendingInteractive`, which is not a plugin operation; plugins get no event for them,
 * `agent/getStatus` reports `pendingToolConfirmations: 0` for local sessions, and a pending tool
 * call is not in the transcript until it completes.
 * View channel: window.pluginBridge.invoke("radar.*", payload) → onPanelInvoke.
 */

const VIEW_ID = "radar";
const FAST_MS = 2000;
const SLOW_MS = 6000;
const LIST_MS = 10 * 1000; // the session list is refreshed this often (and on host events)
const RECENT_MS = 10 * 60 * 1000; // a finished agent stays on the radar this long
const REPLY_KEEP_MS = 2 * 60 * 60 * 1000; // an agent waiting for your reply stays this long
const CANDIDATES = 8; // most recently updated sessions considered each poll
const STALE_MS = 6 * 60 * 60 * 1000; // sessions untouched for this long are not polled
const REOPEN_COOLDOWN_MS = 30 * 1000;

let autoOpen = "working";
let notifyOn = true;
let timer = null;
let stopped = false;
let model = { agents: [], error: null };
const memory = new Map(); // sessionId → { running, subCount, attention, lastActive, updatedAt, agent }
let sessionList = [];
let listAt = 0;
let lastReveal = 0;
let firstPoll = true;
let inFlight = false;
let rerun = false;

// ---------- host helpers ----------
async function op(operation, args = [], confirm = false) {
  return pi.desktop.invoke({ operation, args, ...(confirm ? { confirm: true } : {}) });
}
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const ts = (v) => (typeof v === "number" ? v : v ? Date.parse(v) || 0 : 0);
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
/**
 * Tokens in one usage record, as PI-Desktop counts them: its total, else input + output +
 * cache read + cache write.
 */
const tokensOf = (u) => !u || typeof u !== "object" ? 0 :
  num(u.totalTokens ?? u.total_tokens) ||
  num(u.inputTokens ?? u.input_tokens) + num(u.outputTokens ?? u.output_tokens) +
  num(u.cacheReadTokens ?? u.cache_read_tokens) + num(u.cacheWriteTokens ?? u.cache_write_tokens);
/** A transcript message's provider usage (one model operation), if it carries one. */
const usageOf = (m) => m?.usage ?? m?.meta?.usage;
/** The Task call a subagent's message belongs to ("" for the agent's own messages). */
const parentCallOf = (m) => str(m?.parentToolCallId ?? m?.meta?.parentToolCallId);

/** A rough token count: about 4 characters per token, one per CJK character. */
function estimateTokens(text) {
  const t = str(text);
  if (!t) return 0;
  const cjk = (t.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) ?? []).length;
  return Math.ceil(cjk + (t.length - cjk) / 4);
}

/** What a tool call puts into the model's context: its arguments and the content of its result. */
function toolPayload(b) {
  const args = typeof b.args === "string" ? b.args : JSON.stringify(b.args ?? {});
  const r = b.result;
  let out = "";
  if (typeof r === "string") out = r;
  else if (Array.isArray(r?.content)) out = r.content.map((c) => (typeof c === "string" ? c : str(c?.text))).join("\n");
  else if (r != null) out = typeof r.content === "string" ? r.content : JSON.stringify(r.content ?? r.output ?? r.text ?? ""); // never the UI-only details
  return args + out;
}

/**
 * Tokens the agent's own tool calls put into its context (arguments + results), estimated from
 * their size. Subagents' tool calls stay in their own context and are not counted. `seen`
 * (call id → tokens) persists across polls, so calls that scroll out of the transcript window
 * keep counting; the total is a lower bound for calls made before the radar started watching.
 */
function toolTokens(messages, seen) {
  messages.forEach((m) => {
    if (parentCallOf(m)) return;
    blocksOf(m).forEach((b, k) => {
      if (!b?.name || b.type === "text") return;
      const id = str(b.callId) || `${ts(m?.createdAt ?? m?.created_at)}:${b.name}:${k}`;
      seen.set(id, Math.max(seen.get(id) ?? 0, estimateTokens(toolPayload(b))));
    });
  });
  let total = 0;
  for (const v of seen.values()) total += v;
  return total;
}

// ---------- reading sessions ----------
function sessionsFrom(listResult) {
  const raw = arr(listResult?.sessions ?? listResult?.items ?? listResult);
  return raw
    .map((s) => ({
      id: str(s.id ?? s.sessionId),
      title: str(s.title ?? s.name),
      updatedAt: ts(s.updatedAt ?? s.updated_at ?? s.lastActivityAt),
      model: str(s.modelId ?? s.model_id ?? s.model),
      permissionMode: str(s.permissionMode ?? s.permission_mode),
    }))
    .filter((s) => s.id);
}

/** Pending Plan / Goal approvals; plans/pending answers `{ plans: [...] }`. */
function plansFrom(result) {
  return arr(result?.plans ?? result?.proposals ?? result?.items ?? result).filter((p) => {
    if (!p || (p.status && p.status !== "pending")) return false;
    const exp = p.expiresAt ? Date.parse(p.expiresAt) : NaN;
    return !(Number.isFinite(exp) && exp <= Date.now());
  });
}

function planOf(p) {
  const kind = p.kind === "goal" ? "goal" : "plan";
  return {
    proposalId: str(p.id ?? p.proposalId),
    turnId: str(p.turnId),
    toolCallId: str(p.toolCallId),
    version: typeof p.version === "number" ? p.version : undefined,
    kind,
    title: str(p.title), // empty: the view shows its own "Plan / Goal ready for approval"
    question: str(p.question),
  };
}

// words that carry no topic: a prompt made only of these ("ok", "sounds great, build it") is a go-ahead
const FILLER = new Set(("yes yep yeah y no nope ok okay k sure go ahead on do it this that please pls and then now " +
  "lets let's continue proceed thanks thank you thx great perfect nice cool good fine lgtm sounds looks " +
  "build ship approve approved agreed done next again retry try works right exactly 好 好的 是 是的 继续 可以 行 对 谢谢").split(" "));
const cleanLine = (text) => (str(text).split("\n").map((l) => l.trim()).find(Boolean) ?? "")
  .replace(/[*_#>`]+/g, "").replace(/\s+/g, " ").trim();
function isTopical(line) {
  const words = line.toLowerCase().replace(/[^\p{L}\p{N}'\s]+/gu, " ").split(/\s+/).filter(Boolean);
  if (/[\u3400-\u9fff]/.test(line)) return line.replace(/[\s\p{P}]/gu, "").length >= 4 && !words.every((w) => FILLER.has(w));
  return words.length >= 3 && !words.every((w) => FILLER.has(w));
}

/**
 * What the agent works on now: the first line of your latest request that names a topic, so it
 * follows the session as it digresses but skips go-aheads like "ok" or "build it".
 */
function describeTask(messages, title) {
  let latest = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") continue;
    const line = cleanLine(textOf(messages[i]));
    if (!line) continue;
    latest = latest || line;
    if (isTopical(line)) return clipText(line, 48);
  }
  return clipText(title || latest, 48);
}
const clipText = (text, n) => (text.length > n ? text.slice(0, n - 1) + "…" : text);

/** A short target for a tool call: a file name, the gist of a command, a pattern or a host. */
function toolTarget(args) {
  let a = args;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } }
  if (!a || typeof a !== "object") return "";
  const file = str(a.path ?? a.file_path ?? a.filePath ?? a.notebook_path);
  if (file) return clipText(file.split(/[\\/]/).filter(Boolean).pop() || file, 28);
  const cmd = str(a.command ?? a.cmd);
  if (cmd) {
    // skip set-up steps like "cd dir &&" or "export X=1;" and keep the command that does the work
    const parts = cmd.split(/&&|\|\||;|\n/).map((x) => x.trim()).filter(Boolean);
    const main = parts.find((x) => !/^(cd|export|set|source|\.)\s/.test(x)) || parts[0] || "";
    return clipText(main.split(/\s+/).slice(0, 2).join(" "), 28);
  }
  const pat = str(a.pattern ?? a.query);
  if (pat) return clipText(pat, 28);
  const url = str(a.url);
  if (url) { try { return new URL(url).hostname; } catch { return clipText(url, 28); } }
  return "";
}

function messagesFrom(getResult) {
  return arr(getResult?.messages ?? getResult?.session?.messages ?? getResult?.transcript);
}

/**
 * session/get returns flat messages: a tool call is its own `tool` message carrying
 * toolName / toolArgs / toolResult / toolStatus / toolCompletedAt. Older transcripts use
 * `blocks`. Both are read as a list of uniform pseudo-blocks.
 */
function blocksOf(message) {
  if (message?.toolName) {
    return [{
      name: message.toolName,
      args: message.toolArgs ?? {},
      callId: message.toolCallId,
      result: message.toolResult,
      completedAt: message.toolCompletedAt,
      status: message.toolStatus,
    }];
  }
  return arr(message?.blocks);
}

function textOf(message) {
  if (typeof message?.content === "string" && !message.toolName) return message.content.trim();
  return arr(message?.blocks)
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

/**
 * The session's main agents, as PI-Desktop's chat shows them: every run of the agent's own tool
 * calls after your message or after the agent's text is one "Main agent" with the tasks it
 * delegated. Returns, per message, the group it belongs to (null for a subagent's messages), and
 * each group's key (the id of the message that opened it, stable while the transcript scrolls)
 * and what was said just before it.
 */
function groupsOf(messages) {
  const at = [];
  let cur = null;
  messages.forEach((m, i) => {
    if (parentCallOf(m)) { at.push(null); return; }
    const opens = m?.role === "user" || (m?.role === "assistant" && !m?.toolName && textOf(m));
    if (opens || !cur) cur = { key: str(m?.id) || `${ts(m?.createdAt ?? m?.created_at)}:${i}`, text: textOf(m), start: i };
    at.push(cur);
  });
  return at;
}

/**
 * Subagents of the session's latest turn, with their latest known status, the tokens their
 * transcript messages report (a lower bound: not every model call of a subagent is recorded) and
 * the main agent (group) that launched them.
 */
function delegationsFrom(messages) {
  const groupAt = groupsOf(messages);
  const subs = new Map();
  const callOf = new Map(); // delegationId → the Task call that launched it
  const usedBy = new Map(); // Task call id → tokens its subagent's messages report
  for (const m of messages) {
    const call = parentCallOf(m);
    if (call) usedBy.set(call, (usedBy.get(call) ?? 0) + tokensOf(usageOf(m)));
  }
  const note = (d, fallback = {}) => {
    if (typeof d === "string") d = { delegationId: d };
    const id = str(d?.delegationId);
    if (!id) return;
    const prev = subs.get(id) ?? { id, role: "", description: "", status: "running" };
    subs.set(id, {
      ...prev,
      role: str(d.agent) || prev.role,
      description: str(fallback.description) || prev.description,
      status: str(d.status) || prev.status,
      toolCalls: d.toolCalls ?? prev.toolCalls,
      lastTool: str(d.lastToolName) || prev.lastTool,
    });
  };
  // a subagent launched in an earlier turn still counts while it runs; finished ones only count
  // for the current turn (everything after the last user message)
  let lastUser = -1;
  messages.forEach((m, i) => { if (m?.role === "user") lastUser = i; });
  const seenAt = new Map();
  messages.forEach((m, i) => {
    for (const b of blocksOf(m)) {
      const name = b?.name;
      const details = b?.result?.details;
      if (name === "Task") {
        const g = groupAt[i];
        const launchedBy = g ? { group: g.key, groupText: g.text.slice(0, 220) } : {};
        if (details?.delegationId) {
          note(details, { description: b.args?.description });
          Object.assign(subs.get(str(details.delegationId)), launchedBy);
          if (b.callId) callOf.set(str(details.delegationId), str(b.callId));
        }
        else if (b.callId && !b.result && !b.completedAt) {
          // still launching: keep a provisional entry keyed by the call id
          subs.set(str(b.callId), { id: str(b.callId), role: str(b.args?.agent), description: str(b.args?.description), status: "running", ...launchedBy });
        }
        // a launch that came back without a delegation failed: nothing is running
      } else if (name === "TaskWait") {
        for (const d of arr(details?.delegations)) note(d);
      } else if (name === "TaskStop") {
        for (const d of arr(details?.stopped)) note(d);
      }
      for (const id of [str(details?.delegationId), ...arr(details?.delegations).map((d) => str(d?.delegationId)), ...arr(details?.stopped).map((d) => str(typeof d === "string" ? d : d?.delegationId)), str(b?.callId)]) {
        if (id && subs.has(id)) seenAt.set(id, i);
      }
    }
  });
  return [...subs.values()].filter((s) => s.status === "running" || (seenAt.get(s.id) ?? -1) > lastUser).map((s) => ({
    ...s,
    // only an explicit "running" counts as running; anything unknown is treated as finished
    status: s.status === "running" ? "run" : s.status === "completed" ? "done" : "stopped",
    tokens: usedBy.get(callOf.get(s.id) ?? s.id) ?? 0,
    call: callOf.get(s.id) ?? s.id, // the Task call its messages point back to
    earlier: (seenAt.get(s.id) ?? -1) <= lastUser, // last mentioned before your latest message
  }));
}

/**
 * One main agent of a session (a group of groupsOf) with the subagents it delegated to, when the
 * session has more than one: it gets its own cluster, wired to its session. Actions on it go to
 * that session (`session`).
 */
function mainAgent(sessionId, key, subs, messages, model, active) {
  const groupAt = groupsOf(messages);
  const own = messages.filter((m, i) => groupAt[i]?.key === key);
  const said = str(subs.find((x) => x.groupText)?.groupText);
  return {
    id: `${sessionId}::main:${key}`,
    session: sessionId,
    parent: sessionId,
    child: true,
    title: "", // the view names it "Main agent" in the user's language
    desc: clipText(cleanLine(said), 48),
    task: said,
    status: subs.some((x) => x.status === "run") ? "run" : "done",
    model,
    toolTokens: 0,
    tokens: subs.reduce((n, x) => n + (x.tokens || 0), 0),
    active,
    question: null,
    reply: null,
    replyContext: "",
    plan: null,
    subs,
    log: activityLog(own),
  };
}

/** An asktool call that has not been answered yet, with what the agent said leading up to it. */
function pendingQuestionFrom(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const b of blocksOf(messages[i])) {
      if (b?.name !== "asktool") continue;
      const answered = b.completedAt || b.result?.details?.answers || b.status === "success" || b.status === "error";
      if (answered) return null;
      const qs = arr(b.args?.questions);
      if (!qs.length) return null;
      return {
        q: str(qs[0].question),
        more: qs.length - 1,
        opts: arr(qs[0].options).map((o) => str(o?.label ?? o)).filter(Boolean).slice(0, 6),
        ctx: turnContext(messages, i + 1),
      };
    }
  }
  return null;
}

/**
 * "Your turn": the agent's turn is over, its last message is its own (you have not replied)
 * and that message asks you something. Returns `{ ask, context }` — the part that asks and a
 * short summary of what it is about — or null.
 */
function awaitingReply(messages) {
  let at = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const r = messages[i]?.role;
    if (r === "user" || r === "assistant" || r === "tool") { at = i; break; }
  }
  const last = messages[at];
  if (!last || last.role !== "assistant") return null; // you replied, or the turn ended mid-tool
  const text = textOf(last);
  const ask = text ? askingPart(text) : null;
  if (!ask) return null;
  // what the question is about: the text before it in the same message, else earlier in the turn
  const context = contextBefore(text, ask) || turnContext(messages, at);
  return { ask, context: context && !ask.includes(context) ? context : "" };
}

const ASK_PHRASES = /\b(should i|shall i|do you want|would you like|want me to|which (one|option|do you|would you)|let me know|tell me (which|what|if|how|whether)|please (confirm|choose|decide|reply|advise|review)|can you (confirm|check|share|provide)|could you (confirm|check|share|provide)|your call|up to you|waiting for (you|your)|i need (you|your)|need your (input|decision|approval|go-ahead|ok)|ok to (proceed|go ahead)|go ahead\?)/i;

// code blocks never count; inline code keeps its text (file names carry the context) minus any "?"
const proseOf = (text) => text.replace(/```[\s\S]*?```/g, " ").replace(/`([^`\n]*)`/g, (_, c) => c.replace(/\?/g, ""));
const plain = (s) => s.replace(/\*\*|__|[*#]|^\s*>/gm, "").replace(/\s+/g, " ").trim();

/** Prose lines without tables or rules, markdown stripped, list items marked with "• ". */
function proseLines(text) {
  return proseOf(text).split("\n")
    .filter((l) => !/^\s*\|/.test(l) && !/^\s*[-=*_]{3,}\s*$/.test(l))
    .map((l) => plain(l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "• ")))
    .filter(Boolean);
}

/** The closing sentences / list items of `lines`, about two sentences long. */
function tailSummary(lines, max = 280) {
  const pieces = [];
  for (const l of lines) {
    if (l.startsWith("• ")) pieces.push(l);
    else pieces.push(...l.split(/(?<=[.!?:;])\s+/).filter(Boolean));
  }
  const out = [];
  let len = 0;
  for (let i = pieces.length - 1; i >= 0 && len < 160; i--) {
    const p = pieces[i];
    if (len + p.length + 1 > max) {
      if (!out.length) out.unshift("…" + p.slice(-(max - 1)));
      break;
    }
    out.unshift(p);
    len += p.length + 1;
  }
  return out.join(" ").trim();
}

/** A summary of the text in `text` that comes before the asking excerpt `ask`. */
function contextBefore(text, ask) {
  const lines = proseLines(text);
  const probe = ask.replace(/^…/, "").slice(0, 30);
  if (!probe) return "";
  for (let k = lines.length - 1; k >= 0; k--) {
    const pos = (lines[k] + " " + (lines[k + 1] ?? "")).indexOf(probe);
    if (pos < 0) continue;
    const before = lines.slice(0, k);
    const head = lines[k].slice(0, pos).trim();
    if (head) before.push(head);
    return tailSummary(before);
  }
  return "";
}

/** A summary of what the agent wrote in the current turn before message `end`. */
function turnContext(messages, end) {
  const texts = [];
  for (let i = end - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") break;
    if (m?.role === "assistant" && !m.toolName) {
      const t = textOf(m);
      if (t) texts.unshift(t);
      if (texts.join(" ").length > 600) break;
    }
  }
  return texts.length ? tailSummary(proseLines(texts.join("\n"))) : "";
}

function askingPart(text) {
  const prose = proseOf(text).trim();
  if (!prose) return null;
  const tail = prose.slice(-700);
  const paragraphs = tail.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const lastPara = paragraphs[paragraphs.length - 1] ?? "";
  const lines = tail.split("\n").map((l) => l.trim()).filter(Boolean);
  // only the closing paragraph counts: a "?" or a phrase further up is part of the report,
  // not a question to you; table rows and headings are never questions
  const closing = lastPara.split("\n").filter((l) => !/^\s*(\||#)/.test(l)).join(" ").trim();
  const endsWithQuestion = /\?[\s*_)\]"'”’]*$/.test(closing);
  const asks = endsWithQuestion || ASK_PHRASES.test(closing);
  if (!asks) return null;
  // show the sentence(s) that ask: the last line holding a "?" or the last paragraph
  const withQ = [...lines].reverse().find((l) => l.includes("?"));
  const excerpt = plain((withQ && lines.slice(-4).includes(withQ) ? withQ : lastPara).replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, ""));
  return excerpt.length > 320 ? "…" + excerpt.slice(-319) : excerpt;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return textOf(messages[i]);
  return "";
}

/**
 * Language-neutral activity entries; the view words them in the user's language:
 *   { t, kind: "you", text }            your message
 *   { t, kind: "say", text }            the agent's message
 *   { t, kind: "launch", agent, text }  a subagent launch (agent "" = unnamed), text = its task
 *   { t, kind: "ask" }                  the agent asked you a question
 *   { t, kind: "tool", tool, target, running }  a tool call; target is a file, command, pattern or host ("" if none)
 */
function activityLog(messages) {
  const out = [];
  for (const m of messages.slice(-14)) {
    const at = ts(m?.createdAt ?? m?.created_at);
    if (m?.role === "user") out.push({ t: at, kind: "you", text: textOf(m).slice(0, 140) });
    else if (m?.role === "assistant" && textOf(m)) out.push({ t: at, kind: "say", text: textOf(m).replace(/\s+/g, " ").slice(0, 140) });
    for (const b of blocksOf(m)) {
      if (b?.name === "Task") out.push({ t: at, kind: "launch", agent: str(b.args?.agent), text: str(b.args?.description).slice(0, 90) });
      else if (b?.name === "asktool") out.push({ t: at, kind: "ask" });
      else if (b?.name && b?.type !== "text") out.push({ t: at, kind: "tool", tool: str(b.name), target: toolTarget(b.args ?? b.input), running: !b.completedAt });
    }
  }
  return out.slice(-12).reverse();
}

/**
 * Subagents are remembered across polls: a long turn can push a Task call out of the
 * transcript window while the subagent keeps running. Once the agent stops, whatever was
 * still marked running is shown as done.
 */
function mergeSubs(previous, fresh, running) {
  const byId = new Map(arr(previous).map((x) => [x.id, x]));
  // a subagent's messages can scroll out of the transcript window: its tokens never go down
  for (const x of fresh) {
    const prev = byId.get(x.id);
    byId.set(x.id, { ...prev, ...x, tokens: Math.max(prev?.tokens ?? 0, x.tokens ?? 0) });
  }
  const freshIds = new Set(fresh.map((x) => x.id));
  const out = [];
  for (const x of byId.values()) {
    if (freshIds.has(x.id)) out.push(x);
    else if (x.status === "run") out.push(running ? x : { ...x, status: "done" });
  }
  // when the agent itself is idle nothing under it can still be running
  return running ? out : out.map((x) => (x.status === "run" ? { ...x, status: "done" } : x));
}

// ---------- the radar model ----------
async function poll() {
  const active = await pi.session.getActive().catch(() => null);
  const activeSessionId = str(active?.sessionId) || null;
  if (Date.now() - listAt > LIST_MS || !sessionList.length) {
    sessionList = sessionsFrom(await op("session/list"));
    sessionList.sort((a, b) => b.updatedAt - a.updatedAt);
    listAt = Date.now();
  }
  const list = sessionList.filter((s) => Date.now() - s.updatedAt < STALE_MS || s.id === activeSessionId);
  const candidates = list.slice(0, CANDIDATES);
  // every pending Plan / Goal approval, in one read: a session waiting for approval is always
  // watched, even when its runtime was disposed and agent/getStatus no longer reports it
  const pendingPlans = new Map();
  for (const p of plansFrom(await op("plans/pending", [{}]).catch(() => null))) {
    const sid = str(p.sessionId);
    if (sid && !pendingPlans.has(sid)) pendingPlans.set(sid, p);
  }
  for (const s of sessionList) {
    const m = memory.get(s.id);
    const keep = s.id === activeSessionId || m?.running || m?.attention || pendingPlans.has(s.id);
    if (keep && !candidates.some((c) => c.id === s.id)) candidates.push(s);
  }

  const now = Date.now();
  const agents = [];
  for (const s of candidates) {
    const status = (await op("agent/getStatus", [s.id]).catch(() => null))?.status ?? {};
    const running = status.isRunning === true;
    const isActive = s.id === activeSessionId;
    const mem = memory.get(s.id) ?? { running: false, subCount: 0, attention: "", lastActive: 0 };
    if (running) mem.lastActive = now;
    const pendingPlan = pendingPlans.get(s.id);
    const planKey = str(pendingPlan?.id) || str(status.pendingPlanId) || (status.planningState === "awaiting_approval" ? "awaiting" : "");
    const lastSeen = Math.max(mem.lastActive || 0, s.updatedAt || 0);
    const recent = now - lastSeen < RECENT_MS;
    if (!running && !planKey) {
      // idle: the transcript only needs reading once after it changed (and once the second idle
      // poll has settled the subagents, or they would stay "running" in the cached picture)
      const cached = mem.agent && mem.updatedAt === s.updatedAt && !mem.running && (mem.idleStreak || 0) >= 2 && mem.planKey === planKey && mem.wasActive === isActive;
      const keepFor = mem.attention === "need" ? REPLY_KEEP_MS : RECENT_MS;
      if (cached) {
        if (now - lastSeen < keepFor) agents.push(...[mem.agent, ...arr(mem.mains)].map((x) => ({ ...x, active: isActive })));
        continue;
      }
      if (now - (s.updatedAt || 0) > REPLY_KEEP_MS) { memory.set(s.id, { ...mem, running: false, attention: "" }); continue; }
    }
    const detail = await op("session/get", [{ id: s.id, messageLimit: 60 }]).catch(() => null);
    const messages = messagesFrom(detail);

    const question = running ? pendingQuestionFrom(messages) : null;
    let plan = pendingPlan ? planOf(pendingPlan) : null;
    if (!plan && planKey) {
      // the runtime reports a pending plan the global read did not carry: ask for this session
      const pending = await op("plans/pending", [{ sessionId: s.id }]).catch(() => null);
      const p = plansFrom(pending).find((x) => !x?.sessionId || x.sessionId === s.id);
      if (p) plan = planOf(p);
    }
    // a turn boundary can read as idle for one poll while background subagents keep running:
    // only after two idle polls in a row are the remaining subagents treated as finished
    mem.idleStreak = running ? 0 : (mem.idleStreak || 0) + 1;
    // a subagent from an earlier turn only stays while it was seen running in this watch: a
    // transcript that never recorded its end must not bring it back turn after turn
    const prevRun = new Set(arr(mem.subs).filter((x) => x.status === "run").map((x) => x.id));
    const fresh = delegationsFrom(messages).filter((x) => !x.earlier || prevRun.has(x.id)).map(({ earlier, ...x }) => x);
    const subs = mergeSubs(mem.subs, fresh, running || mem.idleStreak < 2);
    mem.subs = subs;
    mem.toolSeen = mem.toolSeen ?? new Map();
    const toolTok = toolTokens(messages, mem.toolSeen);
    const awaiting = !running && !question && !plan ? awaitingReply(messages) : null;
    const asked = awaiting?.ask ?? null;
    // once you have opened the session and seen the question, leaving it means "not now":
    // the agent drops back to finished and fades out like any other
    if (asked && isActive) mem.seenReply = asked;
    const reply = asked && !(mem.seenReply === asked && !isActive) ? asked : null;
    if (!asked) mem.seenReply = "";
    const statusKey = question || reply ? "need" : plan ? "approve" : running ? "run" : "done";
    const title = s.title; // empty: the view shows "Untitled session" in the user's language
    const agent = {
      id: s.id,
      // the view names the neuron after the session title, with what it works on below
      desc: describeTask(messages, title),
      title,
      task: lastUserText(messages).slice(0, 220) || title,
      status: statusKey,
      model: str(status.modelId) || s.model,
      toolTokens: toolTok,
      active: s.id === activeSessionId,
      question,
      reply,
      replyContext: reply ? awaiting.context : "",
      plan,
      subs,
      log: activityLog(messages),
    };
    // two or more main agents (see groupsOf) each get their own cluster with their own subagents;
    // with one, its subagents stay around the session's cluster
    const groups = [...new Set(subs.map((x) => x.group ?? ""))];
    const mains = groups.length > 1
      ? groups.map((g) => mainAgent(s.id, g, subs.filter((x) => (x.group ?? "") === g), messages, agent.model, isActive))
      : [];
    if (mains.length) agent.subs = [];
    // a plainly finished agent only lingers for a while; one waiting for your reply stays
    if (statusKey !== "done" || recent) agents.push(agent, ...mains);

    // edges that may open the radar
    const runCount = subs.filter((x) => x.status === "run").length;
    const becameRunning = running && !mem.running;
    const newSubagent = runCount > (mem.subCount || 0);
    const needsYouNow = (statusKey === "need" || statusKey === "approve") && mem.attention !== statusKey;
    memory.set(s.id, { ...mem, running, subCount: runCount, attention: statusKey === "need" || statusKey === "approve" ? statusKey : "", updatedAt: s.updatedAt, planKey, agent, mains, wasActive: isActive });
    // the first poll only learns the baseline: agents already running at load do not pop the view
    if (!firstPoll) maybeReveal({ becameRunning, newSubagent, needsYouNow });
    if (!firstPoll && needsYouNow) void notifyNeed(agent);
  }

  firstPoll = false;
  model = { agents, error: null };
  // poll fast only while an agent is actually running; one waiting for you is picked up by
  // the turnEnded / activated events (and the slow poll) as soon as you act
  return agents.some((a) => a.status === "run");
}

// what a notification says, in the user's language
const NOTE = {
  en: { question: "{title} has a question for you", reply: "{title} is waiting for your reply", plan: "{title}: plan waiting for approval", goal: "{title}: goal waiting for approval", untitled: "Untitled session" },
  zh: { question: "{title} 有问题要问你", reply: "{title} 正在等待你的回复", plan: "{title}：计划等待批准", goal: "{title}：目标等待批准", untitled: "未命名会话" },
};

/**
 * Tell the user an agent needs them: a system notification and an in-app notice.
 * The in-app notice always goes out: a system notification can report "shown" and still never
 * appear (notifications off or never allowed for PI-Desktop, Focus mode), and it is easy to miss
 * while you work in PI-Desktop. Each attempt is logged (plugin.stdio in the plugin log), because
 * the host does not log notification calls.
 */
async function notifyNeed(agent) {
  if (!notifyOn) return;
  const lang = await Promise.resolve(pi.app?.getLocale?.()).catch(() => "");
  const L = str(lang).toLowerCase().startsWith("zh") ? NOTE.zh : NOTE.en;
  const kind = agent.question ? "question" : agent.reply ? "reply" : agent.plan?.kind === "goal" ? "goal" : "plan";
  const title = L[kind].replace("{title}", clipText(agent.title || L.untitled, 60));
  const body = clipText(str(agent.question?.q || agent.reply || agent.plan?.title || agent.plan?.question || agent.desc).replace(/\s+/g, " ").trim(), 180);
  let system;
  try {
    const r = await pi.ui.showNativeNotification({ title, body });
    system = r?.shown ? "shown" : `not shown (${str(r?.permission) || "unknown"})`;
  } catch (error) {
    system = `failed (${str(error?.code || error?.message) || "error"})`;
  }
  let notice;
  try {
    await pi.ui.notify({ title, body });
    notice = "shown";
  } catch (error) {
    notice = `failed (${str(error?.code || error?.message) || "error"})`;
  }
  try { console.log(`notify ${kind} for session ${agent.id}: system ${system}, in-app ${notice}`); } catch { /* logging is best-effort */ }
}

function maybeReveal({ becameRunning, newSubagent, needsYouNow }) {
  const want =
    (autoOpen === "working" && (becameRunning || newSubagent || needsYouNow)) ||
    (autoOpen === "subagents" && newSubagent) ||
    (autoOpen === "attention" && needsYouNow);
  // something needing you always gets through; the cooldown only damps "started working"
  if (!want || (!needsYouNow && Date.now() - lastReveal < REOPEN_COOLDOWN_MS)) return;
  lastReveal = Date.now();
  pi.ui.revealView({ viewId: VIEW_ID }).catch(() => {});
}

async function loop() {
  if (stopped) return;
  if (inFlight) { rerun = true; return; } // never two polls at once
  clearTimeout(timer);
  inFlight = true;
  let busy = false;
  try {
    busy = await poll();
  } catch (error) {
    model = { ...model, error: String(error?.message ?? error) };
  } finally {
    inFlight = false;
  }
  if (stopped) return;
  if (rerun) { rerun = false; timer = setTimeout(loop, 0); return; }
  timer = setTimeout(loop, busy ? FAST_MS : SLOW_MS);
}
function pollSoon() {
  if (stopped) return;
  listAt = 0;
  if (inFlight) { rerun = true; return; }
  clearTimeout(timer);
  timer = setTimeout(loop, 150);
}

// ---------- actions from the drawer ----------
async function act({ action, sessionId, text, proposal, decision }) {
  const id = str(sessionId);
  if (!id) return { ok: false, message: "sessionId required" };
  switch (action) {
    case "open":
      await op("session/open", [id]);
      return { ok: true };
    case "send": {
      const t = str(text).trim();
      if (!t) return { ok: false, message: "empty message" };
      await op("agent/prompt", [{ sessionId: id, content: t }]);
      // your reply answers the agent's question: it is working again, not waiting for you
      settle(id, { reply: null, status: "run" });
      return { ok: true };
    }
    case "plan": {
      const p = proposal ?? {};
      const approve = decision === "approve";
      if (!str(p.proposalId) || !str(p.turnId) || !str(p.toolCallId)) return { ok: false, code: "not_pending", message: "This approval is no longer pending" };
      // approving runs the plan in the permission mode the session already has
      const mode = sessionList.find((s) => s.id === id)?.permissionMode;
      await op("plans/resolve", [{
        proposalId: str(p.proposalId), sessionId: id, turnId: str(p.turnId), toolCallId: str(p.toolCallId),
        action: approve ? "approve" : "reject",
        ...(typeof p.version === "number" ? { version: p.version } : {}),
        ...(approve ? { targetPermissionMode: PERMISSION_MODES.includes(mode) ? mode : "ask" } : {}),
      }], true);
      settle(id, { plan: null, status: approve ? "run" : "done" });
      return { ok: true };
    }
    case "stop":
      await op("agent/stop", [{ sessionId: id }]);
      return { ok: true };
    case "abort":
      await op("agent/abort", [{ sessionId: id }]);
      return { ok: true };
    default:
      return { ok: false, message: `unknown action: ${action}` };
  }
}

const PERMISSION_MODES = ["ask", "accept-edits", "auto"];

/** Reflect an action in the model at once; the next poll confirms it. */
function settle(id, patch) {
  model = { ...model, agents: model.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) };
  const mem = memory.get(id);
  if (mem) memory.set(id, { ...mem, attention: "", seenReply: "", planKey: "", agent: undefined });
}

async function onPanelInvoke(channel, payload) {
  try {
    if (channel === "radar.state") return { ok: true, model };
    if (channel === "radar.action") {
      const result = await act(payload ?? {});
      pollSoon();
      return result;
    }
    return { ok: false, message: `unknown channel: ${channel}` };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error), code: error?.code };
  }
}

// ---------- lifecycle ----------
async function readSettings() {
  try {
    const s = await pi.plugin.getSettings();
    if (["working", "subagents", "attention", "off"].includes(s?.autoOpen)) autoOpen = s.autoOpen;
    if (typeof s?.notify === "boolean") notifyOn = s.notify;
  } catch {
    /* keep the default */
  }
}

const onSettings = () => { void readSettings(); };

async function onLoad() {
  stopped = false;
  firstPoll = true;
  timer = setTimeout(loop, 800);
  await readSettings();
  pi.events.on("plugin:settingsChanged", onSettings);
  pi.events.on("session:turnEnded", pollSoon);
  pi.events.on("session:activated", pollSoon);
  try {
    await pi.commands.register({
      id: "neural-radar.open",
      title: "Neural Radar: Open",
      keywords: ["radar", "agents", "subagents"],
      run: async () => { await pi.ui.revealView({ viewId: VIEW_ID }); },
    });
  } catch {
    /* the radar still works without the command */
  }
}

async function onUnload() {
  stopped = true;
  clearTimeout(timer);
  pi.events.off("plugin:settingsChanged", onSettings);
  pi.events.off("session:turnEnded", pollSoon);
  pi.events.off("session:activated", pollSoon);
  await pi.commands.unregister("neural-radar.open").catch(() => {});
}

module.exports = { onLoad, onUnload, onPanelInvoke };
