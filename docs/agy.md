# agy: Google's models in a hydra session

`spawn neon: topic` starts a session on Google's Antigravity CLI (`agy`) and Gemini 4 Neon. The aliases are `neon`, `carbon`, `hydrogen`, `argon` and `flash` (Gemini 3.8 Flash); any `gemini-*` id from `agy models` also selects it. `spawn-wt neon: repo topic` starts one in a worktree. A specialist may run on it (`engine = "agy"` or `model = "neon"`) unrestricted; `restricted` and `can_only_write_to` are refused, because agy cannot limit what a session reaches.

It runs in tmux like a Claude session, so `tmux attach -t <name>` shows it and you can type in it.

## Setup

1. Install agy (`curl -fsSL https://antigravity.google/cli/install.sh | bash`; it lands in `~/.local/bin`, which the daemon's PATH needs, or set `HYDRA_AGY_BIN`).
2. Give it a login. Either sign in once by running `agy` (a Google account; the free "Starter" plan has no Neon, AI Pro or Ultra does), or put a Gemini API key (paid tier) in `<state>/agy-api-key`, mode 0600. With the file, every agy session runs in API-key mode; without it, on agy's own login.
3. Each launch makes sure `~/.gemini/config/mcp_config.json` has a `hydra` server (the tool server Codex uses) and `~/.gemini/config/hooks.json` has a `hydra` hook group. In your own agy runs the hook does nothing, and `/mcp` lists the `hydra` server as failed ("DAEMON_SOCK and HYDRA_SESSION_ID required"): harmless.

## How it works

- **Messages in:** there is no channel into agy, so hydra pastes each message into the pane (a bracketed paste, then Enter, one at a time per session) and waits for the pane to show it. agy queues a message that arrives mid-turn. A message the pane never shows is reported as a non-retryable rejection: it may have been sent, and a retry could paste it twice.
- **Tools out:** reply, react, send_to_thread and the rest are MCP tools of the `hydra` server.
- **Turn end, answer, tokens:** agy's hook (`daemon/agy-hook.ts`) records the conversation and working/idle in `<state>/agy-sessions/<session>.json`; the turn's answer and token counts come from agy's transcript (`~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/`).
- **Resume:** `respawn` and revive continue the conversation with `agy --conversation <id>`; boot recovery does not relaunch agy sessions (a daemon restart leaves the tmux pane running; a machine reboot needs `respawn`).

## Limits

- `fork_from`, `read_only` and templates (`+f`) are refused.
- Run one hydra daemon per user: agy's MCP and hook entries (`~/.gemini/config`) point at the checkout that launched last, so a second daemon would repoint a running session's hook.
- The pane check for a delivered message proves the paste reached the pane, not (for a short message) that Enter sent it.
- Context percent assumes a 1,048,576-token window for every Gemini model, and token spend leaves out thinking tokens: unverified.
- agy's first-run screens (colour scheme, terms, data sharing) are answered once by hand; the launch trusts each session's folder through `--settings`, which agy does not save.
