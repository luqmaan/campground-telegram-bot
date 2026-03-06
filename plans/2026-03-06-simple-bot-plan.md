# Simple Telegram Agent Plan

## Goal

Keep `campground-telegram-bot` simple while making it a solid Telegram interface for:

- conversational control over the campground monitor
- Claude Code as the default coding/operator assistant
- Codex as an optional secondary runner
- images/files as inputs to tasks
- short, clear progress updates back to Telegram

This version should avoid multi-agent orchestration, repo cloning, background job complexity, and autonomous deploy/merge behavior.

## Product Scope

### In Scope

- single Telegram bot
- polling-based Telegram intake
- one active task per chat
- persistent per-chat session state on disk
- default Claude runner
- explicit `/codex ...` command
- image and file upload support
- command-driven status, cancel, logs, and reset flows
- safe repo self-modification inside this repo only
- branch + commit workflow for code changes

### Out of Scope

- webhooks
- multi-repo orchestration
- multi-agent coordination
- autonomous merge to `main`
- autonomous deploy
- arbitrary shell execution from chat
- generic remote server administration

## Reference Projects To Borrow From

### Primary Reference

- `RichardAtCT/claude-code-telegram`
  Use for Telegram conversation flow, session persistence, auth, and progress updates.

### Secondary References

- `openai/codex`
  Use for Codex CLI invocation patterns only.

- `sazonovanton/SirChatalot`
  Use later for image/file UX patterns and media handling ideas.

## Architecture

### Core Components

1. `src/bot.js`
   Telegram polling loop, routing, auth, outbound messaging.

2. `src/session-store.js`
   Per-chat task/session state, history, locks, and metadata.

3. `src/runner-claude.js`
   Launch Claude Code subprocesses, stream progress, capture exit state.

4. `src/runner-codex.js`
   Launch Codex subprocesses behind explicit `/codex` commands.

5. `src/media.js`
   Download Telegram photos/files, normalize metadata, store paths for prompts.

6. `src/commands.js`
   Built-in commands for monitor control and agent control.

7. `src/monitor.js`
   Existing campground monitor logic, kept separate from Telegram UX.

### State Layout

Store runtime state under `data/`:

- `auth.json`
- `bot-state.json`
- `history.json`
- `monitor-state.json`
- `sessions/<chat-id>.json`
- `uploads/<chat-id>/...`

## Chat UX

### Built-In Commands

- `/start`
- `/help`
- `/status`
- `/run-now`
- `/pause-monitor`
- `/resume-monitor`
- `/restart-monitor`
- `/logs`
- `/users`
- `/cancel`
- `/forget`
- `/claude ...`
- `/codex ...`

### Default Message Behavior

- plain text without a command goes to Claude
- `/codex ...` goes to Codex
- image/file uploads are saved and attached to the next Claude or Codex task

### Response Style

Telegram responses should be:

- short
- incremental
- operational
- explicit about actions taken

Expected lifecycle:

1. acknowledge receipt
2. state what runner is being used
3. send 1-3 short progress updates for longer tasks
4. send final result summary
5. optionally send diff/commit info

## Safety Model

### Chat Safety

- restrict bot activity to the configured group chat
- allow only the seeded owner plus one additional discovered user by default
- keep one active task per chat
- require explicit cancel before starting a second long task

### Repo Safety

- limit code changes to this repo in v1
- always create a working branch for self-modifying tasks
- auto-commit only within the working branch
- never auto-merge to `main`
- never auto-push unless explicitly commanded

### Execution Safety

- no raw arbitrary shell command passthrough from Telegram
- runner commands come only from controlled wrappers
- hard timeout per task
- cap Telegram message size
- redact secrets from logs/messages where possible

## Implementation Phases

### Phase 1: Runner Separation

- extract Claude execution from `src/bot.js` into `src/runner-claude.js`
- add structured runner result objects:
  - `startedAt`
  - `finishedAt`
  - `status`
  - `summary`
  - `stdoutTail`
  - `stderrTail`

### Phase 2: Session Store

- create `src/session-store.js`
- track per-chat:
  - active task
  - recent history
  - pending uploads
  - last runner used
  - last result

### Phase 3: Command Router

- move built-in command parsing into `src/commands.js`
- keep monitor commands and agent commands separate
- standardize command replies

### Phase 4: Media Support

- add `src/media.js`
- download Telegram attachments into `data/uploads/<chat-id>/`
- support:
  - photo
  - document
  - screenshot/image review flow
- attach uploaded file paths to runner prompts

### Phase 5: Codex Support

- add `src/runner-codex.js`
- support explicit `/codex ...` only
- keep Claude as default
- use same session/task model as Claude

### Phase 6: Self-Modification Workflow

- create branch naming convention:
  - `tg/<date>-<task-slug>`
- if Claude or Codex changes files:
  - show modified files
  - commit on branch
  - report commit SHA back to Telegram

### Phase 7: Better Telegram UX

- progress throttling to avoid spam
- better formatting for:
  - status
  - logs
  - diffs
  - errors
- reply to media with contextual follow-up

## Command Behavior Details

### `/status`

Show:

- monitor scheduler state
- active run
- last check time
- last error
- last 3 monitor runs
- current active Claude/Codex task

### `/cancel`

- cancel current runner task for that chat only
- leave monitor scheduler untouched

### `/logs`

- show recent monitor events
- optionally add `/logs runner` later

### `/forget`

- clear conversation/session history for that chat
- preserve auth and monitor state

## Media Handling Plan

### V1

- save photos/documents locally
- keep original filename when available
- track MIME-ish category from Telegram metadata
- associate uploads with the next task in that chat

### Prompting Strategy

For Claude/Codex:

- include the upload path
- include original filename
- include a short note like:
  - "User attached image"
  - "User attached screenshot for debugging"
  - "User attached document"

## Testing Plan

### Manual Tests

1. Bot joins group and responds to `/start`
2. Owner can run `/status`
3. Second user gets auto-authorized on first message
4. Third user is rejected
5. `/run-now` triggers monitor run
6. `/pause-monitor` and `/resume-monitor` work
7. Plain text routes to Claude
8. `/codex ...` routes to Codex
9. `/cancel` cancels active task
10. Photo upload is saved and referenced in the next task

### Lightweight Automated Tests Later

- command parsing
- session store read/write
- auth admission logic
- runner result normalization
- monitor status formatting

## Suggested File Refactor

Target structure:

```text
src/
  bot.js
  commands.js
  config.js
  media.js
  monitor-config.js
  monitor.js
  runner-claude.js
  runner-codex.js
  session-store.js
data/
  auth.json
  bot-state.json
  history.json
  monitor-state.json
  sessions/
  uploads/
plans/
  2026-03-06-simple-bot-plan.md
```

## Immediate Next Step

Implement Phase 1 and Phase 2 only:

- extract Claude runner
- add session store
- keep current monitor behavior intact
- do not add Codex or media handling yet

That keeps the repo small and gets the structure right before adding more behavior.
