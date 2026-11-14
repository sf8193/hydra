# Slack Setup

Hydra bridges a Slack app to a Claude Code session: you DM the bot (or @mention it in a channel) and Claude replies, with the ability to spawn isolated sub-sessions in threads.

**Flow:** `Slack ⇄ SlackGateway ⇄ daemon ⇄ bridge (MCP plugin) ⇄ Claude Code`. The daemon holds one Socket Mode connection per Slack app declared in hydra.toml and routes messages; the bridge is an MCP server loaded into Claude that relays messages and tool calls over a unix socket.

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

**How the two tokens meet hydra.toml.** `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are plain variables in `.env`. To route Slack by specialists and rules (and to run several apps), declare the app in `<state dir>/hydra.toml` and name the two variables; hydra.toml never holds a token, only the names of the variables that do:

```toml
[slack.apps.default]
bot_token_env = "SLACK_BOT_TOKEN"
app_token_env = "SLACK_APP_TOKEN"
```

`[connectors.slack]` with the same two keys is the same app (`default`). Keep one connection per token pair: do not point two apps, or a second daemon, at the same one.

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

Healthy = daemon log shows `slack gateway: connected as <bot>` **and** `bridge registered for session main`. With an app declared in hydra.toml, also expect `daemon: slack catch-up (boot, deep): done` once for each app; an app that did not connect logs `slack listener for the app named <id> off (…)` and says which key to fix. Then DM the bot.

## Apps in hydra.toml

Three words mean one thing each from here on. An app **serves** a specialist when it is pinned to it, or when it is unpinned and no specialist is pinned to that app; a message **heard** by an app arrived through its connection. A message is **owed** from the moment it is accepted until a delivery lands. An **episode** is one run of one trouble (an app down, a scope missing): it is said once when it starts, and not again until it has ended and starts anew; drops and gaps count an hour from the first.

The sections from here to *Known limits* tell one story, in the order an app lives it: you **declare** it, print its **manifest**, put its **tokens** in `.env`, and it **connects**; **routing** and **pins** decide what it hears; one app **owns** each message; **conversations** and **replies** follow the app that heard them; **health and alerts** are kept for each app on its own; the **runbook** and **adding an app** are how you act on it.

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
- Every app declared connects, whatever it is named, when hydra.toml loads, with no restart, if its token variables are already in the daemon's environment (a variable that is new needs one). An app whose tokens are not set is skipped: the daemon says which key to fix, in the thread of each specialist that app serves and that hears Slack (main's channel when none does), and logs `slack listener for the app named <id> off (…)`; the others connect.

`hydra slack manifest [<app>]` prints one app's manifest. Leave the name out when hydra.toml declares one app; with several, a missing or unknown name lists the ones declared.

## Apps and routing

**One connection per app.** Hydra opens a Socket Mode connection for each app, each with its own bot, its own tokens, and its own reconnects and catch-up pass. An app added to hydra.toml connects as soon as hydra.toml loads (no restart); one taken out disconnects. Every message records the app that heard it, and everything that follows goes through that app: its reply, its reactions, the files it downloads, the threads it rereads. A message goes in through one app and leaves through the same one.

An app is a way in: a message reaches hydra through the app whose connection delivered it. Routing knows which, and three things use it. `hydra route --as <person> --at <place> --app <app>` shows each.

**Rules match an app, a place, or both.** A `[[rules]]` entry names `at` (a place), `app` (an app id), or both; an absent one matches every place or every app, so a rule in a hydra.toml with no `apps` or `app` keys behaves as it did. `from` only narrows who: a rule with `from` and neither `at` nor `app` is an error. The first rule in file order that matches wins.

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

1. The app the message tags. With two tags, the first in the text. A tag outranks everything below, the app the conversation is bound through included (a tag outranks the bound app): it opens that app's own conversation, even in a thread another app opened. A tagged app whose connection is down counts as having heard its tag, if its bot is in the channel: no other app answers in its place, and it catches the message up when it is back.
2. The app the conversation is bound through, if it is already a bound conversation: an untagged follow-up stays with that app. When the thread is bound through two apps, the one most recently active in it.
3. The channel's `default_app`: `default_app = "sales"` under `[places."slack:#help"]` (the place's id or its name; it must be a declared app, on a Slack channel). It is honored as written, even if that app delivers to no one there.
4. The app named `default`, if it delivers to someone at this place.
5. The first app, in hydra.toml order, that delivers to someone at this place.

An app "delivers to someone at this place" when a specialist it serves listens there, or a rule that matches there sends to one (or to `main`), or it is a DM. If no app that heard the message does, 4 and 5 pick among all that heard it. So a channel whose only listener is pinned to `sales` is answered by `sales` with no `default_app` set; set one only to choose between apps that all deliver.

The other apps do nothing: `hydra route` shows them as `ignored`, with the app that owns it. Ownership is decided before any specialist, and never hands a message on: if the owner reaches no one (an explicit `default_app` that delivers to nobody there), the message is unrouted.

```toml
[places."slack:#help"]
default_app = "support"          # an untagged message in #help is answered by support; tag @sales and sales answers
```

**Several apps in one channel need a read of who is in it.** Each connection receives every message of a channel its bot is in, so with several apps connected each connection asks whether the other apps' bots are members (`conversations.info`, through that app's own token; an app never asks about itself, and at most 5 asks are in flight). A member is believed for ten minutes, a non-member for 30 seconds (an invite is the common change), and an answer that fails is never taken as a verdict: the last good answer stands and Slack is asked again in 30 seconds. A message that tags an app reads that app again first, so an invite followed at once by a tag is answered by the tagged app. The first connection to decide a message fixes its owner for every other connection's copy of it (and for a catch-up pass), so exactly one app answers even if who is in the channel changes between two copies. A DM belongs to the app it was sent to. With one app connected nothing is asked.

A join or a leave is seen at once when the apps send `member_joined_channel` and `member_left_channel`. `hydra slack manifest <app>` includes both when hydra.toml declares more than one app. **Adding a second app means adding both events under Event Subscriptions of every app that already exists, and reinstalling each** (step 5 of [Adding an app](#adding-an-app)): an app created while only one was declared does not have them. Hydra says so, once, naming the app, when an invite went unreported; until then a join is noticed only when a tag asks, or within ten minutes. The scopes are ones the manifest already grants for channel names: `channels:read` for public channels, and `groups:read` for private ones (asked of the startup check when hydra.toml names a `slack:G…` place). If the read is refused, the operator is told once, naming the app and the scope; until it is fixed the app that receives a message answers it, so a channel two apps are in may be answered by both.

Each app's bot ids are kept in `<state>/slack-apps.json`, so after a restart a tag of an app that has not connected yet is still recognised. While an app that was started has not yet joined (up to 30 seconds), a message in a channel hydra.toml names is not answered: its cursor is held and a catch-up pass reads it once the app has joined or failed to.

A message from another app's bot is another bot's message: it is passed over unless the place has `bots = true`. A bot that is one of hydra's own apps is never heard, `bots = true` or not, so two apps cannot answer each other.

`hydra route` takes `--app <app>`: the app this check runs for, the one that heard the message (default: the app named `default`). `--heard-by <app,app>` adds the other apps in the channel. `--mentioned <app,app>` lists the apps the text tags, first tag first. `--bound-app <app>` (with `--bound`) is the app the bound conversation is bound through (if two, the one most recently active).

## Conversations and replies, per app

**A conversation is an app, a channel and a thread.** The same thread heard through two apps (each tagged in turn) is two conversations, each bound on its own, answered through its own app. Its id, as `hydra conversations`, `reply`, `bind_conversation` and the guard's stdin (`conversation`) write it:

| App | Conversation id | Example |
|---|---|---|
| `default` | `slack:<channel id>[:<thread ts>]` | `slack:C0ABC:1793732224.093059` |
| any other, `sales` here | `slack:<app>:<channel id>[:<thread ts>]` | `slack:sales:C0ABC:1793732224.093059` |

A DM, or a top-level message where `listen = "all"`, has no thread ts: `slack:D0ABC`, `slack:C0ABC`. Copy the id from the delivery you are answering.

The id of `default` is exactly what it was in a hydra.toml with no `apps` or `app` keys, so its sessions, transcripts, stored conversations and idempotency keys carry on; a conversation id written without an app is `default`'s, and `slack:default:C0ABC:…` names the same conversation. Another app's per-conversation session is named with the app in it (`deals_sales-c0abc-1793732224-093059`), and its attachments are kept under `<state>/slack-files/sales/<channel>/`. Stored conversations and catch-up cursors carry the app when it is not `default`; a conversation store written without apps loads as `default`'s and is not rewritten.

**Replies leave through the app that heard the message.** `reply` into a conversation posts with that conversation's app, never another. A post that answers no message (a specialist's `home`, a new thread) has no app to follow, so it uses the specialist's `speaks_as`:

```toml
[specialists.deals]
apps = ["sales"]
speaks_as = "sales"            # the app it posts as when it answers no message; one of `apps` if it is pinned
home = "slack:#sales-ops"
```

`speaks_as` must name a declared app, and one of `apps` for a pinned specialist; an unpinned specialist cannot speak as an app another specialist is pinned to. Absent: its first pinned app; if it is unpinned, `default`, else the only app declared. With several apps, none of them `default`, `speaks_as` is required of a specialist with a Slack `home`: hydra.toml refuses to load without it. A `#name` home is resolved through that app's workspace. The thread such a post opens is a conversation of that app, bound to the specialist.

