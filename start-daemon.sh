#!/bin/bash
echo "DEPRECATED: use 'hydra up <platform>' instead (bun cli/hydra.ts up discord)" >&2
set -euo pipefail
# Start the chat routing daemon in a tmux session.
# The daemon holds a single gateway connection (Discord or Slack) and routes
# messages between the chat platform and Claude sessions via unix sockets.
#
# Required env vars (set before calling, or in .env):
#   SPAWN_CWD — working directory for spawned sessions
#
# Optional env vars:
#   CHAT_PLATFORM — discord (default) or slack
#   HYDRA_STATE_DIR — state dir (socket, access.json, sessions)
#   CLAUDE_CONFIG_DIR — config dir for spawned Claude sessions

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env-setup.sh"

SESSION="${CHAT_PLATFORM}-daemon"
LOG="${HYDRA_LOG:-$HOME/hydra-${CHAT_PLATFORM}-daemon.log}"

if [ -z "${SPAWN_CWD:-}" ]; then
  echo "ERROR: SPAWN_CWD is required. Set it to the working directory for spawned sessions."
  echo "  Example: SPAWN_CWD=~/trading ./start-daemon.sh"
  exit 1
fi

# Compile gate — never cold-start onto a tree that doesn't load.
# `bun run` is lazy: parse/export errors surface only when a module is imported,
# so a broken merge to the running branch sits undetected until a restart, then
# crash-loops forever (watchdog kills + relaunches a process that dies on boot).
# Build the entries first; if it fails, refuse to start and leave any running
# daemon UNTOUCHED — a broken tree must never replace a working process.
source "$SCRIPT_DIR/compile-check.sh"
if ! COMPILE_OUT=$(_compile_check "$SCRIPT_DIR"); then
  {
    echo "$(date): COMPILE FAILED — refusing to start daemon; leaving any running session untouched."
    echo "----- build error -----"
    printf '%s' "$COMPILE_OUT"
  } | tee -a "$LOG"
  exit 1
fi

# Kill existing daemon session
tmux kill-session -t "$SESSION" 2>/dev/null || true
sleep 1

# Remove stale socket
rm -f "$STATE_DIR/daemon.sock"

# Start daemon.
# Forward env EXPLICITLY into the tmux command. tmux does NOT reliably inherit arbitrary
# vars into new sessions — its server global env is frozen at first launch — so relying on
# inheritance silently dropped CLAUDE_CONFIG_DIR and broke spawned-session bridges.
# PATH must also be forwarded so bun/claude are reachable when launched via launchd.
ENVS="PATH='$PATH' HYDRA_STATE_DIR='$STATE_DIR' SPAWN_CWD='$SPAWN_CWD' BUN_RUNTIME_TRANSPILER_CACHE=0"
[ -n "$CHAT_PLATFORM" ] && ENVS="$ENVS CHAT_PLATFORM='$CHAT_PLATFORM'"
[ -n "$CLAUDE_CONFIG_DIR" ] && ENVS="$ENVS CLAUDE_CONFIG_DIR='$CLAUDE_CONFIG_DIR'"
[ -n "${HYDRA_MODEL:-}" ] && ENVS="$ENVS HYDRA_MODEL='$HYDRA_MODEL'"
tmux new-session -d -s "$SESSION" \
  "cd '$SCRIPT_DIR' && $ENVS bun run daemon.ts 2>&1 | tee -a $LOG"

echo "$(date): Daemon started in tmux session '$SESSION' (SPAWN_CWD=$SPAWN_CWD)" >> $LOG
echo "Daemon started. Attach with: tmux attach -t $SESSION"

# Voice dictation — bring the transcription sidecar up with the daemon.
# --auto is a quiet no-op unless the sidecar is set up (or explicitly enabled)
# and is idempotent: it never restarts a running model server. `|| true`: the
# daemon is already up at this point — under set -e a sidecar refusal must not
# turn a successful daemon start into a nonzero exit.
HYDRA_STATE_DIR="$STATE_DIR" "$SCRIPT_DIR/start-transcribe.sh" --auto || true
