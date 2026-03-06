#!/usr/bin/env bash
set -euo pipefail

CGROUP_PATH="/sys/fs/cgroup/solefeed.slice/solefeed-campground.slice"
BOT_NODE_MAX_OLD_SPACE_SIZE_MB="${BOT_NODE_MAX_OLD_SPACE_SIZE_MB:-192}"
BOT_NOFILE="${BOT_NOFILE:-2048}"

if [ -d "$CGROUP_PATH" ]; then
  echo $$ | sudo tee "$CGROUP_PATH/cgroup.procs" > /dev/null 2>&1 || true
fi

ulimit -n "$BOT_NOFILE" 2>/dev/null || true

exec nice -n 10 ionice -c 2 -n 7 node --max-old-space-size="$BOT_NODE_MAX_OLD_SPACE_SIZE_MB" "$@"
