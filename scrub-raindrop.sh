# Sourced by env-setup.sh and start-transcribe.sh; must run after any .env.
for _rd_v in RAINDROP_WRITE_KEY RAINDROP_MODE RAINDROP_USER_ID RAINDROP_OMIT_REPO SLOPBOT_SLACK_APP_TOKEN SLOPBOT_SLACK_BOT_TOKEN HYDRA_SLACK_APP_TOKEN HYDRA_SLACK_BOT_TOKEN HYDRA_SLACK_USER_TOKEN; do
  unset "$_rd_v"
  tmux set-environment -gr "$_rd_v" 2>/dev/null || true
done
# The token variables hydra.toml names, whatever they are called (the loop above has only the usual names, and never depends on this).
# `hydra slack token-vars` prints only names the loader accepts; the case below refuses, again, every variable a shell, tmux or
# Claude needs (the same set as NEVER_SCRUBBED in shared/spawn-env.ts, which a test compares), so a bad lookup can never unset PATH.
# When the lookup cannot run, one line on stderr says custom variables were not scrubbed; it never stops the shell that sourced this.
if [ -n "${STATE_DIR:-}" ] && [ -n "${SCRIPT_DIR:-}" ] && command -v bun >/dev/null 2>&1 && _rd_names=$(bun "$SCRIPT_DIR/cli/hydra.ts" --state-dir "$STATE_DIR" slack token-vars 2>/dev/null); then
  while IFS= read -r _rd_v; do
    case "$_rd_v" in
      ''|*[!A-Z0-9_]*) continue ;;
      HYDRA_SLACK_*) ;;
      PATH|HOME|USER|LOGNAME|SHELL|TMUX|TERM|PWD|TMPDIR|LANG|ANTHROPIC_API_KEY|GH_TOKEN|SSH_AUTH_SOCK|HYDRA_*|CLAUDE_*|LC_*|XDG_*) continue ;;
    esac
    unset "$_rd_v"
    tmux set-environment -gr "$_rd_v" 2>/dev/null || true
  done <<_RD_EOF
$_rd_names
_RD_EOF
else
  echo "hydra: custom Slack token variables named in hydra.toml were not scrubbed from this shell (could not run \`hydra slack token-vars\`: no STATE_DIR, SCRIPT_DIR or bun, or it failed)" >&2
fi
unset _rd_v _rd_names
