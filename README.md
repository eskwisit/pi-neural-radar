# Neural Radar

A live neural map of your PI-Desktop agents and their subagents, shown in the session's work panel.

![Neural Radar: You at the centre; an agent waiting for your reply and a plan awaiting approval on the inner ring; a working agent and a working goal with their explorer, fixer, test-runner, code-reviewer and ui-designer subagents; a finished agent at the edge; the drawer of the waiting agent open on the right](docs/neural-radar.png)

- **You** sit at the centre. Each agent (a session) is a cluster of neurons; its subagents are the
  small clusters behind it. The You label counts the agents waiting on you, or reads **Idle**, and
  the centre is not clickable.
- **One agent is you.** When a single agent with no subagents is on the radar, it merges into the
  centre node: the You label shows its status and task instead. An
  agent with subagents keeps its own cluster (you → agent → subagents), and so does a second agent.
- **Subagent fans widen.** Behind an agent with more than 3 subagents, the fan opens wider and
  further out so up to 6 subagents stay readable, and the agent stays far enough from the edge.
- **Hover an agent for its tooltip.** The first line is your latest prompt, the second its
  subagents and its state (Working, Awaiting approval, …). A subagent reads as its role
  (`explorer`, `fixer`, …) with the task it was given.
- **Distance means attention:** an agent waiting for you sits on the inner ring (its turn ended
  with a question for you, or a plan waits for approval), working agents further out, finished
  ones at the edge. An agent keeps its own direction from you for
  life; it only moves closer or further away.
- **Signals** run along the mesh: pink/amber toward you when something needs you, teal for
  progress, lilac from you when you act, blue when an agent hands a task to a subagent.

## Opening automatically

Setting **Open the radar automatically** (Plugins → Neural Radar → Settings):

| Value | Opens when |
|---|---|
| Whenever an agent starts working *(default)* | a session starts a turn, launches a subagent, or needs you |
| When an agent launches subagents | a new subagent starts |
| Only when an agent needs me | an agent waits for your reply, or a plan waits for approval |
| Never | only from the command **Neural Radar: Open** |

## Stepping in

Click an agent (its neuron, its tooltip or its chip in the top bar) to toggle its drawer. While the
drawer is open, the radar slides so the agent and its subagents sit in the middle of the space the
drawer leaves visible, however far they are from you. The drawer offers:

- **Reply**: when an agent ended its turn asking you something, the drawer shows what it asked and
  your reply goes straight to it
- **Approve / Reject** a Plan or Goal that is waiting for you. Approving runs it in the session's
  current permission mode
- **Send to agent**: a message delivered to the running agent
- **Pre-fill in session**: switch to the session and offer your text in its composer
- **Open session**, **Stop** (at the next safe point) and **Abort** (now); Stop and Abort ask for a
  second click

## Permissions

| Permission | Why |
|---|---|
| `ui.view` | the radar view in the work panel, and opening it automatically |
| `desktop.control` | reading sessions, agent status, subagents and pending plans; switching session, sending a message, approving a plan, stopping an agent |
| `composer.suggest` | offering your text in the session composer ("Pre-fill in session") |

`desktop.control` is a high-risk permission: it lets the plugin act on your sessions. The plugin only
acts on a session when you click a button in the drawer; everything else it does is read-only,
apart from opening its own view as set in **Open the radar automatically**. It has no network
access and stores nothing besides its settings.

### What it can and cannot do

It **can**:

- read your recent sessions: their titles, agent status, the last 60 messages of each transcript,
  subagents and pending Plan / Goal approvals. This is shown only in the radar view, on your machine
- when you click: open a session, send the text you typed to the agent, put your text in a
  session's composer (you still send it), approve or reject the plan shown in the drawer, or stop
  or abort an agent. Stop and Abort need a second click within 3 seconds
- open its own view in the work panel when an agent starts working or needs you (setting
  **Open the radar automatically**, which can be turned off)

It **cannot** and does not:

- access the network, so nothing it reads leaves your computer
- read or write files, run programs or load code
- act on a session without your click, answer an agent's mid-turn question cards or tool
  permission prompts, or change a session's permission mode (approving a plan keeps the session's
  own mode, or uses "ask")
- store anything besides its setting

Details for reviewers, including every host operation it calls, are in
[docs/security-review.md](docs/security-review.md).

## Known limits

- **"Needs your reply" is read from the transcript.** An agent counts as waiting for you when its
  turn is over, its last message is its own, and that message's closing paragraph asks you
  something (it ends with a question, or says things like "should I", "let me know", "please
  confirm"; code, tables and headings are ignored).
- **How long things stay.** A finished agent fades out 10 minutes after its last activity. An
  agent waiting for your reply stays up to 2 hours, or until you open its session and leave it
  without replying: then it counts as finished. Subagents from an earlier turn only stay while
  they are still running.
- **Question cards asked mid-turn (`asktool`) and tool-permission prompts are not visible.**
  PI-Desktop lets plugins answer them (`agent/askTool/resolve`, `tool/resolvePermission`), but
  the request ids those need only come from `agent/pendingInteractive`, which is not a plugin
  operation, and a pending tool call only reaches the transcript once it completes. The radar
  therefore sees such a question only after it was answered. Plan and Goal approvals, and
  questions asked in an agent's final message, are detected and answered from the radar.
- Per-subagent stop is not available to plugins; Stop and Abort act on the whole agent.
- The radar polls (every 2 s while an agent runs, every 6 s otherwise) because the host sends
  plugins no "turn started" event. The view refreshes every second while shown and every 5 s
  while the work panel hides it.

## Development

The plugin has no build step and no dependencies. Run the tests with Node 20 or later:

```bash
node --test tests/
```

The tests load `main.js` with a fake PI-Desktop host and cover the transcript reading, the drawer
actions, denied permissions and failing host calls, and clean unloading.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
