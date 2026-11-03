# Changelog

## 0.3.0

### Features

- **manifest:** declare the radar view, command, setting and permissions (`c824650`)
- **main:** watch agents and subagents and act on drawer clicks (`b274df5`)
- **view:** draw the radar with a drawer to reply, approve, send or stop (`d4ecba3`)

### Documentation

- **readme:** show a screenshot of the radar (`377b0fb`)
- **readme:** describe the radar, its settings, permissions and limits (`7c4b8db`)
- add the security review notes (`4b3089f`)

### Tests

- add a fake pi-desktop host and a test entry point (`ff05fcc`)
- cover transcript reading and reply detection (`b491bc5`)
- cover drawer actions, denied permissions and host failures (`4ef077e`)
- cover polling and the plugin lifecycle (`4a200c1`)

### CI

- print the changelog section of a version (`8dddcb1`)
- publish a github release when the manifest version changes (`21d005f`)

### Chores

- ignore build output, piplug files and node modules (`97f70c0`)

### Other

- Initial commit (`ecf563f`)
