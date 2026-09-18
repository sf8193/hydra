# Slack Setup

Hydra bridges a Slack app to a Claude Code session: you DM the bot (or @mention it in a channel) and Claude replies, with the ability to spawn isolated sub-sessions in threads.

**Flow:** `Slack ⇄ SlackGateway ⇄ daemon ⇄ bridge (MCP plugin) ⇄ Claude Code`. The daemon holds one Slack Socket-Mode connection and routes messages; the bridge is an MCP server loaded into Claude that relays messages and tool calls over a unix socket.

## Prerequisites

- `bun`, `tmux`, and the `claude` CLI on your PATH
- A Slack workspace where you can create an app (or an admin who can approve one)

## 1. Create the Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, pick your workspace, and paste this JSON. **Give it a unique name** (app names must be unique in a workspace):

```json
{
  "display_information": { "name": "YourBot", "description": "Claude Code chat bridge", "background_color": "#2c2c2c" },
  "features": {
    "app_home": { "home_tab_enabled": true, "messages_tab_enabled": true, "messages_tab_read_only_enabled": false },
    "bot_user": { "display_name": "YourBot", "always_online": true }
  },
  "oauth_config": {
    "scopes": { "bot": [
      "app_mentions:read", "channels:history", "channels:read", "chat:write",
      "files:read", "files:write", "groups:history", "groups:read",
      "im:history", "im:read", "im:write", "mpim:history",
      "reactions:read", "reactions:write", "users:read"
    ] }
  },
  "settings": {
    "event_subscriptions": { "bot_events": ["app_home_opened", "app_mention", "message.channels", "message.groups", "message.im", "reaction_added"] },
    "interactivity": { "is_enabled": true },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

> **Use your own app — don't share one.** A Slack app is a single event stream: pointing a second daemon at the same app token splits messages unpredictably across both. One app per deployment.

**Already installed?** App Manifest → add `"reaction_added"` to `settings.event_subscriptions.bot_events` → Save → Reinstall. `reactions:read` is already in the scopes.

## 2. Generate the two tokens

- **App-level token** (Socket Mode): Basic Information → App-Level Tokens → **Generate** → name it `socket-mode`, scope `connections:write`. Copy the `xapp-…` token.
- **Bot token**: OAuth & Permissions → **Bot User OAuth Token** (appears after install, step 3). Copy the `xoxb-…` token.

## 3. Install to workspace

Install App → **Install to Workspace** → Authorize. (Org-restricted workspaces may need admin approval of the scopes.)

## 4. Config files

Both live in the daemon's **state dir** — default `~/.claude/channels/slack/` (override with `DISCORD_STATE_DIR`).

`.env` (see [`.env.example`](../.env.example)):

```bash
CHAT_PLATFORM=slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

`access.json` — who may DM the bot (find your Slack user id via Profile → ⋮ → Copy member ID):

```json
{
  "dmPolicy": "allowlist",
  "ackReaction": "👀",
  "allowFrom": ["UXXXXXXXX"],
  "groups": {},
  "pending": {}
}
```

`ackReaction` (optional) makes the bot react to every message it receives, so you know it's processing.

## 5. Enable the bridge plugin — and the channels gate

The bridge runs as the `discord@claude-plugins-official` plugin (the name is historical; it's platform-agnostic). Install it **into the config dir the daemon will use** (see step 6 — `CLAUDE_CONFIG_DIR`):

```bash
claude plugin install discord@claude-plugins-official
```

> ⚠️ **The `channelsEnabled` gate — the #1 silent failure.** On claude.ai **Team/Enterprise** plans the `--channels` feature is **blocked unless managed settings opt in**, and inbound messages are then *silently dropped* — the bot looks completely dead with no error. Fix it once (macOS; you are the local "administrator"):
> ```bash
> sudo mkdir -p "/Library/Application Support/ClaudeCode"
> echo '{"channelsEnabled": true}' | sudo tee "/Library/Application Support/ClaudeCode/managed-settings.json"
> ```
> A *user*-level `settings.json` does **not** work — it must be managed settings.

> ⚠️ **Disable any native Slack connector** (claude.ai → Connectors). If Claude has a built-in Slack/Runlayer connector, it may post through that — under *your* username, not the bot — instead of the bridge. The bridge is what makes messages come from the bot app.

## 6. Run

Check readiness first:

```bash
CHAT_PLATFORM=slack DISCORD_STATE_DIR=~/.claude/channels/slack CLAUDE_CONFIG_DIR=~/.claude ./preflight.sh
```

Then start the daemon, then the bot:

```bash
# 1) Daemon. CLAUDE_CONFIG_DIR MUST be a dir that has the bridge plugin (it's also the config
#    spawned sub-sessions inherit). SPAWN_CWD is required (cwd for spawned sessions).
CLAUDE_CONFIG_DIR=~/.claude DISCORD_STATE_DIR=~/.claude/channels/slack CHAT_PLATFORM=slack \
  SPAWN_CWD=~/work ./start-daemon.sh

# 2) Bot (after the socket appears). Set BYTE_CHANNEL to greet a DM on launch, or leave it
#    unset to start silently and just wait for messages.
CHAT_PLATFORM=slack ./start-byte.sh
```

Healthy = daemon log shows `slack gateway: connected as <bot>` **and** `bridge registered for session main`. Then DM the bot.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Bot never responds, no error | `channelsEnabled` gate (step 5) — check managed settings first. |
| Bot replies as *your username* ("Sent using Runlayer…") | A native Slack connector is intercepting — disable it (step 5). |
| Spawned session greets but ignores your thread replies | The daemon's `CLAUDE_CONFIG_DIR` lacks the bridge plugin, so the spawn never registered. Start the daemon with `CLAUDE_CONFIG_DIR` pointing at a dir that has it (step 6). |
| `start-byte.sh`: "socket not found" | Daemon isn't up — run step 6.1 first. |
| Daemon exits immediately | `SPAWN_CWD` is required. |

## Message formatting

Plain replies are sent via Slack's `markdown_text` field, so the bot can use the **full GitHub-flavored Markdown palette** and it renders natively:

- **bold** (`**x**`), _italic_ (`_x_`), ~strike~ (`~~x~~`), `inline code`
- fenced ```code blocks```, `> blockquotes`, `---` dividers
- bullet lists (`- ` / `* `, nested), numbered lists (`1.`), and **tables** (`| a | b |`)
- headings (`#`), links (`[label](url)`), and emoji (`:tada:` / unicode)

Constraints: `markdown_text` caps at ~12k chars (longer messages fall back to classic mrkdwn), and **button/permission prompts** use Block Kit (classic mrkdwn, fewer features). This layer only guarantees the palette renders — it imposes **no house style**. How a given bot *presents* (terse vs detailed, emoji, when to use a table vs bullets) belongs in that bot's own instructions / `CLAUDE.md`.

## Spawned sessions

DM `spawn: <anything, multi-paragraph ok>` to fork an isolated Claude session in a thread. The confirmation includes `tmux attach -t <name>` so you can view/drive it from any terminal. Replies in that thread route back to the spawned session; the rest of your DMs go to the main session.
