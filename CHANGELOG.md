# Changelog

## 0.34.0

### Features

- **main:** queue messages to a busy agent and send them when its turn ends (`ab2b183`)
- **view:** show queued messages and when each one is sent (`2cb0ed5`)
- show you as a circle with your picture or Gravatar from the settings (`9113b3d`)

### Fixes

- **main:** keep each subagent in the cluster of the turn that started it (`119fc8f`)
- **view:** show only the model and its effort level in the drawer (`4433cb8`)

### Documentation

- **readme:** describe one main agent per turn and its subagents (`d25485e`)
- **readme:** describe the model and effort line in the drawer (`82ea26f`)
- **readme:** explain how messages to a busy agent are queued (`0cce9ef`)
- **readme:** describe your picture, its settings and its cache (`a75cbbc`)
- **manifest:** state the picture's file and network access in the safety notes (`d40935b`)
- **readme:** list the picture's file and network access in permissions (`80bb031`)
- update the security review for the picture and the message queue (`7f2e43f`)

### Tests

- **tests:** cover subagents staying in the cluster of their turn (`d4b1103`)
- **tests:** cover the queue of messages to a busy agent (`53e01fa`)
- **tests:** cover your picture, its cache and its removal (`26478f7`)
