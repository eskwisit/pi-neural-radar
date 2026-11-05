# Changelog

## 0.21.0

### Features

- **main:** describe agents by the latest prompt that names a topic (`375fd82`)
- **main:** record a short target for each tool call (`eb0d041`)
- **main:** estimate the tokens tool calls add to an agent's context (`e28afab`)
- **view:** name each tool's target in the activity log (`26e540b`)
- **view:** show current topic, live detail, tool context and age in tooltips (`871ab09`)
- **view:** show the session's total tokens used in the drawer (`a605de4`)
- **view:** drop the no-agents hint under you (`9479576`)
- **view:** show only the status in your label when you work alone (`b48ac49`)

### Fixes

- **view:** keep the drawer title on one line (`8beba6a`)

### Documentation

- **readme:** replace the demo image with a webp showing every state (`8b3b70d`)

### Tests

- **tests:** cover topic prompts, tool targets and tool token estimates (`38cd628`)

## 0.13.0

### Features

- **main:** count the tokens each subagent's transcript reports (`fb6de28`)
- **view:** show each subagent's tokens as a lower bound (`128a4f4`)

### Fixes

- **main:** count session tokens from the usage history and the open turn (`0ecd64b`)

### Documentation

- **manifest:** mention the token usage history in the safety notes (`d2d44e7`)
- list the token usage history read in the security review (`99d9d96`)
- **readme:** describe session and subagent token counts (`965729c`)

### Tests

- **tests:** cover session tokens from the usage history (`5efb52f`)
- **tests:** cover per-subagent token counts (`c06fb0b`)
