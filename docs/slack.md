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

- **App-level token** (Socket Mode): Basic Information → App-Level Tokens → **Generate** → name it `socket-mode`, scope `connections:write`. Copy the `xapp-…` token.
- **Bot token**: OAuth & Permissions → **Bot User OAuth Token** (appears after install, step 3). Copy the `xoxb-…` token.

## 3. Install to workspace

Install App → **Install to Workspace** → Authorize. (Org-restricted workspaces may need admin approval of the scopes.)

## 4. Config files

Both live in the daemon's **state dir** — default `~/.claude/channels/slack/` (override with `HYDRA_STATE_DIR`).

`.env` (see [`.env.example`](../.env.example)):

```bash
CHAT_PLATFORM=slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SPAWN_CWD=~/work      # must be an existing directory
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

Run `claude` once in a terminal first. Accept the onboarding screens and log in, or a detached bot hangs on them.

```bash
bun install
bun cli/hydra.ts install slack --cwd ~/work   # launchd watchdog, `hydra` CLI, preflight
hydra up slack                                  # daemon + bot
```

Fix every ✗ that preflight reports before `hydra up`. `hydra preflight slack` re-runs the checks. See [ONBOARDING_TIPS.md](ONBOARDING_TIPS.md) for the gotcha behind each step.

Healthy = daemon log shows `slack gateway: connected as <bot>` **and** `bridge registered for session main`. Then DM the bot.

## Apps in hydra.toml

hydra.toml declares each Slack app by name, `[slack.apps.<id>]`. Tokens stay in `.env`; the keys name the variables that hold them.

```toml
[slack.apps.default]
bot_token_env = "SLACK_BOT_TOKEN"      # required: the bot token (xoxb-…)
app_token_env = "SLACK_APP_TOKEN"      # Socket Mode's app-level token (xapp-…): required for Slack to connect, not for `hydra slack manifest`
user_token_env = "SLACK_USER_TOKEN"    # optional: read threads the bot is not in, as the operator; never posts
display_name = "Acme helper"           # the app's name in `hydra slack manifest` (default: `hydra` for `default`, else the id; at most 35 characters)
description = "Answers Acme's threads it is tagged in."   # at most 140 characters

[slack.apps.sales]
bot_token_env = "SALES_SLACK_BOT_TOKEN"
app_token_env = "SALES_SLACK_APP_TOKEN"
```

- An app's id is lowercase letters, digits, `-` and `_`, starting with a letter, at most 35 characters. Uppercase is reserved for Slack's own ids (`C0TEST`).
- `[connectors.slack]` still works: it is the app named `default`, and spells the two text keys `app_name` and `app_description`. Declaring `default` in both tables is an error.
- Each token needs its own variable: one variable on two keys (two apps, one app, or an app and `[connectors.discord]`) is an error.
- Token variable names are uppercase. Hydra keeps every variable hydra.toml names as a token from the sessions it starts, so name only variables the daemon needs. These are refused when hydra.toml loads: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMUX`, `TERM`, `PWD`, `TMPDIR`, `LANG`, `ANTHROPIC_API_KEY`, `GH_TOKEN`, `SSH_AUTH_SOCK`, and anything starting `HYDRA_` (except `HYDRA_SLACK_`), `CLAUDE_`, `LC_` or `XDG_`.
- Slack connects only the app named `default`. With other apps declared but no `default`, hydra.toml loads with a warning and Slack stays off.

`hydra slack manifest [<app>]` prints one app's manifest. Leave the name out when hydra.toml declares one app; with several, a missing or unknown name lists the ones declared.

## Apps and routing

Only the app named `default` connects today, so every live Slack message arrives through `default`; `hydra route --app` checks how other apps would route.

An app is a way in: a message reaches hydra through the app whose connection delivered it. Routing knows which, and three things use it. `hydra route --as <person> --at <place> --app <app>` shows each.