`bind_conversation` and `hydra conversations bind` carry the app too, and refuse what routing would: a specialist can be bound only through an app it is pinned to (any app if it is unpinned).

## Health and alerts, per app

**Health is kept for each app on its own.** Each app has its own connection, its own catch-up pass, and its own record of what it has told you, so one app's trouble neither raises, hides, nor repeats another's. `hydra health` prints one line per app, with the app's id (a lone `default` prints the single `slack:` line it always did):

```
slack: 2 apps · 14 conversations · 0 owed
  default: up · last event 1 min ago · catch-up ok 3 min ago · scopes ok
  sales: down 12 min · last event 14 min ago · catch-up failing (…) 40 min ago · missing chat:write (replies)
```

In `hydra health --json`, `slack.apps.<id>` holds each declared app's:

- `state`: `off` (no listener: its tokens are missing, or it failed to start), `connecting`, `up`, `down`, or `exhausted` (reconnect attempts keep failing; hydra keeps trying);
- `downMin`, `lastActivityAgeMin`, and the last catch-up (`ok`, `accepted`, `reason`) with `lastOkCatchUpAgeMin`;
- `missingScopes`: what the bot token lacks of what hydra.toml has the app do (empty when complete; `null` until Slack has said what the token holds, which the line prints as `scopes unchecked`);
- `tokens`: `{ ok: true }`, or `{ ok: false, why }` naming the key to fix;
- `connection`: `pending` (starting), `up`, `down` (lost, or never possible without tokens), or `gaveUp` (the first connection failed and was let go, or reconnecting is exhausted);
- with several apps, `probeError`: why its last read of whether it is in a channel failed.

