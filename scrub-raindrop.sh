# Sourced by env-setup.sh and start-transcribe.sh; must run after any .env.
for _rd_v in RAINDROP_WRITE_KEY RAINDROP_MODE RAINDROP_USER_ID RAINDROP_OMIT_REPO SLOPBOT_SLACK_APP_TOKEN SLOPBOT_SLACK_BOT_TOKEN HYDRA_SLACK_APP_TOKEN HYDRA_SLACK_BOT_TOKEN HYDRA_SLACK_USER_TOKEN; do
  unset "$_rd_v"
  tmux set-environment -gr "$_rd_v" 2>/dev/null || true
done
unset _rd_v