**Rules match an app, a place, or both.** A `[[rules]]` entry names `at` (a place), `app` (an app id), or both; an absent one matches every place or every app, so a rule written before apps existed behaves as it did. `from` only narrows who: a rule with `from` and neither `at` nor `app` is an error. The first rule in file order that matches wins.

```toml
[[rules]]
app = "sales"                    # everything that comes through the sales app
to = "deals"

[[rules]]
at = "slack:#help"
app = "support"                  # #help, through the support app only
from = "staff"
to = "desk"
```

**A specialist can be pinned to apps.** `apps = ["sales"]` in a specialist means two things:

- It answers only messages that come through those apps. A message through another app never reaches it: not through `listens` (including `slack:dm`), a rule's `to`, or a conversation bound to it.
- Those apps deliver only to specialists pinned to them. Once any specialist is pinned to `sales`, a message through `sales` goes to a specialist pinned to `sales`, or to nobody.

A specialist with no `apps` is unpinned: it answers messages through every app that no specialist is pinned to. `allow` is separate: it governs who may reach a specialist, and still applies. `main` is exempt from pinning: the operator's DM reaches `main` through any app, and `main` still hears only the operator. A rule that would send a message to a specialist its app cannot deliver to is skipped, a binding to one is skipped and the message routed anew, and a guard redirect to one goes to the conversation's own specialist with one alert; `hydra route` says why. hydra.toml refuses a rule whose `app` and `to` can never meet, and a pinned specialist that listens on a place that is not a Slack place. Pinning an app takes it from every unpinned specialist, so hydra.toml warns when an unpinned specialist listens where no pinned specialist backs it up.

Two specialists may `listen` on the same place only when no app reaches both: their `apps` are disjoint, or one is pinned and the other is not. Two unpinned specialists, or two whose `apps` overlap, may not.

**One app owns a message.** When two apps are in one channel, both hear every message in it, and exactly one answers. The owner is the first of these that applies, among the apps that heard it:

1. The app the message tags. With two tags, the first in the text. A tag always wins: it opens that app's own conversation.
2. The app that opened the conversation, if it is already a bound conversation: an untagged follow-up stays with that app.
3. The channel's `default_app`: `default_app = "sales"` under `[places."slack:#help"]` (the place's id or its name; it must be a declared app, on a Slack channel). It is honored as written, even if that app delivers to no one there.
4. The app named `default`, if it delivers to someone at this place.
5. The first app, in hydra.toml order, that delivers to someone at this place.

An app "delivers to someone at this place" when a specialist it can deliver to listens there, or a rule that matches there sends to one (or to `main`), or it is a DM. If no app that heard the message does, 4 and 5 pick among all that heard it. So a channel whose only listener is pinned to `sales` is answered by `sales` with no `default_app` set; set one only to choose between apps that all deliver.

The other apps do nothing: `hydra route` shows them as `ignored`, with the app that owns it. Ownership is decided before any specialist, and never hands a message on: if the owner reaches no one (an explicit `default_app` that delivers to nobody there), the message is unrouted.

```toml
[places."slack:#help"]
default_app = "support"          # an untagged message in #help is answered by support; tag @sales and sales answers
```

`hydra route` takes `--app <app>`: the app this check runs for, the one that heard the message (default: the app named `default`). `--heard-by <app,app>` adds the other apps in the channel. `--mentioned <app,app>` lists the apps the text tags, first tag first. `--bound-app <app>` (with `--bound`) is the app that opened the bound conversation.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Bot never responds, no error | `channelsEnabled` gate (step 5) — check managed settings first. |
| Bot replies as *your username* ("Sent using Runlayer…") | A native Slack connector is intercepting — disable it (step 5). |
| Spawned session greets but ignores your thread replies | The daemon's `CLAUDE_CONFIG_DIR` lacks the bridge plugin, so the spawn never registered. Set `CLAUDE_CONFIG_DIR` in the `.env` to a dir that has it, then `hydra restart slack`. |
| "socket not found" | Daemon isn't up — run `hydra up slack`. |
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