An app removed from hydra.toml while its connection is still shutting down shows `declared: false` in the daemon's record and is gone from the next pass. `slack.listener` is the same fact as `slack.apps.default` (else the first connected app), kept for what already reads it.

**Scope check, per app.** At connect each app's bot token is checked against the scopes *that app* needs, from what hydra.toml has it do:

- channel history, when it reads a named channel, serves a rule that has no place (it reaches every place), or serves a specialist with no `listens` (that one answers only threads bound to it);
- the channel-name read, only for a `#name` among its places; files, only when a place it reaches has `files`;
- DMs (`im:*`), when a specialist or rule it serves names `slack:dm`, or the operator has a Slack address (their DM reaches `main` through any app);
- the membership reads (`channels:read`, and `groups:read` only when one of its places is a `slack:G…` channel), only with several apps and only for an app that reads channels.

A missing scope is always logged and shown in `hydra health` (`missing <scope> (<option>)`), and alerted once per episode for what hydra.toml declared, naming the app (a lone `default` says no app), the scope, and the fix: `hydra slack manifest <app>` prints the full list, then reinstall the app, put the new bot token in the variable its `bot_token_env` names, and restart the daemon. An episode lasts until the token is complete again, so a restart does not say it twice (what was said is kept in `<state>/slack-scopes-told.json`). The one exception: `im:*` asked only because the operator has a Slack address, with no specialist or rule naming `slack:dm`, is logged and shown in health but never alerted, since nothing declared a DM.

