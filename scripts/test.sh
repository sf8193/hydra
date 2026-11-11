#!/bin/sh
# Runs the suite as CI does (same bun, flags and env), so a local result and CI's agree.
# Arguments pass through: scripts/test.sh daemon/__tests__/x.test.ts
#
# Bun's child processes inherit the environment bun started with, not the preload's later edits
# to process.env, so everything below has to be in place before bun starts. test-setup.ts refuses
# to run without the tmux and launchd guards.

# The suite's bun (.bun-version), which CI installs too. The daemon still runs .tool-versions, an
# older bun, and the gap is real: bun 1.3.14 resolves a spawned command against the PATH bun
# started with, ignoring later edits to process.env.PATH, so the PATH-shim fakes (fake-tmux.ts)
# never run and the real binary answers instead. Putting its directory first on PATH makes every
# bun a test spawns the same one.
want=$(cat "$(dirname "$0")/../.bun-version") || exit 1
if [ "$(bun --version 2>/dev/null)" != "$want" ]; then
  home=$(asdf where bun "$want" 2>/dev/null) && PATH="$home/bin:$PATH"
fi
if [ "$(bun --version 2>/dev/null)" != "$want" ]; then
  echo "scripts/test.sh: the suite runs on bun $want (.bun-version), as CI does; PATH has $(bun --version 2>/dev/null || echo none). Install it (asdf install bun $want) or put it first on PATH." >&2
  exit 1
fi

# daemon/config.ts exits without a bot token; a dummy one also keeps a session's real token out of
# the run. A set channel skips config's network lookup of the default one.
export DISCORD_BOT_TOKEN=test-token DEFAULT_SESSION_CHANNEL=000000000000000000

# A private tmux server, so no test can reach a live session.
dir=$(mktemp -d "${TMPDIR:-/tmp}/hydra-tmux-XXXXXX") || exit 1
unset TMUX
# HYDRA_NO_LAUNCHD: no test, nor any CLI a test spawns, may register with the real launchd (cli/jobs.ts launchdIO).
# --isolate: each file in a fresh global scope, so no file's mocks or module state leak into the next.
TMUX_TMPDIR=$dir HYDRA_NO_LAUNCHD=1 bun test --isolate "$@"
status=$?
tmux -S "$dir/tmux-$(id -u)/default" kill-server 2>/dev/null
rm -rf "$dir"
exit $status
