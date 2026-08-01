#!/bin/bash
echo "DEPRECATED: use 'hydra up <platform>' instead (bun cli/hydra.ts up discord)" >&2
set -euo pipefail
# Start the byte (Claude Code bot) using the daemon+bridge architecture.
# Requires the daemon to be running first (start-daemon.sh).
#
# Works for any platform — parameterized by CHAT_PLATFORM.
#
# Required env:
#   CHAT_PLATFORM — discord or slack
#
# Optional env:
#   BYTE_SESSION_NAME — tmux session name (default: ${CHAT_PLATFORM}-byte)
#   BYTE_CHANNEL — channel to greet on launch (default: silent start)
#   BYTE_CWD — working directory (default: $SPAWN_CWD or $HOME)
#   DAEMON_SOCK — daemon socket path
#   CLAUDE_CONFIG_DIR — config dir for Claude (default: ~/.claude).
#                      Slack MUST set this in .env — the old start-slack-byte.sh
#                      defaulted to ~/.claude-slack; this unified script does not.
#   CLAUDE_CODE_OAUTH_TOKEN — override auth token (used by slack for work account)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env-setup.sh"

SESSION="${BYTE_SESSION_NAME:-${CHAT_PLATFORM}-byte}"
SOCK="${DAEMON_SOCK:-$STATE_DIR/daemon.sock}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CWD="${BYTE_CWD:-${SPAWN_CWD:-$HOME}}"
GREET_CHANNEL="${BYTE_CHANNEL:-}"
LOG="${HYDRA_BYTE_LOG:-$HOME/hydra-${CHAT_PLATFORM}-byte.log}"

# Check daemon is running
if [ ! -S "$SOCK" ]; then
  echo "ERROR: daemon socket not found at $SOCK"
  echo "Start the daemon first: CHAT_PLATFORM=$CHAT_PLATFORM $SCRIPT_DIR/start-daemon.sh"
  exit 1
fi

# Kill existing byte session and any orphaned claude processes.
# Claude survives tmux session death. If a new byte starts while the old claude
# is still alive, both register as 'main' on the daemon and continuously evict
# each other — no messages get delivered until one is killed.
tmux kill-session -t "$SESSION" 2>/dev/null || true
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
echo "$(date): symlinked bridge.ts into plugin cache" >> "$LOG"

# Build prompt — with BYTE_CHANNEL set, greet that channel; otherwise start silent
if [ -n "$GREET_CHANNEL" ]; then
  PROMPT="You just restarted with a fresh context. You're running on ${CHAT_PLATFORM} via the bridge. Read your memory files, then send a brief greeting to chat ${GREET_CHANNEL} using reply(chat_id=${GREET_CHANNEL})."
else
  PROMPT="You just restarted with a fresh context. You're running on ${CHAT_PLATFORM} via the bridge. Read your memory files to orient, then wait silently for incoming messages — do NOT post anything proactively. When a message arrives, reply with the reply tool using the chat_id from the incoming message."
fi

# Auth override — write token to a runtime-readable file to avoid interpolating
# secrets into the tmux command string.
AUTH_EXPORT=""
TOKEN_FILE="$STATE_DIR/.byte-token"
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  AUTH_EXPORT="export CLAUDE_CODE_OAUTH_TOKEN=\"\$(cat '$TOKEN_FILE')\" &&"
elif [ -f "$HOME/.angellist-claude-token" ] && [ "$CHAT_PLATFORM" = "slack" ]; then
  AUTH_EXPORT="export CLAUDE_CODE_OAUTH_TOKEN=\"\$(cat \$HOME/.angellist-claude-token)\" &&"
fi

# Start byte
tmux new-session -d -s "$SESSION" \
  "cd '$CWD' && export DAEMON_SOCK='$SOCK' && export CLAUDE_CONFIG_DIR='$CONFIG_DIR' && export CHAT_PLATFORM=$CHAT_PLATFORM && export HYDRA_ROLE=main && $AUTH_EXPORT caffeinate -i claude --model 'claude-opus-4-6[1m]' --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions \
  \"$PROMPT\""

echo "$(date): ${CHAT_PLATFORM} byte started (daemon+bridge)" >> "$LOG"
echo "${CHAT_PLATFORM} byte started. Attach with: tmux attach -t $SESSION"
