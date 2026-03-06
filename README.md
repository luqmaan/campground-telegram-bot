# Campground Telegram Bot

Standalone Telegram bot for monitoring Reserve California campsite availability and controlling the monitor from a group chat.

## Features

- Polls Telegram directly with its own bot token
- Sends campsite alerts to a target group chat
- Auto-authorizes the owner plus one additional group member by default
- Built-in commands:
  - `status`
  - `run now`
  - `pause monitor`
  - `resume monitor`
  - `restart monitor`
  - `logs`
  - `users`
  - `forget`
  - `cancel claude`
- Any other text is forwarded to headless Claude for campground-related tasks
- Persists the last 10 monitor runs and reports the last 3 in `status`

## Setup

1. Copy `.env.example` to `.env`
2. Fill in:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_GROUP_CHAT_ID`
   - `TELEGRAM_OWNER_USER_ID`
3. Start the bot:

```bash
node src/bot.js
```

Or with PM2:

```bash
pm2 start ecosystem.config.cjs --only bilal69-bot
```

## Notes

- The bot stores runtime state in `data/`
- The first authorized user is seeded from `TELEGRAM_OWNER_USER_ID`
- The next new human sender in the configured group is auto-added until `TELEGRAM_MAX_AUTH_USERS` is reached
- The monitor currently checks the Apr 3-6, 2026 weekend configuration baked into `src/monitor-config.js`
