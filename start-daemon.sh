#!/bin/bash
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
export PATH="$HOME/.asdf/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SESSION="${TMUX_SESSION:-discord-daemon}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="${HYDRA_STATE_DIR:-${DISCORD_STATE_DIR:-$HOME/.claude/channels/${CHAT_PLATFORM:-discord}}}"
LOG="${HYDRA_LOG:-$HOME/hydra-daemon.log}"

if [ -z "$SPAWN_CWD" ]; then
  echo "ERROR: SPAWN_CWD is required. Set it to the working directory for spawned sessions."
  echo "  Example: SPAWN_CWD=~/trading ./start-daemon.sh"
  exit 1
fi

# Kill existing daemon session
tmux kill-session -t "$SESSION" 2>/dev/null
sleep 1

# Remove stale socket
rm -f "$STATE_DIR/daemon.sock"

# Start daemon.
# Forward env EXPLICITLY into the tmux command. tmux does NOT reliably inherit arbitrary
# vars into new sessions — its server global env is frozen at first launch — so relying on
# inheritance silently dropped CLAUDE_CONFIG_DIR and broke spawned-session bridges.
# PATH must also be forwarded so bun/claude are reachable when launched via launchd.
ENVS="PATH='$PATH' HYDRA_STATE_DIR='$STATE_DIR' SPAWN_CWD='$SPAWN_CWD'"
[ -n "$CHAT_PLATFORM" ] && ENVS="$ENVS CHAT_PLATFORM='$CHAT_PLATFORM'"
[ -n "$CLAUDE_CONFIG_DIR" ] && ENVS="$ENVS CLAUDE_CONFIG_DIR='$CLAUDE_CONFIG_DIR'"
tmux new-session -d -s "$SESSION" \
  "cd '$SCRIPT_DIR' && $ENVS bun run daemon.ts 2>&1 | tee -a $LOG"

echo "$(date): Daemon started in tmux session '$SESSION' (SPAWN_CWD=$SPAWN_CWD)" >> $LOG
echo "Daemon started. Attach with: tmux attach -t $SESSION"
