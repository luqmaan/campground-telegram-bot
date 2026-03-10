# Campground Telegram Bot

Standalone Telegram bot for monitoring Reserve California campsite availability and controlling the monitor from a group chat.

## Features

- Polls Telegram directly with its own bot token
- Sends campsite alerts to a target group chat
- Auto-authorizes the owner plus one additional group member by default
- Runs on Node `v24.13.1` using direct `.ts` entrypoints
- Keeps one active Claude or Codex task per chat
- Stores per-chat session state, pending uploads, and last runner results on disk
- Saves photos and documents locally and attaches them to the next runner task
- Runs Claude and Codex inside isolated git worktrees with auto-commit on successful code changes
- Lets you reply to task cards to steer running work and resume finished Claude sessions
- Constrains the bot and its subprocesses with a dedicated cgroup slice, `nice`/`ionice`, optional `timeout`, and `prlimit`
- Built-in commands:
  - `/status`
  - `/run-now`
  - `/pause-monitor`
  - `/resume-monitor`
  - `/restart-monitor`
  - `/logs`
  - `/users`
  - `/forget`
  - `/cancel`
  - `/claude ...`
  - `/codex ...`
- Any other text is forwarded to headless Claude for campground-related tasks
- Persists the last 10 monitor runs and reports the last 3 in `status`

## Setup

1. Copy `.env.example` to `.env`
2. Fill in:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_GROUP_CHAT_ID`
   - `TELEGRAM_OWNER_USER_ID`
   - Optional Reserve California proxy settings:
     - `RESERVE_CA_USE_CF_PROXY=1`
     - `RESERVE_CA_CF_PROXY_URL=https://scrape-proxy.ldawoodjee.workers.dev`
     - `RESERVE_CA_CF_PROXY_SECRET=solefeed-scrape-2026`
3. Start the bot:

```bash
npm run start
```

Or with PM2:

```bash
pm2 start ecosystem.config.cjs --only bilal69-bot
```

## Host Safety

The repo includes host-level files for constrained execution:

- [`ops/systemd/solefeed-campground.slice`](ops/systemd/solefeed-campground.slice)
- [`ops/logrotate/campground-telegram-bot`](ops/logrotate/campground-telegram-bot)

The bot wrapper joins a dedicated systemd slice and caps Node heap. Agent subprocesses inherit that slice and add optional `timeout` + lightweight `prlimit` limits on top. Memory/process containment comes from the dedicated cgroup slice rather than hard `prlimit --as/--nproc` caps, because those broke Bun-based Claude and Node-based Codex on this host. The slice is capped at 4 GB total (`MemoryHigh=3G`, `MemoryMax=4G`). Codex also runs with `workspace-write` sandboxing inside an isolated worktree.

## Notes

- The bot stores runtime state in `data/`
- The first authorized user is seeded from `TELEGRAM_OWNER_USER_ID`
- The next new human sender in the configured group is auto-added until `TELEGRAM_MAX_AUTH_USERS` is reached
- Plain uploads with no text are queued for the next `/claude` or `/codex` task
- Replies to a running Claude task card are injected into that live Claude session
- Replies to a running Codex task card are appended to that task's live steer inbox
- Replies to a finished Claude task card resume the saved Claude session in a new run
- Successful Claude/Codex edits are committed onto task branches like `tg/2026-03-06-fix-parser-a1b2c3`
- Failed tasks keep their isolated worktree only if there are uncommitted changes worth inspecting
- The monitor currently checks the Apr 3-6, 2026 weekend configuration baked into `src/monitor-config.ts`
- Reserve California checks use the sibling `cfproxy` worker by default; set `RESERVE_CA_USE_CF_PROXY=0` to force direct origin requests
- Runner timeouts are disabled by default; set `CLAUDE_TIMEOUT_SECONDS` or `CODEX_TIMEOUT_SECONDS` to a non-zero value if you want a hard cap
- Runner progress now streams every few seconds as output or status changes arrive
