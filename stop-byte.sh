#!/bin/bash
echo "DEPRECATED: use 'hydra down <platform>' instead (bun cli/hydra.ts down discord)" >&2
set -euo pipefail
# Stop a platform's byte session and kill orphaned claude processes.
# Mirrors the cleanup in the CLI's startByte (cli/lifecycle.ts).
#
# Required env:
#   CHAT_PLATFORM — discord or slack

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env-setup.sh"

SESSION="${BYTE_SESSION_NAME:-${CHAT_PLATFORM}-byte}"
SOCK="${DAEMON_SOCK:-$STATE_DIR/daemon.sock}"
LOG="${HYDRA_BYTE_LOG:-$HOME/hydra-${CHAT_PLATFORM}-byte.log}"

tmux kill-session -t "$SESSION" 2>/dev/null || true

source "$SCRIPT_DIR/kill-orphan-bytes.sh"
_kill_orphan_bytes "killing" ""
sleep 2
_kill_orphan_bytes "force-killing surviving" "-9"

echo "$(date): ${CHAT_PLATFORM} byte stopped" >> "$LOG"
echo "${CHAT_PLATFORM} byte stopped."
