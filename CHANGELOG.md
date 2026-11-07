# Changelog

## 0.26.0

### Features

- give each main agent of a session its own cluster with its subagents (`46558a4`)

### Documentation

- **readme:** describe a cluster for each main agent (`df18ce5`)

### Tests

- **tests:** cover a cluster for each main agent of a session (`8875d24`)

## 0.25.1

### Features

- give every agent a session starts its own cluster (`7abbdcf`)

### Fixes

- **view:** say tokens instead of tool ctx in the agent tooltip (`a6f5eeb`)

### Documentation

- **readme:** describe a cluster for each started agent (`8d01f1f`)
- **readme:** show tokens in the tooltip example (`bb5ba83`)

### Tests

- **tests:** cover a cluster for each started agent (`bd72ce4`)

## 0.24.1

### Breaking changes

- remove pre-fill in session and the composer.suggest permission (`beebe46`)

### Fixes

- **view:** show a lone agent as its own cluster, not merged into you (`be88191`)

### Documentation

- **readme:** remove pre-fill in session and composer.suggest (`007c1b9`)
- **readme:** say a lone agent keeps its own cluster (`d664d3b`)
- update the security review for the removed composer.suggest (`0565eaa`)

### Tests

- **tests:** replace the pre-fill tests with a check that prefill is refused (`94f7f73`)

## 0.23.0

### Features

- **view:** always show every agent's tooltip (`225008d`)
- **view:** remove the session's total tokens from the drawer (`b781001`)

### Refactoring

- **main:** drop model fields the view never reads (`3abf1ff`)
- **view:** drop unused layouts, background canvas and dead code (`e72ae43`)
- **main:** stop reading the token usage history (`4af5527`)

### Documentation

- **readme:** describe tooltips shown for every agent (`25ddfcc`)
- **readme:** drop the total used tokens and usage history read (`a8016ec`)
- drop the token usage history from the security review (`72b6e73`)
- **manifest:** drop the token usage history from the safety notes (`91d175e`)

### Tests

- **tests:** read the autoOpen setting from the main process (`58e1490`)
- **tests:** drop the session token total tests (`ceaff0e`)
- **tests:** no longer allow the token usage history read (`f8bb5bc`)

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
