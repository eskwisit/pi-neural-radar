# Neural Radar

A live neural map of your PI-Desktop agents and their subagents, shown in the session's work panel.

![Neural Radar: your circle with your picture at the centre; two agents that need you, one asking a question (its drawer open on the right, with the question and its answers) and one waiting for your reply, both with opaque tooltips, and a plan awaiting approval; a working agent with 3 subagents and a working goal with 2; the explorer subagent of the open agent, done; a finished agent at the edge; tooltips showing what each agent works on now, its state, running subagents, tool context and how long ago](docs/neural-radar.webp)

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
- **Finished subagents fade away.** A subagent that is done or stopped stays on the radar for 2
  seconds, fades out over 1.5 seconds, and the rest of the fan closes up. The drawer's
  **Subagents** section still lists it.
- **Every agent shows its tooltip.** The first line is what it works on now: the first line of
  your latest prompt that names a topic, so it follows the session when it changes subject (short
  go-aheads like "ok" or "build it" are skipped). The second line is its state, the number of
  subagents running for it (when there are any), the tokens its own tool calls added to its context
  (an estimate from their size), and how long ago it last did something, e.g.
  `Working · 2 subagents · 12.4K tokens · 12s ago`. The tooltip of an agent that needs you fades
  to a fully opaque background, and back once it no longer waits. The hovered agent's tooltip, and then the open one's, are drawn on top. A subagent's tooltip
  shows only while its agent's cluster is open in the drawer, and reads as its role (`explorer`,
  `fixer`, …) with the task it was given.
- **Distance means attention:** an agent waiting for you sits on the inner ring (it asks you a
  question, waits for permission to run a tool, ended its turn with a question for you, or a plan
  waits for approval), working agents further out, finished
  ones at the edge. An agent keeps its own direction from you for
  life; it only moves closer or further away.
- **New empty sessions stay off the radar.** A session with no message yet (PI-Desktop's
  "New task") appears once it has something to show.
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

When an agent starts needing you (it opens a question card, asks permission to run a tool, ends
its turn with a question, or a Plan or Goal waits for approval), the radar shows a system notification with the session name and
what it asks, and PI-Desktop shows the same text as an in-app notice. The in-app notice always
goes out, because macOS can accept a system notification and still not show it (notifications off
or never allowed for PI-Desktop, Focus mode). Each attempt is written to the plugin log. You get one notification each time an agent
starts needing you, not one per poll, and none for agents that already waited when the radar
started. Clicking the notification brings PI-Desktop to the front; it does not switch session.
Turn it off with **Notify me when an agent needs me** (Plugins → Neural Radar → Settings).

## Your picture

You are a 36 px circle with a 3 px white border, without a label. Hovering it darkens it and shows
a pencil. **Click your circle** to pick
a picture (PNG, JPEG, GIF or WebP): its middle square is cut out, shrunk to 128 px and kept in the
plugin's data folder (`avatar.json`), so it survives restarts. Click again to pick another one;
**right-click your circle** to remove the picture and its file. With no picture, the circle shows a
glowing neuron core.

## Stepping in

Click an agent (its neuron or its tooltip) to open its drawer; click its neuron again to close it. While the
drawer is open, the radar slides so the agent and its subagents sit in the middle of the space the
drawer leaves visible, however far they are from you.

The top of the drawer stays put: the session name (on one line, cut short with "…" when it is long),
your latest prompt, its state, its model and effort (thinking level), and the actions below. Each
subagent in **Subagents** shows its model and effort when its launch reports them, and the tokens its transcript reports so far, marked `≥`: a lower bound, since
the host does not record every model call of a subagent in the transcript.
**Activity** lists the text of the chat session: your messages, the agent's replies and the questions it asked you; tool calls and commands are left out. **Subagents** and **Activity** fold
open beneath it; an open one scrolls inside itself, so the drawer never scrolls. Opening the
drawer from a subagent unfolds Subagents on it. The drawer offers:

- **Answer** a question card the agent opened mid-turn: the agent shows **Question for you** in
  amber, and the drawer asks one question at a time (`1 of 3`, with a numbered step per question).
  Picking the answer to a single-choice question moves on to the next one; **Next**, **Back** or a
  step number move between them, and **Answer** on the last one sends them all. You can type your
  own answer instead, or **Decline** the card
