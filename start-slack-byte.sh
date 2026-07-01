#!/bin/bash
# Start Slack Byte (Claude Code Slack bot) using the daemon+bridge architecture.
# Requires the Slack daemon to be running first.
SESSION="${BYTE_SESSION_NAME:-slack-byte}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOCK="${DAEMON_SOCK:-$HOME/.claude/channels/slack/daemon.sock}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude-byte}"
GREET_CHANNEL="${BYTE_CHANNEL:-}"   # optional: DM/channel id to greet on launch; empty = start silent
CWD="${BYTE_CWD:-$HOME/RubymineProjects}"
TOKEN_FILE="${HYDRA_CLAUDE_TOKEN_FILE:-$HOME/.hydra-claude-token}"

# Check daemon is running
if [ ! -S "$SOCK" ]; then
  echo "ERROR: Slack daemon socket not found at $SOCK"
  echo "Start the Slack daemon first:"
  echo "  HYDRA_STATE_DIR=\$HOME/.claude/channels/slack CHAT_PLATFORM=slack $SCRIPT_DIR/start-daemon.sh"
  exit 1
fi

# Kill existing slack-byte session and any orphaned claude processes.
# Claude survives tmux session death. If a new byte starts while the old claude
# is still alive, both register as 'main' on the daemon and continuously evict
# each other — no messages get delivered until one is killed.
# Assumes Claude Code binary is named 'claude' (Homebrew install).
tmux kill-session -t "$SESSION" 2>/dev/null
LOG=~/slack-byte-restarts.log
source "$SCRIPT_DIR/kill-orphan-bytes.sh"
_kill_orphan_bytes "killing" ""
sleep 2
_kill_orphan_bytes "force-killing surviving" "-9"

# Symlink bridge.ts into the plugin cache so it always runs from source
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
echo "$(date): symlinked bridge.ts into plugin cache" >> ~/slack-byte-restarts.log

# Launch prompt: with BYTE_CHANNEL set, greet that DM/channel; otherwise start silent and
# just wait for incoming messages (no hardcoded channel).
if [ -n "$GREET_CHANNEL" ]; then
  PROMPT="You just restarted with a fresh context. You're running on Slack via the bridge. Read your memory files, then send a brief greeting to Slack chat ${GREET_CHANNEL} using reply(chat_id=${GREET_CHANNEL})."
else
  PROMPT="You just restarted with a fresh context. You're running on Slack via the bridge. Read your memory files to orient, then wait silently for incoming Slack messages — do NOT post anything proactively. When a message arrives, reply with the reply tool using the chat_id from the incoming message."
fi

# Start slack-byte
# CLAUDE_CONFIG_DIR is separate from discord (~/.claude-slack) so each platform
# gets its own plugin cache with its own daemon.json pointing to the right socket.
# Auth is pinned to the AngelList work account via CLAUDE_CODE_OAUTH_TOKEN, which
# overrides the config dir's keychain login. This guarantees Slack bills work
# regardless of what account ~/.claude-slack happens to be logged into, and is
# immune to CLAUDE_CONFIG_DIR failing to propagate into the spawned process.
tmux new-session -d -s "$SESSION" \
  "cd '$CWD' && export DAEMON_SOCK='$SOCK' && export CLAUDE_CONFIG_DIR='$CONFIG_DIR' && export CLAUDE_CODE_OAUTH_TOKEN=\"\$(cat '$TOKEN_FILE')\" && caffeinate -i claude --model 'claude-opus-4-8[1m]' --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions \
  \"$PROMPT\""

echo "$(date): Slack Byte started (daemon+bridge)" >> ~/slack-byte-restarts.log
echo "Slack Byte started. Attach with: tmux attach -t $SESSION"
