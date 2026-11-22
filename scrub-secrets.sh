# Sourced by env-setup.sh and start-transcribe.sh; must run after any .env.
for _ss_v in SLOPBOT_SLACK_APP_TOKEN SLOPBOT_SLACK_BOT_TOKEN HYDRA_SLACK_APP_TOKEN HYDRA_SLACK_BOT_TOKEN HYDRA_SLACK_USER_TOKEN DISCORD_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN; do
  unset "$_ss_v"
  tmux set-environment -gr "$_ss_v" 2>/dev/null || true
done
# The token variables hydra.toml names (Slack apps', the Discord gateway's, each server's token_env), whatever they are called (the loop above has only the usual names, and never depends on this).
# `hydra slack token-vars` prints only names the loader accepts; the case below refuses, again, every variable a shell, tmux or
# Claude needs (the same set as NEVER_SCRUBBED in shared/spawn-env.ts, which a test compares), so a bad lookup can never unset PATH.
# When the lookup cannot run, one line on stderr says custom variables were not scrubbed; it never stops the shell that sourced this.
if [ -n "${STATE_DIR:-}" ] && [ -n "${SCRIPT_DIR:-}" ] && command -v bun >/dev/null 2>&1 && _ss_names=$(bun "$SCRIPT_DIR/cli/hydra.ts" --state-dir "$STATE_DIR" slack token-vars 2>/dev/null); then
  while IFS= read -r _ss_v; do
    case "$_ss_v" in
      ''|*[!A-Z0-9_]*) continue ;;
      HYDRA_SLACK_*) ;;
      PATH|HOME|USER|LOGNAME|SHELL|TMUX|TERM|PWD|TMPDIR|LANG|ANTHROPIC_API_KEY|GH_TOKEN|SSH_AUTH_SOCK|HYDRA_*|CLAUDE_*|LC_*|XDG_*) continue ;;
    esac
    unset "$_ss_v"
    tmux set-environment -gr "$_ss_v" 2>/dev/null || true
  done <<_SS_EOF
$_ss_names
_SS_EOF
else
  echo "hydra: custom token variables named in hydra.toml were not scrubbed from this shell (could not run \`hydra slack token-vars\`: no STATE_DIR, SCRIPT_DIR or bun, or it failed)" >&2
fi
unset _ss_v _ss_names