- **Allow once / Allow for this chat / Deny** a tool waiting for your permission; the drawer shows
  the tool, its risk, the reason and the arguments, and which subagent asks
- Answering a question card and answering a permission prompt go through PI-Desktop's own
  confirmation: it asks you to allow each one before it reaches the agent. Both need PI-Desktop
  0.23 or later; on an older version the drawer shows the question and sends you to the session
- **Reply**: when an agent ended its turn asking you something, the drawer shows what it asked and
  your reply goes straight to it
- **Approve / Reject** a Plan or Goal that is waiting for you. Approving runs it in the session's
  current permission mode
- **Send to agent** (⌘↵): an idle or finished agent gets the message at once and the session
  continues (the box is titled **Continue the session** on a finished one). A running agent cannot
  take a new turn, so the message waits in a queue shown under the box and goes out when the turn ends, one per
  turn. A notice says whether it was sent or queued and the drawer stays open; if the message is
  not taken, your text comes back in the box. A notice also tells you when a queued message goes
  out. The queue lives in the plugin: it is lost when the plugin reloads
- **Open session**, **Stop** (at the next safe point) and **Abort** (now); Stop and Abort ask for a
  second click

## Permissions

| Permission | Why |
|---|---|
| `ui.view` | the radar view in the work panel, and opening it automatically |
| `desktop.control` | reading sessions, agent status, subagents, pending plans, question cards and permission prompts; switching session, sending a message, approving a plan, answering a question card or permission prompt, stopping an agent |
| `notify` | a system notification and an in-app notice when an agent needs you |

`desktop.control` is a high-risk permission: it lets the plugin act on your sessions. The plugin only
acts on a session when you click a button in the drawer; everything else it does is read-only,
apart from opening its own view as set in **Open the radar automatically**. It has no network
access; the only file it writes is your picture (see [Your picture](#your-picture)), and it stores
nothing besides its settings and that picture.

### What it can and cannot do

It **can**:

- read your recent sessions: their titles, agent status, the last 60 messages of each
  transcript, subagents, pending Plan / Goal approvals, open question cards and tool permission
  prompts. This is shown only in the radar view, on
  your machine
- when you click: open a session, send the text you typed to the agent, approve or reject the plan
  shown in the drawer, answer or decline the question card shown in the drawer, allow or deny the
  tool shown in the drawer, or stop or abort an agent. Stop and Abort need a second click within
  3 seconds; answers and permission decisions also need your OK in PI-Desktop's own dialog
- open its own view in the work panel when an agent starts working or needs you (setting
  **Open the radar automatically**, which can be turned off)
- save the picture you pick by clicking your circle in its data folder; right-clicking your
  circle removes it

It **cannot** and does not:

- access the network or read files other than its own picture file: nothing it reads from your
  sessions leaves your computer
- write files, except your picture (`avatar.json` in its data folder), run programs or load
  code
- act on a session without your click, or change a session's permission mode (approving a plan keeps the session's
  own mode, or uses "ask"). A message you send to a busy agent waits in a queue and goes out when
  its turn ends
- store anything besides its settings and your picture

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
- **Question cards and permission prompts need PI-Desktop 0.23 or later.** The radar reads them
  with `agent/pendingInteractive` while an agent runs (no event tells plugins about them, so they
  show within one poll, about 2 s). On an older PI-Desktop, which lacks that operation, a question
  card is read from the transcript and can only be answered in the session, and permission
  prompts are not visible at all. The drawer shows one question card and one permission prompt
  per session at a time, the oldest first; the next one follows once it is answered.
- Per-subagent stop is not available to plugins; Stop and Abort act on the whole agent.
- The radar polls (every 2 s while an agent runs, every 6 s otherwise) because the host sends
  plugins no "turn started" event. The view refreshes every second while shown and every 5 s
  while the work panel hides it.
- **Updates.** PI-Desktop loads the updated plugin at once, but keeps an open radar view's old page
  running. The view sees the new version in the plugin's state and reloads itself (it waits
  while you type a message in the drawer). This works from 0.37.0 on: the update *to* 0.37.0
  still needs the radar view closed (disable and enable the plugin) or PI-Desktop restarted.

## Development

The plugin has no build step and no dependencies. Run the tests with Node 20 or later:

```bash
node --test tests/
```

The tests load `main.js` with a fake PI-Desktop host and cover the transcript reading, the drawer
actions, denied permissions and failing host calls, and clean unloading.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
