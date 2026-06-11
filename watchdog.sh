#!/bin/bash
# Hydra daemon watchdog — checks heartbeat freshness and restarts if stale.
# Run via a system scheduler (e.g. launchd) every ~120s.
#
# The in-daemon self-heal handles most staleness by reconnecting the
# chat platform WebSocket. This watchdog is the defense-in-depth layer:
# it catches process crashes, self-heal failures, and any other mode
# where the daemon is gone or permanently stuck.
#
# Required env (set by the scheduler or source from a config file):
#   HYDRA_STATE_DIR  — state directory (heartbeat, socket, sessions)
#   HYDRA_DIR        — path to the hydra repo
#   SPAWN_CWD        — working directory for spawned sessions

# launchd runs with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
# tmux and claude are at /opt/homebrew/bin; bun is via asdf shims.
export PATH="$HOME/.asdf/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

: "${HYDRA_DIR:=$(cd "$(dirname "$0")" && pwd)}"
: "${SPAWN_CWD:=$HOME}"
: "${TMUX_SESSION:=discord-daemon}"

# Resolve CHAT_PLATFORM: env var → state dir .env → probe both known dirs → default discord
if [ -z "$CHAT_PLATFORM" ]; then
  for dir in "${DISCORD_STATE_DIR:-}" "$HOME/.claude/channels/slack" "$HOME/.claude/channels/discord"; do
    [ -f "$dir/.env" ] && CHAT_PLATFORM=$(grep '^CHAT_PLATFORM=' "$dir/.env" 2>/dev/null | cut -d= -f2) && [ -n "$CHAT_PLATFORM" ] && break
  done
fi
: "${CHAT_PLATFORM:=discord}"

# State dir follows platform if not explicitly set
if [ "$CHAT_PLATFORM" = "slack" ]; then
  : "${HYDRA_STATE_DIR:=${DISCORD_STATE_DIR:-$HOME/.claude/channels/slack}}"
else
  : "${HYDRA_STATE_DIR:=${DISCORD_STATE_DIR:-$HOME/.claude/channels/discord}}"
fi

HEARTBEAT="$HYDRA_STATE_DIR/daemon.alive"
STALE_SECONDS=300
LOG="${HYDRA_WATCHDOG_LOG:-$HOME/hydra-watchdog.log}"
NOW=$(date +%s)

# Platform-specific health check URL
if [ "$CHAT_PLATFORM" = "slack" ]; then
  HEALTH_URL="https://slack.com/api/api.test"
else
  HEALTH_URL="https://discord.com/api/v10/gateway"
fi

restart_daemon() {
  cd "$HYDRA_DIR"
  CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}" \
    HYDRA_STATE_DIR="$HYDRA_STATE_DIR" \
    CHAT_PLATFORM="$CHAT_PLATFORM" \
    SPAWN_CWD="$SPAWN_CWD" ./start-daemon.sh
}

# Bail if tmux isn't reachable (prevents phantom "session missing" restarts)
if ! command -v tmux &>/dev/null; then
  echo "$(date): ERROR: tmux not found in PATH ($PATH)" >> "$LOG"
  exit 1
fi

# Check if daemon tmux session exists at all
if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "$(date): Daemon tmux session missing, starting" >> "$LOG"
  restart_daemon
  exit 0
fi

# If heartbeat file doesn't exist, check how long the tmux session has been up.
# A freshly started daemon needs a few seconds to connect and write its first heartbeat.
# If the session has been up for longer than STALE_SECONDS with no heartbeat, it crashed
# during startup and the tmux session is a dead shell — restart.
if [ ! -f "$HEARTBEAT" ]; then
  CREATED=$(tmux display-message -t "$TMUX_SESSION" -p '#{session_created}' 2>/dev/null || echo "$NOW")
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
  # Don't restart if the network is down — the daemon can't connect anyway,
  # and restarting just creates a restart storm. Let the in-process self-heal
  # recover when connectivity returns.
  if ! curl -sS --max-time 5 "$HEALTH_URL" &>/dev/null; then
    exit 0
  fi
  echo "$(date): Heartbeat stale (${ELAPSED}s > ${STALE_SECONDS}s), restarting daemon" >> "$LOG"
  restart_daemon
fi
