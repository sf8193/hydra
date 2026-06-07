#!/bin/bash
# Safely restart the hydra daemon.
#
# Safe for spawned sessions to run — bridges auto-reconnect (~5s),
# sessions persist in sessions.json. The only visible effect is a
# brief routing gap while the daemon restarts.
#
# Usage:
#   ./restart-daemon.sh                    # uses existing env from start-daemon.sh defaults
#   SPAWN_CWD=~/Documents/angellist ./restart-daemon.sh   # explicit
export PATH="$HOME/.asdf/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${DISCORD_STATE_DIR:-$HOME/.claude/channels/slack}"
SOCK="$STATE_DIR/daemon.sock"

# Inherit the env the daemon was originally started with, or use defaults
: "${SPAWN_CWD:=$HOME/Documents/angellist}"
: "${CHAT_PLATFORM:=slack}"
: "${DISCORD_STATE_DIR:=$HOME/.claude/channels/slack}"
: "${CLAUDE_CONFIG_DIR:=$HOME/.claude}"

echo "$(date): Restart requested" >> ~/discord-daemon.log

# 1. Kill existing daemon
if tmux has-session -t discord-daemon 2>/dev/null; then
  echo "Killing daemon..."
  tmux kill-session -t discord-daemon 2>/dev/null
  sleep 0.5
else
  echo "No daemon running."
fi

# 2. Remove stale socket
rm -f "$SOCK"

# 3. Relaunch
echo "Starting daemon..."
CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" \
  DISCORD_STATE_DIR="$DISCORD_STATE_DIR" \
  CHAT_PLATFORM="$CHAT_PLATFORM" \
  SPAWN_CWD="$SPAWN_CWD" \
  "$SCRIPT_DIR/start-daemon.sh"

# 4. Wait for socket to appear (up to 15s)
echo -n "Waiting for socket"
for i in $(seq 1 30); do
  if [ -S "$SOCK" ]; then
    echo " ready (${i}×0.5s)"
    echo "$(date): Daemon restarted successfully" >> ~/discord-daemon.log
    exit 0
  fi
  echo -n "."
  sleep 0.5
done

echo " TIMEOUT — socket did not appear after 15s"
echo "$(date): Restart FAILED — socket timeout" >> ~/discord-daemon.log
exit 1
