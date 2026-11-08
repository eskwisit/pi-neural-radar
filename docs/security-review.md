# Neural Radar: security review notes

Material for the PI-Desktop plugin center review ([SECURITY.md], "Review procedure", step 8).
Plugin `eskwisit.neural-radar`, version 0.6.0 (unreleased). Everything here was checked against
`main.js`, `views/index.html` and `manifest.json` in this repository. Functions are named rather
than given line numbers so the notes stay correct while the code changes.

## Summary

| | |
|---|---|
| Risk tier | **High**, because the plugin requests `desktop.control` |
| Runtime files | `manifest.json`, `main.js`, `views/index.html`, `README.md`, `LICENSE` |
| Dependencies | none (no `package.json`, no vendored, generated, minified or native code) |
| Network | none. From 0.37.0 the plugin makes no requests (0.34.0 downloaded the picture set in the settings) |
| File system | only for your picture: reads, writes and deletes `avatar.json` in `pi.plugin.getDataPath()`, and reads its own `manifest.json` (next to `main.js`) once at load for its version |
| Process execution | none |
| Dynamic code | none (no `eval`, `new Function`, dynamic `import()`, remote `<script>` or `<link>`) |
| Persistence | the settings (`autoOpen`, `notify`), which the host keeps (declared in `contributes.settings`); the plugin only reads them. Your picture `avatar.json` (a data URL) in the plugin's data folder, written when you pick a picture by clicking your circle and deleted when you right-click it. Queued messages live in memory only |
| Data leaving the machine | none |
| Required reviewers | two independent maintainers (to be named on the plugin center) |

## Risk tier

SECURITY.md lists `desktop.control` in the High tier. With it, the plugin can read every recent
session's transcript and act on sessions: open one, send a message to the agent, approve or reject
a plan, and stop or abort a turn. The plugin only reads on its own. Every acting operation starts
from a click in its drawer, and the stop, abort and plan actions add an extra confirmation (see
below). The review still has to treat it as High: the tier is about capability, not intent.

## Permissions matrix

| Permission | Used for | Host calls | Where |
|---|---|---|---|
| `ui.view` | The radar view docked in the work panel, which opens automatically according to the `autoOpen` setting or from the command | `pi.ui.revealView({ viewId: "radar" })` | `maybeReveal()` (automatic, after the first poll only, with a 30 s cooldown on "started working"), and the `neural-radar.open` command registered in `onLoad()` |
| `desktop.control` | **Read:** session list, agent status, transcripts, subagents (read from the transcript), pending plans | `pi.desktop.invoke` with `session/list`, `agent/getStatus`, `session/get` (`messageLimit: 60`), `plans/pending` | `poll()` |
| | **Act, only on a click in the drawer:** | `session/open` | `act()` with action `open` |
| | | `agent/prompt` | `act()` with action `send` |
| | | `agent/stop`, `agent/abort` | `act()` with action `stop` or `abort` (two-step confirmation in the view) |
| | | `plans/resolve` **sent with `confirm: true`** | `act()` with action `plan` (Approve or Reject) |

Host APIs called without a permission of their own (base plugin API, as far as the author knows; a
reviewer should confirm this against host policy):

| Call | Purpose | Where | On failure |
|---|---|---|---|
| `pi.session.getActive()` | Which session is in front, used to highlight it and keep it watched | `poll()` | `.catch(() => null)`: treated as "no active session" |
| `pi.plugin.getSettings()` | Reads `autoOpen` (only `working`, `subagents`, `attention` and `off` are accepted) and `notify` | `readSettings()` | The defaults are kept |
| `pi.plugin.getDataPath()` | The folder of your picture `avatar.json` | `avatarFile()` | No file: a picked picture lasts until the plugin reloads |
| `pi.commands.register()` / `unregister()` | The `neural-radar.open` command (declared in `contributes.commands`) | `onLoad()` / `onUnload()` | Ignored; the radar works without it |
| `pi.events.on()` / `off()` | `plugin:settingsChanged`, `session:turnEnded`, `session:activated` | `onLoad()` / `onUnload()` | none |

The view (`views/index.html`) also calls the host bridge directly: `window.pluginBridge.invoke`
with `radar.state`, `radar.me` (your picture, asked only when its key in the state changes), `radar.setMe` (saves or, with an empty string, removes your picture) and `radar.action` (answered by `onPanelInvoke()`), `app.getAppearance`, and
`pluginBridge.on("appearance:changed")`. The last two only read the UI locale.

