#!/bin/bash
# Shared preamble for all hydra shell scripts.
# Source this at the top: source "$SCRIPT_DIR/env-setup.sh"
#
# Provides:
#   PATH — includes homebrew, asdf shims, npm-global, ~/.local/bin
#   SCRIPT_DIR — absolute path to the hydra repo
#   STATE_DIR — platform-scoped state directory
#   CHAT_PLATFORM — discord (default) or slack
#   .env sourced from STATE_DIR if present

[[ "$OSTYPE" == darwin* ]] || { echo "env-setup: hydra requires macOS" >&2; exit 1; }

export PATH="$HOME/.npm-global/bin:$HOME/.asdf/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

: "${SCRIPT_DIR:=$(cd "$(dirname "${BASH_SOURCE[1]:-$0}")" && pwd)}"
if [ -z "${CHAT_PLATFORM:-}" ]; then
  # Refuse to default when multiple platform state dirs exist — silent default would misroute
  _platform_count=0
  for _d in "$HOME/.claude/channels"/*/; do
    [ -d "$_d" ] && _platform_count=$((_platform_count + 1))
  done
  if [ "$_platform_count" -gt 1 ]; then
    echo "env-setup: ERROR: CHAT_PLATFORM not set and $_platform_count platform state dirs exist" >&2
    echo "env-setup: set CHAT_PLATFORM explicitly (e.g. CHAT_PLATFORM=discord)" >&2
    exit 1
  fi
  echo "env-setup: WARNING: CHAT_PLATFORM not set, defaulting to 'discord'" >&2
  CHAT_PLATFORM=discord
fi

STATE_DIR="${HYDRA_STATE_DIR:-${DISCORD_STATE_DIR:-$HOME/.claude/channels/${CHAT_PLATFORM}}}"

# Source .env from state dir for persistent config (SPAWN_CWD, CLAUDE_CONFIG_DIR, etc.)
if [ -f "$STATE_DIR/.env" ]; then
  set -a
  . "$STATE_DIR/.env"
  set +a
fi

if [ -f "$SCRIPT_DIR/scrub-raindrop.sh" ]; then
  . "$SCRIPT_DIR/scrub-raindrop.sh"
elif env | grep -q '^RAINDROP_'; then
  echo "hydra: scrub-raindrop.sh missing and RAINDROP_ vars are set — refusing to spawn" >&2
  exit 1
else
  echo "hydra: scrub-raindrop.sh missing (no RAINDROP_ vars set; continuing)" >&2
fi