**Alerts, per app.** Each of these has its own episode for each app, so app A's outage neither suppresses nor duplicates app B's:

- the listener is down for 5 minutes awake, and back up;
- the catch-up pass has not completed for 25 minutes awake, or Slack refuses it for a reason retrying cannot fix (`missing_scope`, `invalid_auth`, `not_in_channel`, which names the channel);
- the periodic pass finds messages the live stream never delivered (at most hourly);
- a thread is let go because no token can read it any more, or the operator's token is refused (each at most hourly);
- a message is dropped, or catch-up skipped part of a busy channel (once an hour per kind, specialist and app);
- channel names can't be read and a `#name` the app needs goes unresolved;
- a token variable is empty (the app is skipped), or a declared scope is missing.

**Who hears an alert.** An alert about one app goes to the specialists that app serves and that hear Slack (they listen on a Slack place, or a Slack rule for the app sends to them), and to `main`'s channel when none does or none has a thread yet. A pinned specialist is paged only by its own apps; an app no specialist uses pages no one but `main`; an app hydra.toml no longer declares pages `main` only. An alert about one specialist (a drop, a thread let go, a guard redirect) goes to that specialist. One about no app in particular (the old `slack-watch.json` left unmigrated: run `hydra migrate`) goes to every specialist that hears Slack. A lone `default` serves every specialist, so it reaches the same ones it always did.

**Catch-up, per app.** Each app has its own cursors, last-complete time, gap time, retry timer and in-progress pass. A slow pass of one app does not delay another's; a pass that fails retries after 60 seconds for that app alone and alerts once for it, and does not mark another app's pass failed. A freed place wakes only the apps that have conversations waiting for it.

### Runbook: reading `hydra health`

Start with `hydra health`; `hydra health --json` has every field above.

