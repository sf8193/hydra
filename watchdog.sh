#!/bin/bash
# BitBot daemon watchdog — checks heartbeat freshness and restarts if stale.
# Run via launchd (com.dcetlin.bitbot-watchdog) every ~120s.
#
# The in-daemon self-heal (slack-gateway.ts) handles most staleness by
# reconnecting the Bolt Socket-Mode WebSocket. This watchdog is the
# defense-in-depth layer: it catches process crashes, self-heal failures,
# and any other mode where the daemon is gone or permanently stuck.

# launchd runs with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
# tmux and claude are at /opt/homebrew/bin; bun is via asdf shims.
export PATH="$HOME/.asdf/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

HEARTBEAT="$HOME/.claude/channels/slack/daemon.alive"
STALE_SECONDS=300
HYDRA_DIR="$HOME/Documents/angellist/hydra"
LOG="$HOME/bitbot-watchdog.log"
NOW=$(date +%s)

restart_daemon() {
  cd "$HYDRA_DIR"
  CLAUDE_CONFIG_DIR="$HOME/.claude" DISCORD_STATE_DIR="$HOME/.claude/channels/slack" CHAT_PLATFORM=slack \
    SPAWN_CWD="$HOME/Documents/angellist" ./start-daemon.sh
}

# Bail if tmux isn't reachable (prevents phantom "session missing" restarts)
if ! command -v tmux &>/dev/null; then
  echo "$(date): ERROR: tmux not found in PATH ($PATH)" >> "$LOG"
  exit 1
fi

# Check if daemon tmux session exists at all
if ! tmux has-session -t discord-daemon 2>/dev/null; then
  echo "$(date): Daemon tmux session missing, starting" >> "$LOG"
  restart_daemon
  exit 0
fi

# If heartbeat file doesn't exist, check how long the tmux session has been up.
# A freshly started daemon needs a few seconds to connect and write its first heartbeat.
# If the session has been up for longer than STALE_SECONDS with no heartbeat, it crashed
# during startup and the tmux session is a dead shell — restart.
if [ ! -f "$HEARTBEAT" ]; then
  CREATED=$(tmux display-message -t discord-daemon -p '#{session_created}' 2>/dev/null || echo "$NOW")
  AGE=$((NOW - CREATED))
  if [ "$AGE" -gt "$STALE_SECONDS" ]; then
    echo "$(date): No heartbeat after ${AGE}s, restarting daemon" >> "$LOG"
    restart_daemon
  fi
  exit 0
fi

# Check freshness via mtime
MTIME=$(stat -f %m "$HEARTBEAT" 2>/dev/null || echo 0)
ELAPSED=$((NOW - MTIME))

if [ "$ELAPSED" -gt "$STALE_SECONDS" ]; then
  echo "$(date): Heartbeat stale (${ELAPSED}s > ${STALE_SECONDS}s), restarting daemon" >> "$LOG"
  restart_daemon
fi
