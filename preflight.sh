#!/bin/bash
# hydra preflight — verify a deployment has everything it needs before you start the daemon/bot.
# Encodes the non-obvious failure modes (channels gate, bridge-in-config-dir) as checks.
#
# Usage:
#   CHAT_PLATFORM=slack HYDRA_STATE_DIR=~/.claude/channels/slack \
#     CLAUDE_CONFIG_DIR=~/.claude ./preflight.sh

PLATFORM="${CHAT_PLATFORM:-discord}"
STATE_DIR="${HYDRA_STATE_DIR:-${DISCORD_STATE_DIR:-$HOME/.claude/channels/$PLATFORM}}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
fail=0; warn=0
ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; fail=1; }
wrn() { printf "  \033[33m⚠\033[0m %s\n" "$1"; warn=1; }

echo "hydra preflight — platform=$PLATFORM"
echo "  state dir : $STATE_DIR"
echo "  config dir: $CONFIG_DIR"
echo

# --- tooling ---
for c in bun tmux claude; do
  command -v "$c" >/dev/null 2>&1 && ok "$c on PATH" || bad "$c not found on PATH"
done

# --- tokens (.env) ---
ENV="$STATE_DIR/.env"
if [ -f "$ENV" ]; then
  ok ".env present"
  if [ "$PLATFORM" = slack ]; then
    grep -q '^SLACK_BOT_TOKEN=xoxb-' "$ENV" && ok "SLACK_BOT_TOKEN set (xoxb-)" || bad "SLACK_BOT_TOKEN missing or not xoxb- in .env"
    grep -q '^SLACK_APP_TOKEN=xapp-' "$ENV" && ok "SLACK_APP_TOKEN set (xapp-)" || bad "SLACK_APP_TOKEN missing or not xapp- in .env"
  else
    grep -q '^DISCORD_BOT_TOKEN=.' "$ENV" && ok "DISCORD_BOT_TOKEN set" || bad "DISCORD_BOT_TOKEN missing in .env"
  fi
else
  bad ".env missing at $ENV (see .env.example)"
fi

# --- access control ---
[ -f "$STATE_DIR/access.json" ] && ok "access.json present" \
  || wrn "access.json missing — no users are allowlisted yet ($STATE_DIR/access.json)"

# --- bridge plugin must live in the config dir the daemon spawns under ---
BRIDGE_DIR="$CONFIG_DIR/plugins/cache/claude-plugins-official/discord"
if ls "$BRIDGE_DIR"/*/server.ts >/dev/null 2>&1; then
  ok "bridge plugin present in config dir"
else
  bad "bridge plugin NOT in $CONFIG_DIR — sessions can't reach the daemon. Install: claude plugin install discord@claude-plugins-official"
fi

# --- channels feature gate (claude.ai Team/Enterprise: blocked unless managed-settings opts in) ---
if [ "$(uname)" = Darwin ]; then
  MS="/Library/Application Support/ClaudeCode/managed-settings.json"
  if [ -f "$MS" ] && grep -q '"channelsEnabled"[[:space:]]*:[[:space:]]*true' "$MS"; then
    ok "channelsEnabled=true (managed settings)"
  else
    wrn "channelsEnabled not true in managed settings — on Team/Enterprise plans inbound is SILENTLY dropped (bot looks dead). Fix: sudo write {\"channelsEnabled\": true} to $MS"
  fi
fi

echo
if [ "$fail" = 1 ]; then
  echo "RESULT: NOT READY — fix the ✗ items above."; exit 1
elif [ "$warn" = 1 ]; then
  echo "RESULT: ready, with warnings (⚠) — review above."; exit 0
else
  echo "RESULT: all checks passed."; exit 0
fi
