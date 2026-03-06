#!/usr/bin/env bash
set -euo pipefail

CGROUP_PATH="/sys/fs/cgroup/solefeed.slice/solefeed-campground.slice"
AGENT_TIMEOUT_SECONDS="${AGENT_TIMEOUT_SECONDS:-420}"
AGENT_ADDRESS_SPACE_MB="${AGENT_ADDRESS_SPACE_MB:-1536}"
AGENT_RSS_MB="${AGENT_RSS_MB:-1024}"
AGENT_CPU_SECONDS="${AGENT_CPU_SECONDS:-600}"
AGENT_NOFILE="${AGENT_NOFILE:-1024}"
AGENT_NPROC="${AGENT_NPROC:-256}"

if [ -d "$CGROUP_PATH" ]; then
  echo $$ | sudo tee "$CGROUP_PATH/cgroup.procs" > /dev/null 2>&1 || true
fi

prlimit_args=(
  "--nofile=${AGENT_NOFILE}:${AGENT_NOFILE}"
  "--nproc=${AGENT_NPROC}"
  "--cpu=${AGENT_CPU_SECONDS}"
)

if [ "$AGENT_ADDRESS_SPACE_MB" -gt 0 ] 2>/dev/null; then
  prlimit_args+=("--as=$((AGENT_ADDRESS_SPACE_MB * 1024 * 1024))")
fi

if [ "$AGENT_RSS_MB" -gt 0 ] 2>/dev/null; then
  prlimit_args+=("--rss=$((AGENT_RSS_MB * 1024 * 1024))")
fi

exec nice -n 15 ionice -c 2 -n 7 timeout --signal=TERM --kill-after=15s "${AGENT_TIMEOUT_SECONDS}" \
  prlimit "${prlimit_args[@]}" -- "$@"
