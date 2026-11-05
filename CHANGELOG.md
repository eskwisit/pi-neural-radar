# Changelog

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