### No `composer.suggest`

The plugin does not declare `composer.suggest`. The "Pre-fill in session" button and the `prefill`
action were removed so that the manifest uses only permissions the audit knows. `act()` answers
`prefill` with `unknown action`; `tests/actions.test.js` checks that it calls nothing.

## Capability / data-flow matrix

| Action | Source entry | Data read | Destination | Permission | User action / confirmation | Bounds | Cleanup |
|---|---|---|---|---|---|---|---|
| Poll the session list | `poll()` ← `loop()` | `session/list`: id, title, updatedAt, model, permissionMode | In-memory `sessionList` | `desktop.control` | none (read-only) | Refreshed at most every 10 s (`LIST_MS`) or after a host event; sessions untouched for 6 h are skipped (`STALE_MS`) | `onUnload()` stops the loop |
| Read agent status | `poll()` | `agent/getStatus`: isRunning, pendingPlanId, planningState, modelId | In-memory model | `desktop.control` | none | 8 most recent sessions (`CANDIDATES`), plus the active one and any that is running, waiting for you or has a pending plan | same |
| Read transcripts | `poll()` | `session/get` with `messageLimit: 60` | In-memory model → view (`radar.state`) | `desktop.control` | none | 60 messages per session. An idle session is re-read only after it changed. Excerpts: task 220 chars, label 48, asked question 320, context 280, activity lines 140, at most 12 activity entries | same |
| Read pending plans | `poll()` | `plans/pending` (`[{}]` once per poll; `[{ sessionId }]` when a status reports a plan the global read missed) | In-memory model → view | `desktop.control` | none | one global read per poll | same |
| Show the radar | view `pull()` → `onPanelInvoke("radar.state")` | the model above | the plugin's own view, rendered with `esc()` | `ui.view` | none | view pulls every 1 s while shown, every 5 s while hidden | view timers end with the webview; the main side holds no handle to the view |
| Open the view automatically | `maybeReveal()` | the setting `autoOpen` | `pi.ui.revealView` | `ui.view` | Setting **Open the radar automatically** (`off` disables it) | never on the first poll; 30 s cooldown for "started working" (`REOPEN_COOLDOWN_MS`) | none needed |
| Your picture | view: click your circle → file picker → `shrinkMe()` (middle square, 128 px) → `radar.setMe` → `saveAvatar()` | the image file you pick in the system file dialog; the plugin never sees its path | `avatar.json` → view (`radar.me`), drawn in a canvas circle | none | click to set, right-click to remove | only a base64 PNG, JPEG, GIF or WebP data URL up to 2 MB is saved; anything else is refused and the current picture kept | right-click deletes the file |
| Open a session | drawer **Open session** → `act({ action: "open" })` | sessionId | `session/open` | `desktop.control` | one click | one call | none |
| Send a message to the agent | drawer **Send to agent** or Ctrl/⌘+Enter → `act({ action: "send" })` | the text the user typed | `agent/prompt` `{ sessionId, content }`; to a running agent (or on `AGENT_BUSY`) the text waits in an in-memory queue (at most 20 per session) and is sent by `poll()` when the turn ends | `desktop.control` | one click; empty text is refused | one call | none |
| Approve or reject a plan | drawer **Approve** / **Reject** → `act({ action: "plan" })` | the proposal ids shown in the drawer | `plans/resolve` with **`confirm: true`** | `desktop.control` | one click on a visible, specific plan. Refused when `proposalId`, `turnId` or `toolCallId` is missing | one call. Approve uses the session's own permission mode when it is `ask`, `accept-edits` or `auto`, and `ask` otherwise; Reject sends no mode | none |
| Stop a turn | drawer **Stop**, then **Confirm stop** → `act({ action: "stop" })` | sessionId | `agent/stop` | `desktop.control` | **two clicks within 3 s**; disabled while the agent is finished or waiting for your reply | one call; the whole agent (no per-subagent stop) | none |
| Abort a turn | drawer **Abort**, then **Confirm abort** → `act({ action: "abort" })` | sessionId | `agent/abort` | `desktop.control` | **two clicks within 3 s**; disabled as for Stop | one call | none |
| React to host events | `pi.events.on` → `pollSoon()` / `readSettings()` | none | schedules a poll 150 ms later, or re-reads the setting | none | none | at most one poll in flight (`inFlight`, `rerun`) | `onUnload()` calls `pi.events.off` with the same handlers |
| Polling timer | `onLoad()` → `loop()` | none | `setTimeout(loop, …)` | none | none | first poll after 0.8 s; then every **2 s** while an agent runs (`FAST_MS`), **6 s** otherwise (`SLOW_MS`) | `onUnload()` sets `stopped` and clears the timer; a poll still in flight does not reschedule |