| You see | It means, and what to do |
|---|---|
| `<app>: off · bot_token_env … names X, which has no value` | The variable is not in the daemon's environment. Put the token in `.env` and restart the daemon: new variables are read only at start. |
| `<app>: off` and no key named | Its tokens are there but the listener failed to start (see `slack listener … failed to start` in the daemon log). Fix what the log says and save hydra.toml: the next load tries again. |
| `<app>: down`, or `exhausted` | Its connection is lost. Check both tokens and the app's Socket Mode setting at api.slack.com/apps. A first connection that fails is retried (10 s doubling to 5 min) until it connects, then a catch-up pass runs. Other apps are unaffected. |
| `missing <scope> (<option>)` | Add the scope to that app (`hydra slack manifest <app>` lists them), reinstall it, update its bot token, restart the daemon. |
| `scopes unchecked` | The app has connected but Slack did not say what its token holds, or it has not connected yet. Check again after the next reconnect. |
| `catch-up failing (…)` | Read the reason. A budget or a rate limit: the next pass resumes from the held cursor. A permanent error: the alert says what to do. |
| `up`, and `catchUp.accepted > 0` in `hydra health --json` pass after pass | A second connection holds this app (Slack splits events). Stop the other process. |
| `membership unreadable` | The app lacks `channels:read` (public) or `groups:read` (private): where several apps share a channel, each may answer. Add the scope and reinstall. |
| A join was not noticed | An app lacks `member_joined_channel` and `member_left_channel`: add them to its Event Subscriptions and reinstall (the *Add the membership events* step of [Adding an app](#adding-an-app)). |
| Slack is not connected, and a `slack-watch.json` is in the state dir | hydra.toml declares no app and the old file is no longer read: run `hydra migrate`. |

## Adding an app

1. **Declare it:** `[slack.apps.<id>]` in hydra.toml with `bot_token_env` and `app_token_env` (and `user_token_env` if it should read threads as the operator).
2. **Create it:** `hydra slack manifest <id>` prints its manifest. Create the app from it at api.slack.com/apps, install it, and put its tokens in the variables the keys name, in `.env`.
3. **Restart the daemon:** it reads the tokens from its environment when it starts. The app connects when hydra.toml loads, with no restart, if its token variables are already in the daemon's environment.
4. **Invite the bot** to the channels it should hear. For a channel more than one app is in, `default_app` says which answers an untagged message; `apps` on a specialist pins it to an app.
5. **Add the membership events to every existing app.** A second app changes the first: add `member_joined_channel` and `member_left_channel` under Event Subscriptions of each app that already exists (`hydra slack manifest <app>` lists them) and reinstall each, so a join or a leave is noticed at once. Until you do, hydra alerts once, naming the app, when an invite goes unreported, and a join is noticed only when a tag asks or within ten minutes.
6. **Check:** `hydra route --as <person> --at <place> --app <id>`, then `hydra health` (the new app's line, with its scope status; see the [runbook](#runbook-reading-hydra-health) if it is not `up`).

## A specialist other people talk to: `access = "workdir"`

**A session may know what its audience can already see.** A specialist whose replies only the operator sees can run under the operator's account (`access = "operator"`, the default, and what every specialist did before). One that other people talk to should not: whoever can message it can use whatever it can use. `access = "workdir"` confines it to its own folder, the tools and servers it lists, and its own conversation. Routing does not change: places, rules, apps, pins, `listen` and `sessions` work as they did. hydra.toml warns, naming who, when someone besides the operator can talk to an `access = "operator"` specialist.

### A worked example: an ops specialist in `#ops`

One channel, one specialist. Staff post in `#ops`; it answers from its runbooks and one monitoring server, and asks the operator when it cannot. A test loads it through the real loader (with the folder and binary checks stubbed), so it stays current.

```toml
operator = "op"

[slack.apps.default]
bot_token_env = "SLACK_BOT_TOKEN"
app_token_env = "SLACK_APP_TOKEN"

[people.op]
ids = ["slack:U0OP"]
name = "Op"

[people.alice]
ids = ["slack:U0ALICE"]
roles = ["staff"]

# A server specialists may list. Per-operator, so only hydra.toml declares one (never a `hydra config add` fragment).
# Listing a server means running code you trust with your own privileges; `tools` limits which of its tools the specialist may call. Most specialists list none (see [Listed servers](#listed-servers-code-you-trust-run-with-best-effort-hygiene)).
[mcp.datadog]
command = "/usr/local/bin/datadog-mcp"    # a pinned binary or a versioned package, not `npx -y` latest
token_env = ["DD_API_KEY"]                # names in the state dir's .env; only these reach the server
tools = ["search_logs", "get_monitor"]    # the tools of it a specialist may call (default: none, which is refused)

[specialists.ops]
workdir = "~/specialists/ops"             # runbooks and FAQs: all it may know. A folder of its own, not a git work tree, no symlinks out
listens = ["slack:#ops"]
allow = ["staff"]                         # `anyone` is allowed too; see link_previews below
access = "workdir"
tools = ["Read", "Grep", "Glob"]          # the default, and all a workdir specialist may list
mcp = ["datadog"]                         # names from [mcp.*]
home = "slack:#ops-escalations"           # where `escalate` posts; a place only the operator reads

[places."slack:#ops"]
listen = "all"                            # hears every top-level post, not only tags; it answers in a thread on the post
link_previews = false                     # no link previews on anything hydra posts here
```

**Before you paste.** The checks below run on your machine, so have these ready:
- the folder `~/specialists/ops` exists and is a folder of its own (a git work tree, your home folder and a folder with symlinks out are refused);
- the binary at `[mcp.datadog] command` exists and is executable;
- the daemon runs on macOS: a specialist that lists servers is refused where `/usr/bin/sandbox-exec` is missing (remove the servers from its `mcp`, set `access = "operator"`, or run hydra on a Mac). `hydra config check` refuses it on any machine without `sandbox-exec`, so run the check on the machine the daemon runs on;
- `DD_API_KEY=<value>` is in the state dir's `.env`. hydra.toml reloads within a second, but the daemon reads `.env` only when it starts: restart it after adding the variable, or the specialist's first start refuses, naming the variable.

`hydra config check` runs the loader's checks without the daemon, and reports what is missing.

### What a confined session has

| | |
|---|---|
| **Knows** | its `workdir` and nothing else: no `CLAUDE.md`, memory, project settings or `.mcp.json` from anywhere, and not the operator's plugins or claude.ai connectors |
| **Built-in tools** | `tools`: `Read`, `Grep`, `Glob`, nothing that runs code. `Read` and the other two reach only the workdir |
| **MCP servers** | the ones in `mcp`, each limited to the `tools` the `[mcp.*]` table lists, with only its `token_env` variables; code you trust, run under a best-effort sandbox (below) |
| **Hydra tools** | `reply` (text only), `react`, `edit_message`, `delete_message`, `fetch_messages`, `download_attachment` and `set_description`, each only in its own thread or a Slack conversation bound to it; and `escalate` |
| **Never** | `spawn_session`, `kill_session`, `peek_session`, `list_sessions`, `send_to_thread`, `handoff`, `bind_conversation`, `watch_pr`, `ask_predecessor`, and nothing posted outside its conversation but through `escalate` |

hydra.toml refuses, with the key and the fix: a `tools` entry beyond the three; a workdir that is your home folder, a private root (`[defaults] private_roots = ["~/notes"]` adds yours), the state dir or Claude's config dir, a git work tree or one that holds a nested repository, a folder with a `.mcp.json` in or above it, a symlink out of it, or one too big to scan; an `mcp` name with no `[mcp.<name>]` or a server with no `tools`; an engine other than `claude`. `access`, `tools` and `mcp` are refused in `[defaults.specialist]` and in `hydra config add` fragments: only a hand edit of hydra.toml confines or unconfines a specialist.

### Listed servers: code you trust, run with best-effort hygiene

**Listing a server means running code you trust with your own privileges.** A listed `[mcp.*]` server is a process of your user: pin it, read it, and trust its authors as you would a program you run yourself. The server's `tools` list limits which of its tools the specialist may call, and it is the primary control. The recommended shape for a specialist other people talk to has no `mcp` at all: `Read`, `Grep`, `Glob`, its folder and its own conversation.

For the servers you do list, hydra adds a sandbox on macOS. It is best-effort hygiene, proven by probes on one macOS version, **not containment**: do not rely on it against a hostile server. Each listed server runs under `sandbox-exec` with one profile, the same for every operator, which the server's own children inherit. The profile starts from "allow everything" and takes away:

- every unix-socket connect except name lookup (not the daemon's socket, tmux, or another session);
- every file write except to the server's own temp folder, `/dev/null` and `/dev/dtracehelper`: no shell rc files, LaunchAgents or `~/.claude.json`. npm's cache and `TMPDIR` are put in that folder, never in `~/.npm`. The folder is made new at each start (also at a resume or respawn) and removed when the session ends, so **a server that must keep data across sessions cannot run under the sandbox**: use an `access = "operator"` specialist for it. The contents of the other servers' folders are unreadable (their names and sizes can still be listed by `stat`);
- reads and writes of the places a confined specialist's workdir may not be, one list used by both (the source is `offLimitRoots` in `config/workdir-scope.ts`; it is a floor, not a complete inventory): credential files and folders such as `~/.ssh`, `~/.aws`, `~/.kube`, `~/.config`, `~/.gnupg`, `~/Library/Keychains`, `~/.netrc`, `~/.npmrc`, `~/.docker`, `~/.git-credentials`, `~/.pgpass`; shell history; browser data under `~/Library`; Claude's config (`~/.claude`, `~/.claude.json`); the state dir (hydra.toml and `.env` live there); and your `[defaults] private_roots`;
- another process's environment (the daemon's tokens, Claude's, tmux's) and its full command line, and signalling any process but itself and its children;
- typing into the session's terminal (the `TIOCSTI` ioctl on terminal devices);
- the system services behind `open` (LaunchServices and CoreServices: a helper started outside the sandbox), the preferences service (`defaults write` into `~/Library/Preferences`) and the pasteboard. Denying the first also breaks Apple Events to Terminal and to claude.ai; Apple Events to Finder and System Events were shown refused too.

When hydra.toml loads, the daemon logs one line per specialist that lists servers, with the sentence above. The profile is built when a session starts: a session already running keeps the servers it started with (before this change, unsandboxed), and a changed `private_roots` or off-limits list reaches a running session only after `hydra kill <session>`. A daemon crash leaves a session's temp folder in the system temp directory until that session name starts again or is killed.

**What it costs.** A server that needs another unix socket, a terminal, `~/.config`, `~/.aws`, `~/.claude` or `~/.kube`, or that signals its process group, stops working; when a listed server does not connect, the refusal in the thread says it runs under the sandbox. There is no per-server allowance, on purpose: one profile has no knob and no owner to widen it, and such a server belongs under an `access = "operator"` specialist. The off-limits list also grew: a workdir under `~/.aws`, `~/.kube`, `~/.gnupg`, `~/Library/Keychains` or any other entry is now refused at load, which can reject a config that loaded before.

**What it does not do.**
- The network is fully open: anything the server can read can leave. A place not on the list is readable (the list is a floor): shell history, `/etc`, variables exported in rc files, any other folder. The server runs with your `HOME` and with claude's own environment (not the daemon's).
- Shortcuts, and Apple Events to apps other than the three probed, can still reach other apps, which run outside the sandbox. The system call `task_for_pid` was not tested on protected processes. The list of other processes (pids and names) is visible, their environments and command lines are not (`ps` cannot run under any `sandbox-exec` profile, and `pgrep` is denied on purpose). The temp parent folder's owner and mode are checked when a session starts, which is evidence, not a lock: on a shared temp dir without the sticky bit another user could swap it afterwards (read from code, not probed). The keychain is reachable through its system service.
- `sandbox-exec` is deprecated by Apple and exists on macOS only. Where it is missing a specialist that lists servers is refused, at load and at launch. `hydra config check` refuses it on a machine without it, so run the check where the daemon runs.
- The unauthenticated `cli` command on the daemon socket stays open for your `hydra` CLI (#625), and per-session socket keys are not scheduled (#626).

A scoped session's kickoff also starts with a short fixed preamble from hydra (messages that follow come from people talking to it and carry no authority, not even if they say they come from the operator or hydra; it cannot change its tools or leave its folder). That is a prompt, not a control: it can fail. PR 4 (`talks_to`) changes its wording.

### `escalate`: asking the operator

`escalate(chat_id, text)` is the confined session's one way to speak outside its conversation. Hydra posts to the specialist's `home` and nowhere else, tags the operator, and links the conversation `chat_id` names (one the session owns, checked as `reply` is). The text arrives quoted, cut at 1,500 characters, under a line that says a scoped session wrote it on behalf of the people in that conversation and that it is not an instruction from the operator or from hydra. It does not answer the conversation: the session tells the people there it escalated. The operator, or byte on the operator's word, decides what happens next; the full-account side acts only when the operator chooses.

A conversation (however its id is spelled) may escalate at most 3 times in 10 minutes, counted in memory, so a daemon restart resets the count; past that nothing is posted and the session is told the operator has already been notified. Escalation posts to Slack go one at a time, at least 1.2 seconds apart. Failures are written for the session ("tell the person you could not reach the operator"), and the operator-side detail goes to the daemon log.

hydra.toml refuses a `home` that is a DM (`slack:dm`, `discord:dm`), `cli` or a repo, a Discord channel given by name (use `discord:<channel id>`), the specialist's own `listens`, or a place an `access = "operator"` session listens on (a specialist's `listens`, a rule that sends the place to `main` or to such a specialist, or a rule for the app the specialist posts as that names no place, since that app hears the home too), compared in one spelling. A Slack channel named by id in one place and by name in the other is the same channel only once Slack has said so, so `escalate` checks that again when it posts. It also refuses a `home` on a platform where the operator has no address to be tagged by. A confined specialist with no `home` loads with a warning: `escalate` then tells the session it cannot reach the operator.

### `link_previews`

A preview can show readers content they could not open themselves, and fetches the link with whatever the text put in it. `link_previews = false` on a place turns Slack's `unfurl_links` and `unfurl_media` off, and sets Discord's suppress-embeds flag, on the messages hydra posts to that place through each gateway's one sending point: replies, a new thread's first message and its anchor, DMs, buttons, escalations and alerts. Covered the same way: Discord edits and Discord button-click updates and replies. **Not covered:** Slack edits (`chat.update` has no unfurl argument), and a Discord channel given by name (hydra reads Discord channels by id, so `link_previews = false` on `discord:#name` is refused; use `discord:<channel id>`). Discord ignores a caller's own `unfurl: false`, as before. The default is on, so a place that does not set it behaves as it did. hydra.toml warns when a confined specialist that `anyone` can talk to answers in a place with previews on.

### Every new start is checked, and a changed file is not applied silently

A session keeps the policy it was born under. Each new start (fresh, resume, respawn, handoff) reads the launch's own debug file, which is Claude Code's record of what it loaded, and compares it with that policy: the MCP servers it started (the bridge and the listed ones, each connected), the plugins (the hydra mod, the bridge and the ones Claude Code registers as its own), the permission rules it applied, and that claude.ai connectors were off. Servers are matched by name; the file does not show their command.

**What is guaranteed.** The launch prompt itself reaches the session, because it is on the command line. Everything after it goes through the one delivery gate, which refuses a confined session until its start has passed: a record carries a persisted `verified` marker that is set only on a pass. A message by session, by name, by `send_to_thread` or as a second conversation's message is refused until then, and so is a confined session restored at boot without the marker (hydra restarted mid-check, or it started before hydra checked starts). That session is not killed: the thread is told to run `hydra kill <session>`, and the next message starts one that is checked.

A difference, or a file that cannot be read or does not finish loading in 45 seconds, stops the session this start created (only that one) before its thread is handed to it, and tells the thread. The same specialist is not started again for a minute, so each message does not launch and check another:

> specialist ops: the session that just started (ops) loaded something its policy does not give it, so hydra stopped it before routing the thread to it (its launch prompt had already reached it): it started MCP servers the policy does not list: `claude.ai Slack`. Send another message to start a fresh one. If this repeats, the cause is in Claude Code's setup or its debug file, not in hydra.toml.

The built-in tool list is not in that file; it is checked by the live test (`HYDRA_LIVE_CLAUDE=1 bun run test --isolate daemon/__tests__/scoped-claude.live.test.ts`), which runs a real launch and reads Claude Code's init event.

If hydra.toml later gives a running specialist another `access`, `workdir`, `tools` or `mcp`, a message to its session is not delivered: the thread is told to run `hydra kill <session>`, and the next message starts a new session under the new file.

## Known limits

- A confined session that was already running when it was last checked is not checked again while it runs (#617); only a new start is. The check also reads Claude Code 2.1.32x's wording of its debug file: a version that words those lines differently refuses starts until the check is updated.
- Slack edits are not covered by `link_previews` (`chat.update` takes no unfurl argument).
- Where two apps are in one channel and who is in it is not yet known (a membership read has not answered, or an app has not joined), each app may answer what it receives, so a channel two apps are in may be answered by both until the read lands.
- While an app that was started has not yet joined (up to 30 seconds), a message in a channel hydra.toml names is not answered; its cursor is held and a catch-up pass reads it once the app has joined or failed to.
- A place's `default_app` that names an app whose connection is down means the other app answers: `default_app` is honored only among the apps that heard the message, and a down app heard nothing.
- A tag of a declared app that is down and not in the channel is answered by no one until it is back: the tag outranks the other apps (they stand down), and the tagged app can only catch the message up in a channel it is in.
- An app created while only one app was declared lacks the membership events (step 5 of [Adding an app](#adding-an-app)) until they are added.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Bot never responds, no error | `channelsEnabled` gate ([step 5](#5-enable-the-bridge-plugin--and-the-channels-gate)) — check managed settings first. |
| Bot replies as *your username* ("Sent using Runlayer…") | A native Slack connector is intercepting — disable it ([step 5](#5-enable-the-bridge-plugin--and-the-channels-gate)). |
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
