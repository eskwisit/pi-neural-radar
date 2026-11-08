# Neural Radar

A live neural map of your PI-Desktop agents and their subagents, shown in the session's work panel.

![Neural Radar: You at the centre with 3 agents waiting on you; an agent asking a question (its drawer open on the right, with the question and its answers), an agent waiting for your reply and a plan awaiting approval; a working agent with explorer, fixer and test-runner subagents and a working goal with ui-designer and code-reviewer; a finished agent fading at the edge; tooltips showing what each agent works on now, its state, the tool context and how long ago](docs/neural-radar.webp)

- **You** sit at the centre, as a circle with your picture (see [Your picture](#your-picture)).
  Each agent (a session) is a cluster of neurons; its subagents are the small clusters behind it.
- **Every agent has its own cluster**, also when it is the only one on the radar: you → agent →
  subagents.
- **Subagents stay with their main agent.** Each turn (your message and everything the agent does
  after it, its short notes between tool calls included) is one main agent. The subagents of the
  latest turn fan around the session's own cluster. When subagents of an earlier turn still run,
  that turn gets its own main-agent cluster next to its session, with a link to it, and its
  subagents fan around it. Its drawer shows your message of that turn, its subagents and its
  activity. To send a message to it or stop it, open the session.
- **Subagent fans widen.** Behind an agent with more than 3 subagents, the fan opens wider and
  further out so up to 6 subagents stay readable, and the agent stays far enough from the edge.
- **Every agent shows its tooltip.** The first line is what it works on now: the first line of
  your latest prompt that names a topic, so it follows the session when it changes subject (short
  go-aheads like "ok" or "build it" are skipped). The second line is its state, the number of
  subagents running for it (when there are any), the tokens its own tool calls added to its context
  (an estimate from their size), and how long ago it last did something, e.g.
  `Working · 2 subagents · 12.4K tokens · 12s ago`. The hovered agent's tooltip, and then the open one's, are drawn on top. A subagent's tooltip
  shows only while its agent's cluster is open in the drawer, and reads as its role (`explorer`,
  `fixer`, …) with the task it was given.
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

## Notifications

When an agent starts needing you (it ends its turn with a question, waits for your reply, or a
Plan or Goal waits for approval), the radar shows a system notification with the session name and
what it asks, and PI-Desktop shows the same text as an in-app notice. The in-app notice always
goes out, because macOS can accept a system notification and still not show it (notifications off
or never allowed for PI-Desktop, Focus mode). Each attempt is written to the plugin log. You get one notification each time an agent
starts needing you, not one per poll, and none for agents that already waited when the radar
started. Clicking the notification brings PI-Desktop to the front; it does not switch session.
Turn it off with **Notify me when an agent needs me** (Plugins → Neural Radar → Settings).

## Your picture

You are a 36 px circle with a 3 px white border, without a label; it is not clickable. Set the
picture in Plugins → Neural Radar → Settings:

- **Your picture in the radar**: the full path of an image file (PNG, JPEG, GIF or WebP, up to
  2 MB; `~/` works) or an https image URL.
- **Gravatar email**: used when no picture is set.

The picture is read or downloaded once and cached in the plugin's data folder (`avatar.json`), so
it survives restarts and needs no network afterwards; changing the setting replaces it. Clear the
setting to remove the picture and its cache. With no picture (or an address without a Gravatar),
the circle shows a glowing neuron core.

## Stepping in

Click an agent (its neuron or its tooltip) to toggle its drawer. While the
drawer is open, the radar slides so the agent and its subagents sit in the middle of the space the
drawer leaves visible, however far they are from you.

The top of the drawer stays put: the session name (on one line, cut short with "…" when it is long),
your latest prompt, its state, its model and effort (thinking level), and the actions below. Each
subagent in **Subagents** shows its model and effort when its launch reports them, and the tokens its transcript reports so far, marked `≥`: a lower bound, since
the host does not record every model call of a subagent in the transcript.
**Activity** lists the text of the chat session: your messages, the agent's replies and the questions it asked you; tool calls and commands are left out. **Subagents** and **Activity** fold
open beneath it; an open one scrolls inside itself, so the drawer never scrolls. Opening the
drawer from a subagent unfolds Subagents on it. The drawer offers:

- **Reply**: when an agent ended its turn asking you something, the drawer shows what it asked and
  your reply goes straight to it
- **Approve / Reject** a Plan or Goal that is waiting for you. Approving runs it in the session's
  current permission mode
- **Send to agent** (⌘↵): an idle agent gets the message at once. A running agent cannot take a new
  turn, so the message waits in a queue shown under the box and goes out when the turn ends, one per
  turn. The drawer says whether it was sent or queued, and a notice tells you when a queued message
  goes out. The queue lives in the plugin: it is lost when the plugin reloads
- **Open session**, **Stop** (at the next safe point) and **Abort** (now); Stop and Abort ask for a
  second click

## Permissions

| Permission | Why |
|---|---|
| `ui.view` | the radar view in the work panel, and opening it automatically |
| `desktop.control` | reading sessions, agent status, subagents and pending plans; switching session, sending a message, approving a plan, stopping an agent |
| `notify` | a system notification and an in-app notice when an agent needs you |

`desktop.control` is a high-risk permission: it lets the plugin act on your sessions. The plugin only
acts on a session when you click a button in the drawer; everything else it does is read-only,
apart from opening its own view as set in **Open the radar automatically**. It has no network
access and stores nothing besides its settings.

### What it can and cannot do

It **can**:

- read your recent sessions: their titles, agent status, the last 60 messages of each
  transcript, subagents and pending Plan / Goal approvals. This is shown only in the radar view, on
  your machine
- when you click: open a session, send the text you typed to the agent, approve or reject the plan
  shown in the drawer, or stop or abort an agent. Stop and Abort need a second click within 3 seconds
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
- **Question cards asked mid-turn (`asktool`) and tool-permission prompts (a command waiting for
  your approval) are not visible.** PI-Desktop lets plugins answer them (`agent/askTool/resolve`,
  `tool/resolvePermission`), but the request ids those need only come from
  `agent/pendingInteractive`, which is not a plugin operation. Plugins get no event for them,
  `agent/getStatus` reports no pending confirmation for local sessions, and a pending tool call
  only reaches the transcript once it completes. The radar
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