### Untrusted text

Transcript text (agent messages, questions, plan titles, subagent descriptions, tool names) is
data, never code. `main.js` only cuts it into excerpts. The view renders every interpolated value
through `esc()` (escapes `& < > "`) inside double-quoted attributes or element text. The only
unescaped interpolations are fixed values: status colours from a constant map and formatted clock
times. Nothing from the transcript reaches `eval`, an event-handler attribute, a URL or a host
operation. Text goes back to the host only when the user explicitly sends or pre-fills it.

### Timers flagged as "persistent activation/timer"

The audit reports the `setInterval` in `views/index.html`. The same pattern also covers the
manifest's `activationEvents: ["onStartup"]`; that was not reported in this run, but it is explained
here as well.

- `onStartup` is needed because the host gives plugins no "turn started" event. The radar has to
  watch from startup to open itself when an agent starts working. It does not install a service,
  startup task or anything outside PI-Desktop. It runs only while PI-Desktop runs and the plugin
  is enabled.
- `main.js` uses a single `setTimeout` chain (`loop()`), never `setInterval`. Each poll schedules
  the next one: 2 s while an agent runs, 6 s otherwise. `onUnload()` stops it (see the tests).
- `views/index.html` runs a 250 ms `setInterval` that redraws the animation when Chromium pauses
  `requestAnimationFrame` for a docked webview. It returns at once while the view has no size
  (hidden panel). Its `radar.state` pull runs every 1 s while shown and every 5 s while hidden.
  Both belong to the webview and end with it.

### Confirmations

- **Stop / Abort:** the first click only arms the button (it turns into **Confirm stop** /
  **Confirm abort**) and disarms itself after 3 s (`armed` map in the view). Only a second click
  within that window sends `agent/stop` or `agent/abort`. The confirmation is in the view;
  `act()` itself does not ask again, and it can only be reached through the plugin's own view
  (`radar.action`).
- **Plan approval:** `plans/resolve` is the only operation the host treats as dangerous, so `op()`
  sends it with `confirm: true`. The user's click on **Approve** or **Reject** for the specific plan
  shown in the drawer is the confirmation. Approving never escalates: it keeps the session's own
  permission mode and falls back to `ask` for any unknown mode.
- Send and Open session are single, visible clicks. They act only on the session whose
  drawer is open.

## Negative paths (tests)

`node --test tests/` (Node ≥ 20, no dependencies) loads `main.js` with a fake `pi` and covers:

- host operations rejecting, including a permission error (`PERMISSION_DENIED`) on
  `desktop.control`, and a rejected `pi.session.getActive`, `pi.ui.revealView`,
  `pi.commands.register`/`unregister` and `pi.plugin.getSettings`. None of these throw out of
  `onPanelInvoke`, the poll loop, `onLoad` or `onUnload`. Action errors come back as
  `{ ok: false, message, code }`; poll errors become `model.error`, which the view shows.
- malformed host answers (`null`, numbers, strings, wrong shapes, null entries) and malformed
  transcripts;
- invalid input: missing `sessionId`, unknown action or channel, empty message, incomplete plan
  proposal. None of them reaches the host;
- bounds: 8 candidate sessions plus the active one, `messageLimit: 60`, 6-hour staleness, excerpt
  lengths. A poll only sends read operations;
- `plans/resolve` carries `confirm: true`; the permission mode never escalates;
- unload: the same event handlers are removed, the command is unregistered, and no timer is left
  behind, even when a poll was in flight or an event or action arrives after unload.

