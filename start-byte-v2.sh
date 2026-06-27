#!/bin/bash
# Start Byte (Claude Code Discord bot) using the daemon+bridge architecture.
# Requires the daemon to be running first (start-daemon.sh).
SESSION="${BYTE_SESSION_NAME:-byte}"
CHANNEL="${BYTE_CHANNEL:-1487715706043629658}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOCK="${DAEMON_SOCK:-$HOME/.claude/channels/discord/daemon.sock}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude-personal}"
CWD="${BYTE_CWD:-$HOME/trading}"

# Check daemon is running
if [ ! -S "$SOCK" ]; then
  echo "ERROR: daemon socket not found at $SOCK"
  echo "Start the daemon first: $SCRIPT_DIR/start-daemon.sh"
  exit 1
fi

# Kill existing byte session
tmux kill-session -t "$SESSION" 2>/dev/null
sleep 2

# Symlink bridge.ts into the plugin cache as server.ts so it always runs from source.
SRC="$SCRIPT_DIR/bridge.ts"
DEST="$CONFIG_DIR/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts"
if [ ! -f "$SRC" ]; then
  echo "ERROR: bridge.ts missing at $SRC" >&2
  exit 1
fi
if [ ! -d "$(dirname "$DEST")" ]; then
  echo "ERROR: plugin cache dir missing at $(dirname "$DEST")" >&2
  exit 1
fi
ln -sf "$SRC" "$DEST"
echo "$(date): symlinked bridge.ts into plugin cache as server.ts" >> ~/byte-restarts.log

# Start byte with --channels (bridge connects to daemon via unix socket).
# HYDRA_BRIDGE_AUTOCONNECT=1 is required: bridge.ts won't connect to the daemon
# without it, to prevent unrelated Claude sessions that have the plugin installed
# from also claiming the `main` session slot.
tmux new-session -d -s "$SESSION" \
  "cd '$CWD' && export DAEMON_SOCK='$SOCK' && export CLAUDE_CONFIG_DIR=$CONFIG_DIR && export HYDRA_BRIDGE_AUTOCONNECT=1 && caffeinate -i claude --model 'claude-opus-4-6[1m]' --channels plugin:discord@claude-plugins-official --no-chrome --dangerously-skip-permissions \
  \"You just restarted with a fresh context. Read your memory files, then send a message to Discord channel ${CHANNEL} letting them know you're back online.\""

echo "$(date): Byte v2 started (daemon+bridge)" >> ~/byte-restarts.log
echo "Byte started. Attach with: tmux attach -t $SESSION"
