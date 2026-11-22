# A Slack router: setup guide

Tag your own Slack app in a thread, and hydra finds the session that should handle it. If nothing has that thread yet, hydra hands the tag to a **router**: a specialist that reads the thread and picks, in order: a live session that fits (after asking it), an ended session that fits (revived), a declared specialist that fits, a new session, or you. The router binds the Slack thread to the session it picked, and from then on every message in the thread goes to that session, which answers in Slack itself. The full reference is [the Slack connector page](slack-connector.md).

## 1. Your own Slack app

The router serves **your** app: a bot plus your own Slack user token, which lets the app hear every thread you are in without the bot joining the channel. Use one app per operator: one app token is one event stream.

1. Declare the app in hydra.toml. Tokens stay in `.env`; the keys name the variables that hold them:
   ```toml
   [slack.apps.mine]
   bot_token_env = "MINE_SLACK_BOT_TOKEN"        # xoxb-…
   socket_token_env = "MINE_SLACK_APP_TOKEN"     # xapp-…, Socket Mode
   operator_token_env = "MINE_SLACK_USER_TOKEN"  # xoxp-…, your user token: hears as you, never posts
   display_name = "Mine"
   router = "specialist:slack-router"          # "specialist:<name>" | "main" (main hears only you)
   ```
   Without `operator_token_env` the app hears only where its bot is a member. Without `router`, an untaken tag is logged and dropped.
2. Print the manifest with `hydra slack manifest mine`. At api.slack.com/apps, create the app **from a manifest** and paste it in (for an existing app, paste it over the old one).
3. Under Basic Information → App-Level Tokens, generate a token with the scope `connections:write`: that is the `xapp-…` token.
4. Install the app to the workspace. Copy the **Bot User OAuth Token** (`xoxb-…`) and the **User OAuth Token** (`xoxp-…`) into `.env`. Your workspace admin may have to approve the user scopes; a user token missing `im:history` or `mpim:history` receives no DM events, and nothing reports it.

## 2. The router specialist

```toml
[specialists.slack-router]
workdir = "~/agents/slack-router"     # a folder of its own
kickoff_file = "~/agents/slack-router/kickoff.md"   # your copy of docs/router-kickoff.example.md
home_place = "discord:<channel id>"   # or "slack:<channel id>" or a bare channel id: where its thread opens, and where it asks you
emoji = "🛜"
model = "sonnet"                      # it reads descriptions and asks questions, so Opus isn't needed
reachable_by = []                     # [] (only you) | ["role:<role>"] | leave out (everyone in [people])
sessions = "shared"                   # one router for every thread
handoff_at_pct = 25                   # replaced by a fresh session at 25% context…
handoff_protocol = "kill_and_respawn" # …with no letter: its memory is `hydra events`
```

## 3. The kickoff

Copy [`router-kickoff.example.md`](router-kickoff.example.md) into the workdir and add your user id as your gateway writes a mention (Discord `<@…>`, Slack `<@U…>`) so the router can tag you when it asks, plus any standing hints about where kinds of work belong. The tiers live in that file, not in hydra, so you tune the router by editing it. A running router picks up an edit when it next starts.

## 4. Check it

1. `hydra config check <platform>` names any key that is wrong.
2. `hydra route --person person:operator --place slack:<channel id> --app app:mine --mentioned app:mine` should say `delivers to specialist:slack-router (by router), and binds the conversation to it`.
3. `hydra health --daemon <platform>` should show the app up with `scopes ok`.
4. Tag the app in a Slack thread. The app reacts 👀 at once, the chosen session gets a notice with the link and the reason in its own thread, and nothing is posted in Slack.
5. `hydra events --kind bind --since 1d` shows each placement with its `why`.

## On the Slack gateway

When you talk to hydra through Slack (`CHAT_PLATFORM=slack`), the router's app must be a second Slack app, not the gateway's: hydra.toml refuses the gateway's tokens under `[slack.apps]`. Use `home_place = "slack:<channel id>"` (and `speaks_as = "<app>"` on the router when no app is named `default`), put your gateway workspace's `<@U…>` in the kickoff, and keep the session channel private, because every bind notice and router question is a real Slack message there.

## Things to decide

- **What the router is for.** It places threads and never does the work. It runs under your account and can spawn sessions, so it cannot be restricted, and `reachable_by` decides whose tag reaches it: `[]` means only you; the default is everyone in `[people]`, and a stranger's tag gets a 🚫. Let in only people you would let staff work for you.
- **Hearing is not speaking.** Your user token hears; only the bot posts, and only where it is a member. In a channel the bot isn't in, the answer goes to your DM with the app. A place that routes every message in a channel (`messages = "all"`) is read through the bot.
- **The user token reads all your DMs.** Keep it in `.env`, and use it only in your own app.
- **A laptop that sleeps.** While the daemon is unreachable, Slack can turn the app's events off (api.slack.com/apps → the app → **Event Subscriptions** shows **Enable Events: Off**) and they stay off until you switch them back on. If `hydra health` shows the app up but its last event is hours old, check that switch first.
- **Corrections teach it.** If a thread landed in the wrong place, bind it where it belongs (`hydra conversations bind`). The bind is recorded, and the router reads its last 14 days of binds before every decision.
