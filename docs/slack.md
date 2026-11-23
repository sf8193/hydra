# Slack Setup

Hydra bridges a Slack app to a Claude Code session: you DM the bot (or @mention it in a channel) and Claude replies, with the ability to spawn isolated sub-sessions in threads.

**Two Slack systems.** Hydra talks to Slack in two ways. They are alike in using Slack apps over Socket Mode and in ending at Claude sessions. They differ in what they are for:

| | **The Slack gateway** | **The Slack connector** |
|---|---|---|
| What it is | Slack as the operator's own chat surface (`gateways/slack.ts`, `CHAT_PLATFORM=slack`), as Discord is for a Discord daemon | Slack as a source of events, routed by hydra.toml (`connectors/slack/`, in every daemon, Discord's included) |
| What it does | the operator talks to the byte, spawns sessions in threads, runs commands | delivers what its apps hear to specialists, to threads bound to sessions, and to restricted specialists; it runs no commands, and routing never reads what a message says |
| Configured by | `.env` (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`) and `hydra.toml` (`operator`, `[places.…access]`, `[gateways.slack]`) | `[slack.apps.<id>]`, `[[rules]]`, `reachable_by` in hydra.toml |
| Connections | one, on the gateway's app | one per app declared, each with an optional operator token (reads; rewrites the operator's own messages from main) |

Steps 1–6 below set up the gateway. [Apps in hydra.toml](slack-connector.md#apps-in-hydratoml) onward is the connector.

**Flow (gateway):** `Slack ⇄ SlackGateway ⇄ daemon ⇄ bridge (MCP plugin) ⇄ Claude Code`. The bridge is an MCP server loaded into Claude that relays messages and tool calls over a unix socket.

## Prerequisites

- `bun`, `tmux`, and the `claude` CLI on your PATH
- A Slack workspace where you can create an app (or an admin who can approve one)

## 1. Create the Slack app

*Slack gateway.* Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, pick your workspace, and paste this JSON. **Give it a unique name** (app names must be unique in a workspace):

```json
{
  "display_information": { "name": "YourBot", "description": "Claude Code chat bridge", "background_color": "#2c2c2c" },
  "features": {
    "app_home": { "home_tab_enabled": true, "messages_tab_enabled": true, "messages_tab_read_only_enabled": false },
    "bot_user": { "display_name": "YourBot", "always_online": true },
    "agent_view": { "agent_description": "Claude Code chat bridge" }
  },
  "oauth_config": {
    "scopes": { "bot": [
      "app_mentions:read", "assistant:write", "channels:history", "channels:read", "chat:write",
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

> **Use your own app — don't share one.** A Slack app is a single event stream: pointing a second daemon at the same app token splits messages unpredictably across both. One daemon per app token.

**Already installed?** App Manifest → add `"reaction_added"` to `settings.event_subscriptions.bot_events` → Save → Reinstall. `reactions:read` is already in the scopes.

**Thread titles:** each session thread is titled with its emoji, name and description through Slack's Agents feature. On an existing app: Agents → turn on **Agent experience** (this adds `assistant:write`) → Reinstall, then restart the daemon. This also moves the bot's DMs to Slack's agent layout. Without it, threads stay untitled and the daemon logs why.

## 2. Generate the two tokens

*Slack gateway.*

- **App-level token** (Socket Mode): Basic Information → App-Level Tokens → **Generate** → name it `socket-mode`, scope `connections:write`. Copy the `xapp-…` token.
- **Bot token**: OAuth & Permissions → **Bot User OAuth Token** (appears after install, step 3). Copy the `xoxb-…` token.

## 3. Install to workspace

*Slack gateway.* Install App → **Install to Workspace** → Authorize. (Org-restricted workspaces may need admin approval of the scopes.)

## 4. Config files

*Slack gateway.* Both live in the daemon's **state dir** — default `~/.claude/channels/slack/` (override with `HYDRA_STATE_DIR`).

`.env` (see [`.env.example`](../.env.example)):

```bash
CHAT_PLATFORM=slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SPAWN_CWD=~/work      # must be an existing directory
```

`hydra.toml` — who may DM the bot (find your Slack user id via Profile → ⋮ → Copy member ID). Step 6 runs `hydra migrate slack --operator UXXXXXXXX` (after `install`, before `up`), which writes:

```toml
operator = "operator"

[people.operator]
addresses = ["slack:UXXXXXXXX"]
```

To let the bot into a channel, tag it there as the operator: it adds `[places."slack:<channel id>".access]` to `hydra.toml`. Gate settings for the workspace go under `[gateways.slack]` (`ack_reaction`, `listen`, `off`, `mention_patterns`).

A tag in a channel the bot is in arrives as two events, `message` (with the message's files) and `app_mention`. The gateway delivers one: the `message` copy; an `app_mention` waits one second for it and is delivered alone only when none comes (a channel the bot is not in). An event carrying a `bot_id` (another app's `@bot` mention, or its file post) reaches the daemon as a bot's and is not answered; an app's plain `bot_message` posts are dropped at the gateway, as before.

**The gateway's app is not a connector app.** The gateway opens its own Socket Mode connection with `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. The connector opens one more for each app hydra.toml declares, in every daemon. If hydra.toml declares an app whose `bot_token_env`/`socket_token_env` name those same two variables, the same Slack app gets two connections, and Slack hands each event to only one of them, unpredictably. On a Slack daemon (`CHAT_PLATFORM=slack`) hydra.toml refuses such an app when it loads, naming the key; `hydra config check slack` says the same. So to route Slack by specialists and rules beside the gateway, create a **separate** Slack app for the connector and declare that one ([Apps in hydra.toml](slack-connector.md#apps-in-hydratoml)), with its own variables:

```toml
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"
socket_token_env = "CONNECTOR_SLACK_APP_TOKEN"
```

hydra.toml never holds a token, only the names of the variables that do. Keep one connection per token pair: do not point two apps, the gateway and an app, or a second daemon at the same one.

`ackReaction` (optional) makes the bot react to every message it receives, so you know it's processing.

## 5. Enable the bridge plugin — and the channels gate

*Slack gateway.* The bridge runs as the `discord@claude-plugins-official` plugin (the name is historical; it's platform-agnostic). Install it **into the config dir the daemon will use** (see step 6 — `CLAUDE_CONFIG_DIR`):

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

*Slack gateway.* Run `claude` once in a terminal first. Accept the onboarding screens and log in, or a detached bot hangs on them.

```bash
bun install
bun cli/hydra.ts install slack --cwd ~/work   # launchd watchdog, `hydra` CLI, preflight
hydra migrate slack --operator UXXXXXXXX       # writes hydra.toml with you as operator
hydra up slack                                  # daemon + bot
```

Fix every ✗ that preflight reports before `hydra up`. `hydra preflight slack` re-runs the checks. See [ONBOARDING_TIPS.md](ONBOARDING_TIPS.md) for the gotcha behind each step.

Healthy = daemon log shows `slack gateway: connected as <bot>` **and** `bridge registered for session main`. With an app declared in hydra.toml, also expect `daemon: slack connector: catch-up (boot, deep): done` once for each app; an app that did not connect logs `slack connector for <name> (<id>) off (…)` and says which key to fix. Then DM the bot.

## More

How apps are declared, how a message is routed to one, what each app hears, replies, health and alerts, and known limits: [slack-connector.md](slack-connector.md).

## Adding an app

*Slack connector.*

1. **Declare it:** [`[slack.apps.<id>]`](slack-connector.md#apps-in-hydratoml) in hydra.toml with `bot_token_env` and `socket_token_env` (and `operator_token_env` if it should read threads as the operator).
2. **Create it:** `hydra slack manifest <id>` prints its manifest. Create the app from it at api.slack.com/apps, install it, and put its tokens in the variables the keys name, in `.env`.
3. **Restart the daemon:** it reads the tokens from its environment when it starts. The app connects when hydra.toml loads, with no restart, if its token variables are already in the daemon's environment.
4. **Invite the bot** to the channels it should hear. For a channel more than one app is in, `default_app` says which answers an untagged message; `pinned_to` on a specialist pins it to an app.
5. **Add the membership events to every existing app.** A second app changes the first: add `member_joined_channel` and `member_left_channel` under Event Subscriptions of each app that already exists (`hydra slack manifest <app>` lists them) and reinstall each, so a join or a leave is noticed at once. Until you do, hydra alerts once, naming the app, when an invite goes unreported, and a join is noticed only when a tag asks or within ten minutes.
6. **Check:** `hydra route --person <person:id> --place <place> --app <app:id>`, then `hydra health` (the new app's line, with its scope status; see the [runbook](slack-connector.md#health-and-alerts-per-app) if it is not `up`).

## Specialists

What a restricted or write-confined specialist can and cannot do, and how to declare one: [specialists.md](specialists.md).

## Troubleshooting

*Slack gateway.*

| Symptom | Cause / fix |
|---|---|
| Bot never responds, no error | `channelsEnabled` gate ([step 5](#5-enable-the-bridge-plugin--and-the-channels-gate)) — check managed settings first. |
| Bot replies as *your username* ("Sent using Runlayer…") | A native Slack connector is intercepting — disable it ([step 5](#5-enable-the-bridge-plugin--and-the-channels-gate)). |
| Spawned session greets but ignores your thread replies | The daemon's `CLAUDE_CONFIG_DIR` lacks the bridge plugin, so the spawn never registered. Set `CLAUDE_CONFIG_DIR` in the `.env` to a dir that has it, then `hydra restart slack`. |
| "socket not found" | Daemon isn't up — run `hydra up slack`. |
| Daemon exits immediately | `SPAWN_CWD` is required. |

## Message formatting

*Slack gateway and Slack connector.* Plain replies (the gateway's, and a specialist's reply or edit through the connector) are sent via Slack's `markdown_text` field, so the bot can use the **full GitHub-flavored Markdown palette** and it renders natively:

- **bold** (`**x**`), _italic_ (`_x_`), ~strike~ (`~~x~~`), `inline code`
- fenced ```code blocks```, `> blockquotes`, `---` dividers
- bullet lists (`- ` / `* `, nested), numbered lists (`1.`), and **tables** (`| a | b |`)
- headings (`#`), links (`[label](url)`), and emoji (`:tada:` / unicode)

Constraints: `markdown_text` caps at ~12k chars (longer messages fall back to classic mrkdwn), and **button/permission prompts** use Block Kit (classic mrkdwn, fewer features). A connector reply or edit that tags someone or links a channel (`<@U…>`, `<!here>`, `<!channel>`, `<!everyone>`, `<!subteam^…>`, `<#C…>`) goes as classic mrkdwn: it is kept classic until a tagged `markdown_text` post is shown to fire `app_mention` (#895). On that path the connector converts the markdown (`**bold**`, `*italic*`, `~~strike~~`, `[label](url)`, `#` headings) to mrkdwn, leaving code as written; a table has no mrkdwn form and shows as pipes. An edit is decided on its new text alone. Links of either form (`[label](url)` or `<url|label>`) render under `markdown_text`. Under `markdown_text`, `*x*` is italic; bold is `**x**`. This layer only guarantees the palette renders — it imposes **no house style**. How a given bot *presents* (terse vs detailed, emoji, when to use a table vs bullets) belongs in that bot's own instructions / `CLAUDE.md`.

## Spawned sessions

*Slack gateway.* DM `spawn: <anything, multi-paragraph ok>` to fork an isolated Claude session in a thread. The confirmation includes `tmux attach -t <name>` so you can view/drive it from any terminal. Replies in that thread route back to the spawned session; the rest of your DMs go to the main session.
