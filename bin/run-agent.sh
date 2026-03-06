#!/usr/bin/env bash
set -euo pipefail

CGROUP_PATH="/sys/fs/cgroup/solefeed.slice/solefeed-campground.slice"
AGENT_TIMEOUT_SECONDS="${AGENT_TIMEOUT_SECONDS:-0}"
AGENT_CPU_SECONDS="${AGENT_CPU_SECONDS:-600}"
AGENT_NOFILE="${AGENT_NOFILE:-1024}"

if [ -d "$CGROUP_PATH" ]; then
  echo $$ | sudo tee "$CGROUP_PATH/cgroup.procs" > /dev/null 2>&1 || true
fi

prlimit_args=(
  "--nofile=${AGENT_NOFILE}:${AGENT_NOFILE}"
  "--cpu=${AGENT_CPU_SECONDS}"
)

if [ -z "$AGENT_TIMEOUT_SECONDS" ] || [ "$AGENT_TIMEOUT_SECONDS" = "0" ]; then
  exec nice -n 15 ionice -c 2 -n 7 prlimit "${prlimit_args[@]}" -- "$@"
fi

exec nice -n 15 ionice -c 2 -n 7 timeout --signal=TERM --kill-after=15s "${AGENT_TIMEOUT_SECONDS}" \
  prlimit "${prlimit_args[@]}" -- "$@"
