#!/bin/sh
# Runs the suite as CI does (same bun, flags and env), so a local result and CI's agree.
# Arguments pass through: scripts/test.sh daemon/__tests__/x.test.ts
#
# Bun's child processes inherit the environment bun started with, not the preload's later edits
# to process.env, so everything below has to be in place before bun starts. test-setup.ts refuses
# to run without the tmux and launchd guards.

# The pinned bun (.tool-versions), which CI installs and the daemon runs too. Putting its directory
# first on PATH makes every bun a test spawns the same one: a spawn handed no env resolves its command
# against the PATH bun started with, not later edits to process.env.PATH (Bun.spawn and Bun.which on
# 1.3.14 and 1.4.4, child_process on 1.3.14), so a PATH set inside the run would not reach it.
want=$(sed -n 's/^bun[[:space:]][[:space:]]*\([^[:space:]]*\).*/\1/p' "$(dirname "$0")/../.tool-versions") || exit 1
[ -n "$want" ] || { echo "scripts/test.sh: .tool-versions pins no bun" >&2; exit 1; }
if [ "$(bun --version 2>/dev/null)" != "$want" ]; then
  home=$(asdf where bun "$want" 2>/dev/null) && PATH="$home/bin:$PATH"
fi
if [ "$(bun --version 2>/dev/null)" != "$want" ]; then
  echo "scripts/test.sh: the suite runs on bun $want (.tool-versions), as CI does; PATH has $(bun --version 2>/dev/null || echo none). Install it (asdf install bun $want) or put it first on PATH." >&2
  exit 1
fi

# infra/config.ts exits without a bot token; a dummy one also keeps a session's real token out of
# the run. A set channel skips config's network lookup of the default one.
export DISCORD_BOT_TOKEN=test-token DEFAULT_SESSION_CHANNEL=000000000000000000

# A private tmux server, so no test can reach a live session.
dir=$(mktemp -d "${TMPDIR:-/tmp}/hydra-tmux-XXXXXX") || exit 1
unset TMUX
# HYDRA_NO_LAUNCHD: no test, nor any CLI a test spawns, may register with the real launchd (cli/jobs.ts launchdIO).
# --parallel: run test files across worker processes (implies --isolate: each file in a fresh global scope, so no
# file's mocks or module state leak into the next). Cap default workers at 6 to avoid macOS exec-scan contention on
# busy hosts while still running the suite in parallel; override via HYDRA_TEST_WORKERS or explicit --parallel=N.
# --timings: start the slowest files (e.g. server-sandbox.test.ts) at t=0 so no straggler extends the tail.
root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
has_parallel=0
has_timings=0
for arg in "$@"; do
  case "$arg" in
    --parallel|--parallel=*) has_parallel=1 ;;
    --timings|--timings=*) has_timings=1 ;;
  esac
done
extra=""
if [ "$has_parallel" -eq 0 ]; then
  workers=${HYDRA_TEST_WORKERS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 4)}
  if [ -z "${HYDRA_TEST_WORKERS:-}" ] && [ "$workers" -gt 6 ] 2>/dev/null; then workers=6; fi
  extra="--parallel=$workers"
fi
if [ "$has_timings" -eq 0 ] && [ -f "$root/scripts/test-timings.json" ]; then
  TMUX_TMPDIR=$dir HYDRA_NO_LAUNCHD=1 bun test ${extra:+"$extra"} --timings="$root/scripts/test-timings.json" "$@"
else
  TMUX_TMPDIR=$dir HYDRA_NO_LAUNCHD=1 bun test ${extra:+"$extra"} "$@"
fi
status=$?
tmux -S "$dir/tmux-$(id -u)/default" kill-server 2>/dev/null
rm -rf "$dir"
exit $status
