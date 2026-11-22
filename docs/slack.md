# Slack Setup

Hydra bridges a Slack app to a Claude Code session: you DM the bot (or @mention it in a channel) and Claude replies, with the ability to spawn isolated sub-sessions in threads.

**Two Slack systems.** Hydra talks to Slack in two ways. They are alike in using Slack apps over Socket Mode and in ending at Claude sessions. They differ in what they are for:

| | **The Slack gateway** | **The Slack connector** |
|---|---|---|
| What it is | Slack as the operator's own chat surface (`gateways/slack.ts`, `CHAT_PLATFORM=slack`), as Discord is for a Discord daemon | Slack as a source of events, routed by hydra.toml (`connectors/slack/`, in every daemon, Discord's included) |
| What it does | the operator talks to the byte, spawns sessions in threads, runs commands | delivers what its apps hear to specialists, to threads bound to sessions, and to restricted specialists; it runs no commands, and routing never reads what a message says |
| Configured by | `.env` (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`) and `hydra.toml` (`operator`, `[places.…access]`, `[gateways.slack]`) | `[slack.apps.<id>]`, `[[rules]]`, `reachable_by` in hydra.toml |
| Connections | one, on the gateway's app | one per app declared, each with an optional operator token (reads; rewrites the operator's own messages from main) |

Steps 1–6 below set up the gateway. [Apps in hydra.toml](#apps-in-hydratoml) onward is the connector.

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

`hydra.toml` — who may DM the bot (find your Slack user id via Profile → ⋮ → Copy member ID). With the daemon stopped, run `hydra migrate slack --operator UXXXXXXXX`, which writes:

```toml
operator = "operator"

[people.operator]
addresses = ["slack:UXXXXXXXX"]
```

To let the bot into a channel, tag it there as the operator: it adds `[places."slack:<channel id>".access]` to `hydra.toml`. Gate settings for the workspace go under `[gateways.slack]` (`ack_reaction`, `listen`, `off`, `mention_patterns`).

**The gateway's app is not a connector app.** The gateway opens its own Socket Mode connection with `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. The connector opens one more for each app hydra.toml declares, in every daemon. If hydra.toml declares an app whose `bot_token_env`/`socket_token_env` name those same two variables, the same Slack app gets two connections, and Slack hands each event to only one of them, unpredictably. On a Slack daemon (`CHAT_PLATFORM=slack`) hydra.toml refuses such an app when it loads, naming the key; `hydra config check slack` says the same. So to route Slack by specialists and rules beside the gateway, create a **separate** Slack app for the connector and declare that one ([Apps in hydra.toml](#apps-in-hydratoml)), with its own variables:

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
hydra up slack                                  # daemon + bot
```

Fix every ✗ that preflight reports before `hydra up`. `hydra preflight slack` re-runs the checks. See [ONBOARDING_TIPS.md](ONBOARDING_TIPS.md) for the gotcha behind each step.

Healthy = daemon log shows `slack gateway: connected as <bot>` **and** `bridge registered for session main`. With an app declared in hydra.toml, also expect `daemon: slack connector: catch-up (boot, deep): done` once for each app; an app that did not connect logs `slack connector for <name> (<id>) off (…)` and says which key to fix. Then DM the bot.

## Apps in hydra.toml

*Slack connector.* Three words mean one thing each from here on. An app **serves** a specialist when it is pinned to it, or when it is unpinned and no specialist is pinned to that app; a message **heard** by an app arrived through its connection. A message is **owed** from the moment it is accepted until a delivery lands. An **episode** is one run of one trouble (an app down, a scope missing): it is said once when it starts, and not again until it has ended and starts anew; drops and gaps count an hour from the first.

The sections from here to *Known limits* tell one story, in the order an app lives it: you **declare** it, print its **manifest**, put its **tokens** in `.env`, and it **connects**; **routing** and **pins** decide what it hears; one app, the **owning app**, answers each message; **conversations** and **replies** follow the app that heard them; **health and alerts** are kept for each app on its own; the **runbook** and **adding an app** are how you act on it.

hydra.toml declares each Slack app by name, `[slack.apps.<id>]`. Tokens stay in `.env`; the keys name the variables that hold them.

```toml
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"      # required: the bot token (xoxb-…)
socket_token_env = "CONNECTOR_SLACK_APP_TOKEN"      # the Socket Mode token (xapp-…, the app-level token): required for Slack to connect, not for `hydra slack manifest`
operator_token_env = "SLACK_USER_TOKEN"    # optional: hear the channels, DMs and group DMs the operator is in, as the operator; used to edit or delete the operator's own messages from main, never to post
display_name = "Acme helper"           # the app's name: in `hydra slack manifest`, and in every alert, health line and notice hydra says about it (default: `hydra` for `default`, else the id; at most 35 characters)
description = "Answers Acme's threads it is tagged in."   # at most 140 characters

[slack.apps.sales]
bot_token_env = "SALES_SLACK_BOT_TOKEN"
socket_token_env = "SALES_SLACK_APP_TOKEN"
```

- An app's id is lowercase letters, digits, `-` and `_`, starting with a letter, at most 35 characters. Uppercase is reserved for Slack's own ids (`C0TEST`).
- Each token needs its own variable: one variable on two keys (two apps, one app, or an app and `[gateways.discord]`) is an error.
- Token variable names are uppercase. Hydra keeps every variable hydra.toml names as a token from the sessions it starts, so name only variables the daemon needs. These are refused when hydra.toml loads: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMUX`, `TERM`, `PWD`, `TMPDIR`, `LANG`, `ANTHROPIC_API_KEY`, `GH_TOKEN`, `SSH_AUTH_SOCK`, and anything starting `HYDRA_` (except `HYDRA_SLACK_`), `CLAUDE_`, `LC_` or `XDG_`.
- Every app declared connects, whatever it is named, when hydra.toml loads, with no restart, if its token variables are already in the daemon's environment (a variable that is new needs one). An app whose tokens are not set is skipped: the daemon says which key to fix, in the thread of each specialist that app serves and that hears Slack (main's channel when none does), and logs `slack connector for <name> (<id>) off (…)`; the others connect.

`hydra slack manifest [<app>]` prints one app's manifest. Leave the name out when hydra.toml declares one app; with several, a missing or unknown name lists the ones declared. The manifest turns on the app's Messages tab and leaves it writable (`features.app_home`: `messages_tab_enabled: true`, `messages_tab_read_only_enabled: false`); without that, Slack refuses the operator's DM to the app (`restricted_action_read_only_channel`).

**An app already created?** Paste the new manifest over its current one: api.slack.com/apps → the app → App Manifest → paste → Save, then reinstall the app if Slack asks.

## Apps and routing

*Slack connector.* **One connection per app.** Hydra opens a Socket Mode connection for each app, each with its own bot, its own tokens, and its own reconnects and catch-up pass. An app added to hydra.toml connects as soon as hydra.toml loads (no restart); one taken out disconnects. Every message records the app that heard it, and everything that follows goes through that app: its reply, its reactions, the files it downloads, the threads it rereads. A message goes in through one app and leaves through the same one.

An app is a way in: a message reaches hydra through the app whose connection delivered it. Routing knows which, and three things use it. `hydra route --person <person:id> --place <place> --app <app:id>` shows each.

**Rules match an app, a place, or both.** A `[[rules]]` entry names `place`, `app` (an app id), or both; an absent one matches every place or every app, so a rule in a hydra.toml with no `[slack.apps.*]` tables and no `app` keys behaves as it did. `person` only narrows who: a rule with `person` and neither `place` nor `app` is an error. The first rule in file order that matches wins. A `target` says its kind: `main`, or `specialist:<name>` for a declared specialist (`thread:<id>` is not a rule's target).

```toml
[[rules]]
app = "app:sales"                # everything that comes through the sales app
target = "specialist:deals"

[[rules]]
place = "slack:#help"
app = "app:support"              # #help, through the support app only
person = "role:staff"
target = "specialist:desk"
```

**A specialist can be pinned to apps.** `pinned_to = ["app:sales"]` in a specialist means two things:

- It answers only messages that come through those apps. A message through another app never reaches it: not through a rule's `target` (including one for `slack:app-dm:*`), or a conversation bound to it.
- Those apps deliver only to specialists pinned to them. Once any specialist is pinned to `sales`, a message through `sales` goes to a specialist pinned to `sales`, or to nobody.

A specialist with no `pinned_to` is unpinned: it answers messages through every app that no specialist is pinned to. `reachable_by` is separate: it governs who may reach a specialist, and still applies. `main` is exempt from pinning: the operator's DM reaches `main` through any app, and `main` still hears only the operator. A rule that would send a message to a specialist its app cannot deliver to is skipped, a binding to one is skipped and the message routed anew, and a guard redirect to one goes to the conversation's own specialist with one alert; `hydra route` says why. hydra.toml refuses a rule whose `app` and `target` can never meet, and a rule that sends a place that is not a Slack place to a pinned specialist. Pinning an app takes it from every unpinned specialist, so hydra.toml warns when a rule sends an unpinned specialist a place where no pinned specialist is also sent.

Two rules may send the same place, to everyone, to two specialists only when no app reaches both: their `pinned_to` lists are disjoint, or one is pinned and the other is not. Two unpinned specialists, or two whose `pinned_to` lists overlap, may not: hydra.toml refuses the later rule, naming both. To split a place between people, give the first rule a `person`.

**One owning app answers a message.** When two apps are in one channel, both hear every message in it, and exactly one answers. The owning app is the first of these that applies, among the apps that heard it:

1. The app the message tags. With two tags, the first in the text. A tag outranks everything below, the app the conversation is bound through included (a tag outranks the bound app): it opens that app's own conversation, even in a thread another app opened. A tagged app whose connection is down counts as having heard its tag, if its bot is in the channel: no other app answers in its place, and it catches the message up when it is back.
2. The app the conversation is bound through, if it is already a bound conversation: an untagged follow-up stays with that app. When the thread is bound through two apps, the one most recently active in it.
3. The channel's `default_app`: `default_app = "app:sales"` under `[places."slack:#help"]` (the place's id or its name; it must be a declared app, on a Slack channel). It is honored as written, even if that app delivers to no one there.
4. The app named `default`, if it delivers to someone at this place.
5. The first app, in hydra.toml order, that delivers to someone at this place.

An app "delivers to someone at this place" when a rule that matches there sends to a specialist it serves (or to `main`), or it is a DM. The app's `router` does not count (nor a catch-all, the old form of `router = "main"`: a rule that sends every place to `main`, no `place`): it takes only what no rule claims. If no app that heard the message does, 4 and 5 pick among all that heard it. So a channel whose only app is pinned to `sales` is answered by `sales` with no `default_app` set; set one only to choose between apps that all deliver.

The other apps do nothing: `hydra route` shows them as `ignored`, with the owning app. The owning app is decided before any specialist, and never hands a message on: if it reaches no one (an explicit `default_app` that delivers to nobody there), the message is unrouted.

```toml
[places."slack:#help"]
default_app = "app:support"      # an untagged message in #help is answered by support; tag @sales and sales answers
```

**Several apps in one channel need a read of who is in it.** Each connection receives every message of a channel its bot is in, so with several apps connected each connection asks whether the other apps' bots are members (`conversations.info`, through that app's own token; an app never asks about itself, and at most 5 asks are in flight). A member is believed for ten minutes, a non-member for 30 seconds (an invite is the common change), and an answer that fails is never taken as a verdict: the last good answer stands and Slack is asked again in 30 seconds. A message that tags an app reads that app again first, so an invite followed at once by a tag is answered by the tagged app. The first connection to decide a message fixes its owning app for every other connection's copy of it (and for a catch-up pass), so exactly one app answers even if who is in the channel changes between two copies. A DM belongs to the app it was sent to. With one app connected nothing is asked. A session listening to a thread through one app is told, once, when a specialist takes the same thread through another: the conversation id names the app, so the session's conversation is a different one and goes quiet.

A join or a leave is seen at once when the apps send `member_joined_channel` and `member_left_channel`. `hydra slack manifest <app>` includes both when hydra.toml declares more than one app. **Adding a second app means adding both events under Event Subscriptions of every app that already exists, and reinstalling each** (step 5 of [Adding an app](#adding-an-app)): an app created while only one was declared does not have them. Hydra says so, once, naming the app, when an invite went unreported; until then a join is noticed only when a tag asks, or within ten minutes. The scopes are ones the manifest already grants for channel names: `channels:read` for public channels, and `groups:read` for private ones (asked of the startup check when hydra.toml names a `slack:G…` place). If the read is refused, the operator is told once, naming the app and the scope; until it is fixed the app that receives a message answers it, so a channel two apps are in may be answered by both.

Each app's bot ids are kept in `<state>/slack-apps.json`, so after a restart a tag of an app that has not connected yet is still recognised. While an app that was started has not yet joined (up to 30 seconds), a message in a channel hydra.toml names is not answered: its cursor is held and a catch-up pass reads it once the app has joined or failed to.

A message from another app's bot is another bot's message: it is passed over unless the place has `bots = true`. A bot that is one of hydra's own apps is never heard, `bots = true` or not, so two apps cannot answer each other.

`hydra route` takes `--app <app:id>`: the app this check runs for, the one that heard the message (default: the app named `default`). `--heard-by <app:id,app:id>` adds the other apps in the channel. `--mentioned <app:id,app:id>` lists the apps the text tags, first tag first. `--bound-app <app:id>` (with `--bound`) is the app the bound conversation is bound through (if two, the one most recently active).

## Which app listens

*Slack connector.* Hydra serves two uses through one routing system, and which app listens follows from the use.

- **The operator's harness.** The operator's own app: a bot plus `operator_token_env`, the operator's own token (a Slack user token; it reads, and rewrites the operator's own messages, [below](#editing-and-deleting-slack-messages)). With it, a thread in a channel the bot isn't in is still read, as the operator, and routed to the operator's own sessions (`bind_conversation`), so no bot has to join that channel; the operator's DMs and group DMs are heard too, and delivered only where a place names them ([below](#dms-and-group-dms-the-operators-app-hears)). A whole channel (a place in hydra.toml) is still read through the bot today, so its bot must be in it. These sessions serve the operator, so they may see what the operator sees.
- **Agents for other people.** A restricted app whose own bot sits in the channels its agent serves, routed to specialists, usually restricted specialists (`restricted = true`, [below](specialists.md)). It listens through its own bot.

**When not to listen through the operator's app.** Give the agent an app of its own that listens through its own bot when any of these is true:

1. **The agent must keep working without the operator.** An operator token hears only the channels the operator is in, so leaving a channel, or a refused token, would deafen it.
2. **People tag the agent by its own name.** Slack raises a tag only where that app's bot is a member.
3. **The agent is in a private channel the operator isn't in.**

The operator's app may still route something the operator saw to a specialist, by a rule or a place in hydra.toml. An app that only speaks or reacts is allowed too. Neither is the default.

**Hearing and speaking are separate.** The operator token reads, and edits or deletes the operator's own messages ([below](#editing-and-deleting-slack-messages)); it never posts. Replies, reactions and new threads go out through a bot, and only where that bot is a member; the bot never joins a channel by itself. So in a channel where only the operator's token hears, hydra can listen and route, and an answer meant for a thread there goes to the operator's DM with the app instead, with a link to the thread and why. Invite the bot wherever answers should go in the thread.

### The app's router

*Setting one up from scratch: [A Slack router: setup guide](slack-router.md).*

*Slack connector.* A tag of an app in a channel thread goes to one place, by the first of these that applies:

1. **A binding.** The thread is already bound to a session or a specialist: it goes there.
2. **A rule.** A `[[rules]]` entry matches the place, the app and the sender: it goes to that rule's target.
3. **The app's router.** `router` on the app, below.

```toml
[slack.apps.<the operator's app>]
router = "specialist:slack-router"      # or "main"

[specialists.slack-router]
workdir = "~/agents/slack-router"       # a folder of its own
kickoff_file = "~/agents/slack-router/kickoff.md"   # a copy of docs/router-kickoff.example.md
model = "sonnet"                        # reading descriptions and asking questions: no need for the default opus
reachable_by = ["role:router-approved"] # who may have a thread routed; a role you give people in [people] (default: all of them)
```

`router = "main"` sends the tag to `main`, which hears only the operator. `router = "specialist:<name>"` sends it to that specialist, the **router**, and it hears whoever its own `reachable_by` lets in (the default, `people`, is everyone declared in `[people]`; the operator always; a stranger gets a 🚫). With no `router` the tag is unrouted and logged, as before. The router never sees a thread bound to a session, nor a message a rule matched. It reads a tag in a channel thread: not untagged chatter and not a DM with the bot (a DM is the operator's to main, or a rule's).

The first tag binds the thread to the router, so later messages in it go to the router, tagged or not, until the router binds the thread to another session. The app reacts 👀 on the tag at once, before the router has read it. A router cannot be restricted or write-confined: it binds conversations to other sessions and spawns them, so hydra.toml fails to load and says why. It is an operator-account session, and whoever its `reachable_by` lets in can have it act, so set `reachable_by` to the people you would let route a thread (a role you declare, for example).

`hydra route --person <person> --place <channel>` prints `→ router <name>` for such a tag, and the daemon's log says `→ router <name>` where it delivers one. (A rule with no `place` that sends to `main` still works as it did, for one release; the loader warns and names `router = "main"` instead.)

**Binding to another session.** `bind_conversation` takes two more arguments for main and for the router (every other session is refused): `target`, a session by name (`list_sessions`) or `thread:<id>`, and `why`, one line. It is `hydra conversations bind <conversation> thread:<id> --why "<reason>"`: the thread binds to that session, which listens. Nothing is posted in the Slack thread: its audience is outside hydra, so a link into Discord or an internal session name has no place there, and the app's 👀 on the tag is the people's acknowledgement. The notice `→ <session> <link to its thread>: <why>`, with the Slack thread's permalink, goes to the bound session's own thread (and the `bind` event records it); the session then speaks in Slack itself, about the ask. Where its thread cannot be posted in, the operator's DM with the app gets the notice, and every outcome is logged. A caller hands on only a conversation bound to it, and never to the router itself. Every later message in the thread, tagged or not, goes to that session, saying with each whether the app was tagged and whether it is from the operator, an approved person (declared in `[people]`) or anyone else; such a tag likely asks the session something, and it answers in the thread, through the app, when it judges so, otherwise it listens (a restricted or write-confined session only listens). A tag in a thread bound to a session stays with that session: the router never takes it back.

**Who reads a Slack conversation.** Every delivery from a Slack conversation carries one fixed hydra line: the conversation's audience is outside hydra, so reply only about their ask, and never post links to Discord, hydra or private Slack conversations, or internal session names. On the Slack gateway, hydra's own lines (the 📨/📤 notices between sessions) are posted without link previews, and are not posted at all in the conversation main answers in.

**Finding the session** is the router's own behaviour, written in its kickoff, not in hydra: [`router-kickoff.example.md`](router-kickoff.example.md) is one to copy. It looks in tiers, stops at the first that fits, and reads its past decisions from the event stream (`hydra events`) before the next one:

| Tier | Where it looks | How it takes the thread |
|---|---|---|
| 1 | A **live** session that fits (`list_sessions`) | Asks it, with `send_to_thread(type="question")`, whether the thread is its to handle; on a confident yes, binds the thread to it. A no or no answer in about two minutes: the next candidate, never asking a decliner twice for one thread |
| 2 | An **ended** session whose thread fits (`list_sessions` with `include_ended`; `hydra list --ended`) | Revives it in its own thread (`hydra deliver --to thread:<id> --revive`), then binds the thread to it |
| 3 | A **declared specialist** that fits (`hydra specialist list`) | Starts it (`hydra deliver --to specialist:<name>`, which spawns it from its kickoff if vacant), then binds the thread to it |
| 4 | **Nothing fits** | Spawns a new session for the thread and binds it |
| 5 | **Last resort** | Asks the operator |

`list_sessions` with `include_ended: true` (`ended_within_days`, 1 to 90, default 14, at most 50) also lists the latest session of each thread nobody is in now, read-only, from the thread history hydra keeps: name, description, thread id, link, when it ended. The event stream is the router's memory and the tuning surface: its `bind_conversation` is recorded as a `bind` event with its `why`, a correction is another bind of the same conversation by someone else, and `hydra events --kind bind` shows both, so a correction changes the next decision. Sonnet is enough for it (`model = "sonnet"`): the work is reading descriptions and asking questions, not writing code.

**The event stream.** *The daemon.* The daemon appends one JSON line per event to `<state dir>/events/YYYY-MM-DD.jsonl` (UTC day): ids, names and a bind's `why`, never a message's text (`why` is the one free-text field: the reason whoever binds gave). Only the daemon writes; `hydra events` reads, with the daemon down too. The name is hydra-wide and the scope today is the Slack connector's routing and bindings: Discord, GitHub and clock routing are not recorded yet. Three kinds:

| Kind | Written when | Fields |
|---|---|---|
| `route` | A message was delivered, written when its delivery settles (after the guard may have redirected it, once per message). Or an ask of the bot (a tag in a channel, or a DM with the bot) was stopped: no step took it (`none`: its sender was refused, no place hears it, or it tags an app that cannot hear it), the guard dropped it (`guard`), its sender passed the tag cap (`tag-cap`) or the conversation table was full (`table-full`). Chatter nobody takes, and anything in a DM the bot is not part of, is not recorded | `app`, `conversation`, `by` (the sender's address), `tagged`, `via` (what chose the place: `binding`, `rule`, `router`, `operator-dm`; or `none`, `guard`, `tag-cap`, `table-full` when nothing was delivered), `to` (where it was delivered; absent then) |
| `bind` | A conversation's binding is set or changed: by hand (`bind_conversation`: a session binding to itself, main or the router handing on; or `hydra conversations bind`), or by hydra itself, with `by` = `hydra` and a `reason`: `taken` (a tag took the thread from a session), `renamed` (its specialist was renamed) or `rerouted` (its specialist is gone, or no longer serves the app, or a store from before bindings had none, and routing bound it anew). Not recorded: a bind to the thread's current session, and a first message opening a conversation (its route event shows where it went) | `conversation`, `from` (absent when it opened with this bind), `to` (a specialist id, or a session's thread id), `why` (the reason given, one line, at most 300 characters), `by` (`operator`, `main`, the session or specialist, or `hydra`), `reason` (only when `by` is `hydra`) |
| `unbind` | A conversation is let go, by `unbind_conversation` or `hydra conversations unbind`, or by hydra itself (`by` = `hydra`) with a `reason`: `idle` (past the expiry), `evicted` (for a new one in a full table), `vacant` (nobody in its session thread), `killed` (its session was killed), `thread-gone` (its thread was deleted or can't be read) or `hosted` (its thread became a hydra session's own) | `conversation`, `from`, `by`, `reason` (only when `by` is `hydra`) |

```sh
hydra events --kind bind --since 14d --limit 40  # a table: time, kind, conversation, what happened; the newest 40
hydra events --kind bind --by slack-router       # only what one actor did (`by`: a person address, `operator`, `main`, `hydra`, a session or specialist)
hydra events --by hydra --since 7d               # what hydra let go or moved by itself, with why
hydra events --kind route --to desk              # what was delivered to one place (`to`: a specialist id or a session's thread id)
hydra events --conversation slack:C0ABC:1793732224.093059 --json   # one JSON event per line; with no app in the id, through any app (slack:sales:C0ABC:… names one app's)
```

`--since` takes `90m`, `12h` or `7d`. `--by` keeps the events whose `by` is exactly that actor; `--to` those whose `to` is exactly that place (an unbind has none). `--limit <n>` keeps the newest n that remain after the other filters, still oldest first, so a reader's cost does not grow with the stream. Day files older than `[events] keep_days` days (default 30, at most 3650) are deleted when the daemon starts (once hydra.toml has loaded) and when the UTC day turns.

Where the bot is not in the channel, main's answer, the bound session's and the bind's notice go to the operator's DM with the app, under a line naming who wrote it and linking the thread (a restricted specialist's answer never does: it fails as before). The bot never joins a channel; invite it wherever answers should go in the thread. No Slack app change is needed.

## DMs and group DMs the operator's app hears

*Slack connector.* With `operator_token_env`, the operator's app hears the operator's DMs and group DMs as well as its channels. The manifest (`hydra slack manifest`) adds user scopes `im:history`, `mpim:history` and `im:read` (these are the three this connector needs; the manifest names no `mpim:read`), and user events `message.im` and `message.mpim`; for group DMs that include the bot it also adds bot scope `mpim:history` and bot event `message.mpim`. The workspace admin approves these at install (and a reinstall adds them to an app that exists). Finding who is on the other end of a DM with a person needs the user scope `im:read`. An app installed without it still hears the DM with the bot (that comes from the bot's own DM list, which needs `im:read` on the bot), but a DM with a person names no place and is dropped, and the log says why, until the app is reinstalled with the new user scope. The manifest always lists `mpim:history` and `message.mpim`; the startup scope check asks for them only where a `slack:group-dm:…` place is named. The token can then read all of the operator's DMs: keep it in `.env`, and use it only in the operator's own app. A user token without `im:history` or `mpim:history` receives no DM events, and says nothing.

**Hearing is not delivering.** A place no rule, `[places]` entry or open conversation names is dropped first, before it opens a conversation or thread, reaches a session, or counts or reacts to anything. Every place name means one thing:

| Where it happened | Place | What delivers it |
|---|---|---|
| A DM with one app's bot, from anyone | `slack:app-dm:<app>` | a rule; with none, the operator's goes to `main` |
| A DM with any app's bot | `slack:app-dm:*` | the same |
| The operator's DM with one person | `slack:person-dm:<person>` | a rule for it |
| Every DM with a person | `slack:person-dm:*` | the same |
| One group DM | `slack:group-dm:<G id>` (its channel id, `slack:G0…`, names it too) | the same |
| Every group DM | `slack:group-dm:*` | the same |

`<app>` is an app declared in `[slack.apps.<app>]` (a single-app setup's app is `default`); `<person>` is an id in `[people]` with a Slack address; `<G id>` is a Slack conversation id (`G…` or `C…`). Naming an app or person that is missing, or a person with no Slack address, is an error when hydra.toml loads. `*` names every place of that kind, and a channel or a repository has no `*` form. Discord has one bot, so its only DM place is `discord:app-dm:*`. A group DM's id looks like a channel's, so the loader cannot tell them apart: writing one id both ways (`slack:G0…` and `slack:group-dm:G0…`) in rules or `[places]` is a warning, because a message there matches both and `[places]` reads the `slack:G0…` entry first; two rules for the one group are checked as the same place. A rule at `slack:app-dm:<app>` is a rule for that app, whether or not it says `app`. `home_place` takes a channel, never a DM. The earlier spellings (`slack:dm`, `slack:dm:<person>`, `slack:group-dm`, `discord:dm`) are load errors that name the one to write now. A DM with someone not in `[people]` goes by no name, so it is dropped. A DM with a person does not reach the specialist a rule sends `slack:app-dm:*` to, and `main` takes only the operator's DM with the bot. A DM with the bot that nothing hears (a stranger's, with no rule for `slack:app-dm:*`) is logged and counted and gets no reply. One that a rule routes but `reachable_by` does not admit gets the 🚫, so a colleague told no still learns it. The 🚫 applies to a DM with the bot only (and to a tag in a channel): a DM with a person or a group DM that a place names, but that no rule routes or `reachable_by` refuses, is logged (ids only, no text) and counted and gets no 🚫; one that no place names is dropped first, without a log.

```toml
[[rules]]
place = "slack:person-dm:alice"   # the operator's DM with alice
target = "specialist:deals"

[[rules]]
place = "slack:group-dm:*"   # every group DM the operator is in
target = "specialist:deals"
```

`hydra route --person person:alice --place slack:person-dm:alice` shows what a DM with Alice would do (`--place` names one place, never `*`). Settings in `[places]` (`ack`, `files`, `messages`, `bots`, `default_app`, `link_previews`) resolve the specific place before `*`: an entry for `slack:app-dm:sales` wins over `slack:app-dm:*`, whole, so a setting the specific entry leaves out is not read from the `*` one. Rules are first match in file order (a catch-all, a rule with no `place` to `main`, is tried after the others; the app's `router` replaces it). Only `ack` and `files` apply to `[places."slack:person-dm:alice"]` and `[places."slack:group-dm:*"]`; `link_previews`, `messages`, `bots` and `reactions` there are errors when hydra.toml loads. A `[places]` entry alone counts as naming a place, so untagged chatter in a channel only `[places]` names is heard.

**How a DM gets its place.** Two lists answer two questions. The bot's own DMs (`users.conversations`, types `im`, with the bot token) say which DM is `slack:app-dm:<app>`. For any other DM, the operator's DMs (the same call with the user token, scope `im:read`) say who is on the other end: a person in `[people]` is `slack:person-dm:<person>`. Each list is read at connect and for a DM it has not seen, once at a time; the user list is capped at 25 pages of 200 DMs, so a DM beyond the first 5,000 is not named and is dropped; a DM on neither list goes by no name and is dropped, and a failed read is not tried again for a minute. A group DM's id looks like a channel's, so it is told by the event's `channel_type` (`mpim`). Read-only calls against a real install showed each DM from `users.conversations` carries its other party in `user`, on both tokens (one page, no cursor, for 138 DMs; the pagination stays). **Not yet proven:** the `message.im` and `message.mpim` user-event shapes, and a live drop of a real DM (the go-live check). DMs with people and group DMs are heard live only: catch-up does not rescan them, and the bot answers only where it is a member.

## Conversations and replies, per app

*Slack connector.* **A conversation is an app, a channel and a thread.** The same thread heard through two apps (each tagged in turn) is two conversations, each bound on its own, answered through its own app. Its id, as `hydra conversations`, `reply`, `bind_conversation` and the guard's stdin (`conversation`) write it:

| App | Conversation id | Example |
|---|---|---|
| `default` | `slack:<channel id>[:<thread ts>]` | `slack:C0ABC:1793732224.093059` |
| any other, `sales` here | `slack:<app>:<channel id>[:<thread ts>]` | `slack:sales:C0ABC:1793732224.093059` |

A DM, or a top-level message where `messages = "all"`, has no thread ts: `slack:D0ABC`, `slack:C0ABC`. Copy the id from the delivery you are answering.

The id of `default` is exactly what it was in a hydra.toml with no `[slack.apps.*]` tables and no `app` keys, so its sessions, transcripts, stored conversations and idempotency keys carry on; a conversation id written without an app is `default`'s, and `slack:default:C0ABC:…` names the same conversation. Another app's per-conversation session is named with the app in it (`deals_sales-c0abc-1793732224-093059`), and its attachments are kept under `<state>/slack-files/sales/<channel>/`. Stored conversations and catch-up cursors carry the app when it is not `default`; a conversation store written without apps loads as `default`'s and is not rewritten.

**Replies leave through the app that heard the message.** `reply` into a conversation posts with that conversation's app, never another. A post that answers no message (a specialist's `home_place`, a new thread) has no app to follow, so it uses the specialist's `speaks_as`:

```toml
[specialists.deals]
pinned_to = ["app:sales"]
speaks_as = "app:sales"        # the app it posts as when it answers no message; one of `pinned_to` if it is pinned
home_place = "slack:#sales-ops"
```

`speaks_as` must name a declared app, and one of `pinned_to` for a pinned specialist; an unpinned specialist cannot speak as an app another specialist is pinned to. Absent: its first pinned app; if it is unpinned, `default`, else the only app declared. With several apps, none of them `default`, `speaks_as` is required of a specialist with a Slack `home_place`: hydra.toml refuses to load without it. A `#name` home_place is resolved through that app's workspace. The thread such a post opens is a conversation of that app, bound to the specialist.

**Answering one message: `reply_to`.** `reply(chat_id=<the delivery's conversation>, reply_to=<the message's ts>)` posts in the thread of that message; `chat_id` stays the conversation, never the ts (a message's ts is not a conversation until something opens it). In a DM (the one conversation with no thread ts: every message elsewhere is its own thread), the thread opens under that message and is bound to the replying specialist or `main` as the first part lands, so the person's answer in it comes back to that session and not to whoever the rules name for the place; if the conversation table or the replier's `TOOL_BIND_MAX` is full, the post still lands and the result says follow-ups will not come back. An existing conversation under that message is answered only by whoever it is bound to. In a thread conversation the post goes to the thread as a whole (Slack has no reply to one message inside a thread): a `reply_to` other than its first message is said in the result. A `reply_to` that is not a message ts, one on a `home_place` post, or one from a per-conversation session at a top level (its thread would be a new conversation with a session of its own) posts nothing and errors. Replies on the Slack gateway (`gateways/slack.ts`) already use `reply_to` as the thread ts.

`bind_conversation` and `hydra conversations bind` carry the app too, and refuse what routing would: a specialist can be bound only through an app it is pinned to (any app if it is unpinned).

### Slack lines in a session's thread

A session bound to a Slack conversation shows its Slack traffic in its own chat thread the way it shows a session-to-session send: one quiet line (subtext, a masked link with no preview, never posted into Slack).

- `📨 from <emoji> [sam](<permalink>) → <summary>`: someone in `[people]` tagged the app in a conversation bound to this session. The name is theirs from `[people]` (`name`, else the id), the link their message. An untagged message, and a tag by anyone not in `[people]`, get no line.
- `📤 to <emoji> [thread](<permalink>) → <summary>`: the session's `reply` posted into a Slack conversation; the link is that conversation's.

Both are written where the matching record is: 📨 where delivery settles (the `route` event of `hydra events`, once per message), 📤 where the reply lands, so a line and an event cannot disagree about what happened. A conversation bound to a specialist rather than a session's own thread gets no line.

`<emoji>` is `[slack] line_emoji`, a unicode emoji or a Discord custom emoji (`<:slack:123456789012345678>`), checked for shape when hydra.toml loads. A custom emoji exists in one server only, so each line asks the gateway whether it can render it and shows 💬 (the default) when it cannot.

### Editing and deleting Slack messages

*Slack connector.* `edit_message` and `delete_message` take a conversation id as `chat_id` and the message's ts as `message_id`. Hydra reads the message's author from Slack and picks the token: **a bot's** message is rewritten with the bot token of the app whose bot wrote it, and **the operator's own** with the operator's user token (the app that has `operator_token_env`). Any session that is not a restricted specialist may do either, in any conversation its tokens reach, bound or not; with no app named (`slack:<channel>[:<ts>]`), each app is asked until one knows the author. A **restricted specialist** (`restricted = true`) keeps the narrow rule: only its own app's bot's messages, only in a conversation bound to it (the rule `reply` holds), never the operator's. Anyone else's message is refused before Slack is asked. The operator's token needs the user scope `chat:write`, which `hydra slack manifest <app>` lists for an app with `operator_token_env`; an app installed before that has the old scopes, so add `chat:write` under User Token Scopes and reinstall, and until then the call says exactly that. Slack's own refusals are shown as they came. There is no `hydra.toml` key for it: the scope, the restricted rule and the author check already gate it. An edit is one message (at most 3,900 characters, not split) and takes no files.

*Slack connector.* `fetch_messages` takes a conversation id as `channel` and reads that conversation through the app the id names (`default` when it names none), never the chat gateway, oldest first, one line each as for a Discord channel (the app's own bot is `me`). `limit` is a whole number from 1 to 100 (20 when left out); anything else is refused. A **thread** gives its newest `limit` messages (its first message among them only while the thread is that short); it is read to its end to reach them, and a thread longer than about 2,000 messages (10 pages of Slack's 200) is refused rather than answered with its oldest. A **channel's or DM's top level** gives its newest `limit` top-level messages. A restricted or write-confined session reads only a conversation bound to it, and never a channel's top level: there Slack returns every top-level message, those routed to another specialist or app too. A DM's top level, and a thread, bound to it stay readable. Any other session reads what the app's bot can read. The operator's token, which also reads the operator's own DMs and groups, reads only a thread hydra holds (one in `hydra conversations`), the reach catch-up has: a thread the bot is not in is read as the operator once it is bound, and refused before then, saying how to bind it when the app has an operator token (binding also delivers the thread's new messages to the session). A top-level read uses the bot's token alone.

## Health and alerts, per app

*Slack connector.* **Health is kept for each app on its own.** Each app has its own connection, its own catch-up pass, and its own record of what it has told you, so one app's trouble neither raises, hides, nor repeats another's. `hydra health` prints one line per app, with the app's name (its `display_name`; a lone `default` prints the single `slack connector:` line):

```
slack connector: 2 apps · 14 conversations · 0 owed
  default: up · last event 1 min ago · catch-up ok 3 min ago · scopes ok
  sales: down 12 min · last event 14 min ago · catch-up failing (…) 40 min ago · missing chat:write (replies)
```

In `hydra health --json`, `slack.apps.<id>` holds each declared app's:

- `name`: what messages call the app (its `display_name`, set or defaulted);
- `state`: `off` (no connection: its tokens are missing, or it failed to start), `connecting`, `up`, `down`, or `exhausted` (reconnect attempts keep failing; hydra keeps trying);
- `downMin`, `lastActivityAgeMin`, and the last catch-up (`ok`, `accepted`, `reason`) with `lastOkCatchUpAgeMin`;
- `eventsOff`: Slack has probably switched the app's live events off (below); the line adds `live events probably off: turn Enable Events back on`;
- `missingScopes`: what the bot token lacks of what hydra.toml has the app do (empty when complete; `null` until Slack has said what the token holds, which the line prints as `scopes unchecked`);
- `tokens`: `{ ok: true }`, or `{ ok: false, why }` naming the key to fix;
- `connection`: `pending` (starting), `up`, `down` (lost, or never possible without tokens), or `gaveUp` (the first connection failed and was let go, or reconnecting is exhausted);
- `probeError`: why its reads of whether it is in a channel fail (each distinct reason once), with the kind of channel when Slack names the scope. With one app it is shown on the `default` line as `membership unreadable (…) · fix: …`.

Besides the apps, `slack` holds `owedLate`: each conversation whose oldest owed message is older than `owedLateAfterMin` (20: two catch-up passes, at 10 minutes each, have not delivered it), with `to`, `count`, `oldestAgeMin` and `cause`. The cause is the first that holds, in this order, and says what to do (a failure is one line of at most 200 characters): its app has no live connection, its specialist is waiting for a session (`max_sessions`), the guard keeps saying deferred, its specialist is no longer declared, the last delivery failure with Slack's or the session's own words, or none recorded (the next catch-up pass replays it). The line reads `owed 2 to specialist:ops in slack:C0ABC:1793732224.093059, oldest 31 min (past 20 min): …`.

An app removed from hydra.toml while its connection is still shutting down shows `declared: false` in the daemon's record and is gone from the next pass. `slack.listener` is the same fact as `slack.apps.default` (else the first connected app), kept for what already reads it.

**Scope check, per app.** At connect each app's bot token is checked against the scopes *that app* needs, from what hydra.toml has it do:

- channel history, when it reads a named channel, serves a rule that has no place (it reaches every place), or serves a specialist that no rule sends a place to (that one answers only threads bound to it);
- the channel-name read, only for a `#name` among its places; files, only when a place it reaches has `files`;
- DMs (`im:*`), when a specialist or rule it serves names `slack:app-dm:<app>` or `slack:app-dm:*`, or the operator has a Slack address (their DM reaches `main` through any app);
- group DMs (`mpim:history`), when a specialist or rule it serves names a `slack:group-dm:…` place;
- the membership reads (`channels:read`, and `groups:read` only when one of its places is a `slack:G…` channel), only with several apps and only for an app that reads channels.

A missing scope is always logged and shown in `hydra health` (`missing <scope> (<option>)`), and alerted once per episode for what hydra.toml declared, naming the app (a lone `default` says no app), the scope, and the fix: `hydra slack manifest <app>` prints the full list, then reinstall the app, put the new bot token in the variable its `bot_token_env` names, and restart the daemon. An episode lasts until the token is complete again, so a restart does not say it twice (what was said is kept in `<state>/slack-scopes-told.json`). The one exception: `im:*` asked only because the operator has a Slack address, with no specialist or rule naming a DM with the bot, is logged and shown in health but never alerted, since nothing declared a DM.

**Alerts, per app.** Each of these has its own episode for each app, so app A's outage neither suppresses nor duplicates app B's:

- the app's connection is down for 5 minutes awake, and back up;
- the catch-up pass has not completed for 25 minutes awake, or Slack refuses it for a reason retrying cannot fix (`missing_scope`, `invalid_auth`, `not_in_channel`, which names the channel);
- the periodic pass finds messages the live stream never delivered, with the connection up since the previous complete pass began. When the socket delivered events in that window, the stream is split: another process probably holds a connection on the app (at most hourly). When it has delivered none, the stream is most likely off (on a quiet app, a split stream can look the same, and the alert says so): after 3 such passes with no live event since, the alert says Slack has probably switched off the app's live events (it does this after too many failed deliveries, and says so only by email to the app's owner), and gives the fix: turn **Enable Events** back on in the app's Event Subscriptions page (Socket Mode needs no Request URL). Once per episode; the next live event ends it, says so, and makes what the stream missed until then a gap for catch-up to fill. Passes after a reconnect or a wake never count;
- a thread is let go because no token can read it any more, or the operator's token is refused (each at most hourly);
- a message is dropped, or catch-up skipped part of a busy channel (once an hour per kind, specialist and app);
- channel names can't be read and a `#name` the app needs goes unresolved;
- a token variable is empty (the app is skipped), or a declared scope is missing.

**Who hears an alert.** An alert about one app goes to the specialists that app serves and that hear Slack (a Slack rule for the app sends to them), and to `main`'s channel when none does or none has a thread yet. A pinned specialist is paged only by its own apps; an app no specialist uses pages no one but `main`; an app hydra.toml no longer declares pages `main` only. An alert about one specialist (a drop, a thread let go, a guard redirect) goes to that specialist. One about no app in particular (the old `slack-watch.json` left unmigrated: run `hydra migrate`) goes to every specialist that hears Slack. A lone `default` serves every specialist, so it reaches the same ones it always did.

**Catch-up, per app.** Each app has its own cursors, last-complete time, gap time, retry timer and in-progress pass. A slow pass of one app does not delay another's; a pass that fails retries after 60 seconds for that app alone and alerts once for it, and does not mark another app's pass failed. A freed place wakes only the apps that have conversations waiting for it.

### Runbook: reading `hydra health`

Start with `hydra health`; `hydra health --json` has every field above.

| You see | It means, and what to do |
|---|---|
| `<app>: off · bot_token_env … names X, which has no value` | The variable is not in the daemon's environment. Put the token in `.env` and restart the daemon: new variables are read only at start. |
| `<app>: off` and no key named | Its tokens are there but its connection failed to start (see `slack connector … failed to start` in the daemon log). Fix what the log says and save hydra.toml: the next load tries again. |
| `<app>: down`, or `exhausted` | Its connection is lost. Check both tokens and the app's Socket Mode setting at api.slack.com/apps. A first connection that fails is retried (10 s doubling to 5 min) until it connects, then a catch-up pass runs. Other apps are unaffected. |
| `missing <scope> (<option>)` | Add the scope to that app (`hydra slack manifest <app>` lists them), reinstall it, update its bot token, restart the daemon. |
| `scopes unchecked` | The app has connected but Slack did not say what its token holds, or it has not connected yet. Check again after the next reconnect. |
| `catch-up failing (…)` | Read the reason. A budget or a rate limit: the next pass resumes from the held cursor. A permanent error: the alert says what to do. |
| `live events probably off: turn Enable Events back on` | Slack switched off the app's events (it does after too many failed deliveries, and emails the app's owner). In the app's settings at api.slack.com/apps, open Event Subscriptions and turn **Enable Events** back on; Socket Mode needs no Request URL. The next live event clears it. If it is already on, another connection is probably taking this app's events: stop the other process. |
| `up`, and `catchUp.accepted > 0` in `hydra health --json` pass after pass, with live events still arriving | A second connection holds this app (Slack splits events). Stop the other process. |
| `owed … oldest N min (past 20 min): <cause>` | A message has been owed longer than two catch-up passes. The cause names what holds it and what to change; with none recorded, wait for the next pass, and look for the app's own line above it. |
| `membership unreadable` | The app could not read whether its bot is in a channel. The line gives Slack's reason, and the kind of channel (public or private) when Slack names the scope it needed (`channels:read` or `groups:read`). Where several apps share a channel, a top-level tag of that app is left to it when no other tagged app is known to hear it, and nobody answers if its bot is not in the channel (the log says so once). Untagged messages may be answered by more than one app. Add the scope and reinstall. |
| A join was not noticed | An app lacks `member_joined_channel` and `member_left_channel`: add them to its Event Subscriptions and reinstall (the *Add the membership events* step of [Adding an app](#adding-an-app)). |
| Slack is not connected, and a `slack-watch.json` is in the state dir | hydra.toml declares no app and the old file is no longer read: run `hydra migrate`. |

## Adding an app

*Slack connector.*

1. **Declare it:** `[slack.apps.<id>]` in hydra.toml with `bot_token_env` and `socket_token_env` (and `operator_token_env` if it should read threads as the operator).
2. **Create it:** `hydra slack manifest <id>` prints its manifest. Create the app from it at api.slack.com/apps, install it, and put its tokens in the variables the keys name, in `.env`.
3. **Restart the daemon:** it reads the tokens from its environment when it starts. The app connects when hydra.toml loads, with no restart, if its token variables are already in the daemon's environment.
4. **Invite the bot** to the channels it should hear. For a channel more than one app is in, `default_app` says which answers an untagged message; `pinned_to` on a specialist pins it to an app.
5. **Add the membership events to every existing app.** A second app changes the first: add `member_joined_channel` and `member_left_channel` under Event Subscriptions of each app that already exists (`hydra slack manifest <app>` lists them) and reinstall each, so a join or a leave is noticed at once. Until you do, hydra alerts once, naming the app, when an invite goes unreported, and a join is noticed only when a tag asks or within ten minutes.
6. **Check:** `hydra route --person <person:id> --place <place> --app <app:id>`, then `hydra health` (the new app's line, with its scope status; see the [runbook](#runbook-reading-hydra-health) if it is not `up`).

## Specialists

What a restricted or write-confined specialist can and cannot do, and how to declare one: [specialists.md](specialists.md).

## Known limits

*Slack connector.*

- A restricted session that was already running when it was last checked is not checked again while it runs (#617); only a new start is. The check also reads Claude Code 2.1.32x's wording of its debug file: a version that words those lines differently refuses starts until the check is updated.
- Slack edits are not covered by `link_previews` (`chat.update` takes no unfurl argument).
- Where two apps are in one channel and who is in it is not yet known (a membership read has not answered, or an app has not joined), each app may answer what it receives, so a channel two apps are in may be answered by both until the read lands.
- While an app that was started has not yet joined (up to 30 seconds), a message in a channel hydra.toml names is not answered; its cursor is held and a catch-up pass reads it once the app has joined or failed to.
- A place's `default_app` that names an app whose connection is down means the other app answers: `default_app` is honored only among the apps that heard the message, and a down app heard nothing.
- A tag of a declared app that is down and not in the channel is answered by no one until it is back: the tag outranks the other apps (they stand down), and the tagged app can only catch the message up in a channel it is in.
- An app created while only one app was declared lacks the membership events (step 5 of [Adding an app](#adding-an-app)) until they are added.

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

*Slack gateway.* Plain replies are sent via Slack's `markdown_text` field, so the bot can use the **full GitHub-flavored Markdown palette** and it renders natively:

- **bold** (`**x**`), _italic_ (`_x_`), ~strike~ (`~~x~~`), `inline code`
- fenced ```code blocks```, `> blockquotes`, `---` dividers
- bullet lists (`- ` / `* `, nested), numbered lists (`1.`), and **tables** (`| a | b |`)
- headings (`#`), links (`[label](url)`), and emoji (`:tada:` / unicode)

Constraints: `markdown_text` caps at ~12k chars (longer messages fall back to classic mrkdwn), and **button/permission prompts** use Block Kit (classic mrkdwn, fewer features). This layer only guarantees the palette renders — it imposes **no house style**. How a given bot *presents* (terse vs detailed, emoji, when to use a table vs bullets) belongs in that bot's own instructions / `CLAUDE.md`.

## Spawned sessions

*Slack gateway.* DM `spawn: <anything, multi-paragraph ok>` to fork an isolated Claude session in a thread. The confirmation includes `tmux attach -t <name>` so you can view/drive it from any terminal. Replies in that thread route back to the spawned session; the rest of your DMs go to the main session.