## Findings and mitigations

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `act("prefill")` ignored a failed `composer.suggest` (`.catch(() => null)`) and returned `ok: true`, so a denied permission still showed "Suggested in the session composer" | Low (misleading feedback, no safety impact) | Fixed in 0.6.0; the `prefill` action was removed later with `composer.suggest` |
| 2 | The view calls `pluginBridge.invoke("app.getAppearance")`. If the host does not handle `app.*` channels itself, the call reaches `onPanelInvoke`, which answers `{ ok: false, message: "unknown channel: …" }`; the view then falls back to `navigator.language` | Info | Needs confirmation of the host bridge behaviour |
| 3 | Some transcript strings are not length-capped in `main.js`: the asktool question and options, plan title and question, subagent description, tool names. They are bounded only by `messageLimit: 60`, and the view escapes them | Info | Accepted |
| 4 | The in-memory `memory` map (per-session poll state) is never pruned. It grows by one small entry per session the radar has watched during the PI-Desktop run and is dropped when the plugin unloads | Info | Accepted |
| 5 | `sessionsFrom()` throws on a `null` entry in the `session/list` answer. That poll fails and shows as `model.error`; the next poll retries | Info | Accepted |
| 6 | README says "everything else it does is read-only". Opening the view automatically (`pi.ui.revealView`) is a UI side effect without a click; the setting controls it, and `off` disables it | Info | Clarified in README |
| 7 | The local `dist/eskwisit.neural-radar-0.5.0.piplug` contains dev files (`.agents/`, `.github/`, `docs/neural-radar.png`, `.gitignore`). From 0.6.0 the release workflow packs only runtime files | Info | Fixed for 0.6.0 (`.github/workflows/release.yml`) |
| 8 | 0.34.0 used Node `fs` and `fetch` to read a file path or download an https URL typed in the settings. From 0.37.0 the settings are gone and `fetch` is not used: the picture comes from the view's file picker as a data URL, and `fs` only touches `avatar.json` in the data folder and reads `manifest.json` for the version. The grep check below predates this and now also matches `require(` in `main.js` | Info | Accepted: documented in README and `safetyNotes` |
| 9 | An update reloads `main.js`, but PI-Desktop keeps an open view's page (it never calls `closePlugin` on install or update). From 0.37.0 `radar.state` carries `version` (read from `manifest.json`) and the view calls `location.reload()` when it changes, unless the message box has focus. No network, no tokens | Info | Accepted; the host could close a plugin's views on update instead |

## Known limits

- Question cards an agent opens mid-turn (`asktool`) and tool-permission prompts cannot be reached.
  `agent/askTool/resolve` and `tool/resolvePermission` exist, but the request ids they need only
  come from `agent/pendingInteractive`, which is not a plugin operation. A pending tool call is not
  in the transcript until it completes. The radar does not try to answer either.
- Stop and Abort act on the whole agent. There is no per-subagent stop for plugins.
- "Needs your reply" is a heuristic over the agent's last message: closing paragraph, `?` or an
  asking phrase. Code blocks, inline code, tables and headings are ignored.

## Commands run

Run on macOS, 2026-11-03, against the working tree (uncommitted 0.6.0 changes).

```console
$ cd /Users/mru/Code/pi/neural-radar && node --version && node --test tests/
v24.21.0
ℹ tests 73
ℹ suites 14
ℹ pass 73
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Node 22+ loads `tests/index.js` for the directory argument, which pulls in every `*.test.js`. On
Node 20, `node --test tests/` finds the `*.test.js` files itself.

```console
$ python3 scripts/security_audit.py plugins/eskwisit.neural-radar
# (catalog repository scripts; run on a scratch copy holding manifest.json, main.js, views/, README.md, LICENSE)
# expected after removing composer.suggest (not re-run here)
Security audit: 1 plugin source(s), 0 blocker(s), 2 manual-review signal(s)
REVIEW: eskwisit.neural-radar/main.js:10: manual review signal: agent/prompt or desktop control
REVIEW: eskwisit.neural-radar/views/index.html:895: manual review signal: persistent activation/timer
Security audit passed automatic checks; maintainer review is still required.
```

Both signals are explained above: the permissions matrix and the timers.

```console
$ grep -nE "require\(|process\.|child_process|fetch\(|XMLHttpRequest|WebSocket|eval|Function\(|import\(|localStorage|indexedDB|navigator\.clipboard" main.js views/index.html
main.js:4: * Neural Radar — PI-Desktop plugin main process.
# only match: the word "process" in a comment; nothing in views/index.html
$ unzip -l dist/eskwisit.neural-radar-0.5.0.piplug   # see finding 7
```

`pi-plugin check` / `pi-plugin pack` were not run here (no PI-Desktop checkout). The plugin center
runs them again before publishing.

[SECURITY.md]: https://github.com/AIUO-Net/pi-desktop-plugins/blob/main/SECURITY.md
