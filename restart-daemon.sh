#!/bin/bash
# Safely restart the hydra daemon.
#
# Safe for spawned sessions to run — bridges auto-reconnect (~5s),
# sessions persist in sessions.json. The only visible effect is a
# brief routing gap while the daemon restarts.
#
# Usage:
#   ./restart-daemon.sh                              # uses env defaults
#   SPAWN_CWD=~/my-project ./restart-daemon.sh       # explicit
export PATH="$HOME/.npm-global/bin:$HOME/.asdf/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source .env from state dir for persistent config (SPAWN_CWD, CLAUDE_CONFIG_DIR, etc.)
_STATE_HINT="${HYDRA_STATE_DIR:-${DISCORD_STATE_DIR:-$HOME/.claude/channels/${CHAT_PLATFORM:-discord}}}"
[ -f "$_STATE_HINT/.env" ] && set -a && . "$_STATE_HINT/.env" && set +a

: "${TMUX_SESSION:=discord-daemon}"
: "${HYDRA_STATE_DIR:=${DISCORD_STATE_DIR:-$HOME/.claude/channels/${CHAT_PLATFORM:-discord}}}"
: "${SPAWN_CWD:=$HOME}"
: "${CHAT_PLATFORM:=discord}"
: "${CLAUDE_CONFIG_DIR:=$HOME/.claude}"

STATE_DIR="$HYDRA_STATE_DIR"
SOCK="$STATE_DIR/daemon.sock"
LOG="${HYDRA_LOG:-$HOME/hydra-daemon.log}"

echo "$(date): Restart requested" >> "$LOG"

# 1. Pre-flight: compile-check BEFORE killing the old daemon
echo "Pre-flight compile check..."
source "$SCRIPT_DIR/compile-check.sh"
COMPILE_OUT=$(_compile_check "$SCRIPT_DIR")
if [ $? -ne 0 ]; then
  echo "✗ Compile check FAILED — old daemon left running."
  printf '%s' "$COMPILE_OUT" | sed 's/^/    /'
  echo "$(date): Restart ABORTED — compile check failed (old daemon untouched)" >> "$LOG"
  exit 1
fi

# 2. Snapshot working tree for rollback
SNAPSHOT=$(cd "$SCRIPT_DIR" && git stash create 2>/dev/null)
if [ -n "$SNAPSHOT" ]; then
  echo "Snapshot: $SNAPSHOT (rollback: git stash apply $SNAPSHOT)"
  echo "$(date): Snapshot $SNAPSHOT" >> "$LOG"
fi

# 3. Kill existing daemon
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "Killing daemon..."
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null
  sleep 0.5
else
  echo "No daemon running."
fi

# 4. Remove stale socket
rm -f "$SOCK"

# 5. Relaunch
echo "Starting daemon..."
CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" \
  HYDRA_STATE_DIR="$HYDRA_STATE_DIR" \
  CHAT_PLATFORM="$CHAT_PLATFORM" \
  SPAWN_CWD="$SPAWN_CWD" \
  "$SCRIPT_DIR/start-daemon.sh"

# 6. Wait for socket to appear (up to 15s)
echo -n "Waiting for socket"
for i in $(seq 1 30); do
  if [ -S "$SOCK" ]; then
    echo " ready (${i}×0.5s)"
    echo "$(date): Daemon restarted successfully" >> "$LOG"
    exit 0
  fi
  echo -n "."
  sleep 0.5
done

echo " TIMEOUT — socket did not appear after 15s"
echo "$(date): Restart FAILED — socket timeout" >> "$LOG"
if [ -n "$SNAPSHOT" ]; then
  echo "Rollback available: git stash apply $SNAPSHOT && ./restart-daemon.sh"
fi
exit 1
