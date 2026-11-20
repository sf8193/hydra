# A Slack router: setup guide

Tag your own Slack app in a thread, and hydra finds the session that should handle it. If nothing has that thread yet, hydra hands the tag to a **router**: a specialist that reads the thread and picks one of these, in order:

1. A live session that fits, after asking it.
2. An ended session that fits, revived.
3. A declared specialist that fits.
4. A new session.
5. You, asked in the router's own thread with a suggestion.

The router then binds the Slack thread to the session it picked. From then on, every message in that thread goes to that session, and the session answers in Slack itself.

This page is the short path. The full reference is [Slack setup](slack.md), especially [Which app listens](slack.md#which-app-listens) and [The app's router](slack.md#the-apps-router).

## 1. Your own Slack app

The router serves **your** app: a bot plus your own Slack user token. The user token lets the app hear every thread you are in, with no bot joining the channel. Use one app per operator, never shared: one app token is one event stream.

1. Declare the app in hydra.toml. Its tokens stay in `.env`; the keys name the variables that hold them:
   ```toml
   [slack.apps.mine]
   bot_token_env = "MINE_SLACK_BOT_TOKEN"        # xoxb-…
   socket_token_env = "MINE_SLACK_APP_TOKEN"     # xapp-…, Socket Mode
   operator_token_env = "MINE_SLACK_USER_TOKEN"  # xoxp-…, your user token: hears as you, never posts
   display_name = "Mine"
   router = "specialist:slack-router"          # "specialist:<name>" | "main" (main hears only you)
   ```

   Values: `operator_token_env` is optional, but without it the app hears only where its bot is a member. `router` is `"specialist:<name>"` or `"main"`; leave it out and an untaken tag is logged and dropped.
2. Print the manifest with `hydra slack manifest mine`. At api.slack.com/apps, create the app **from a manifest** and paste it in. For an app that already exists, paste the manifest over the old one.
3. Under Basic Information → App-Level Tokens, generate a token with the scope `connections:write`. That is the `xapp-…` token.
4. Install the app to the workspace. Copy the **Bot User OAuth Token** (`xoxb-…`) and the **User OAuth Token** (`xoxp-…`) into `.env`.

What the manifest asks for, and why:

| Part | Scopes and events | What it is for |
|---|---|---|
| Bot | `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`, `im:*`, `mpim:history`, `files:read`, `chat:write`, `reactions:read`, `reactions:write` | Reading where the bot is a member, posting answers, the 👀 on a tag, DMs with the app |
| User (you) | `channels:history`, `groups:history`, `im:history`, `mpim:history`, `im:read`, `chat:write` | Hearing threads, DMs and group DMs you are in, without the bot. `chat:write` only edits or deletes your own messages; the user token never posts |
| Events | `message.channels`, `message.groups`, `message.im`, `message.mpim` (bot and user), plus renames, joins and `reaction_added` (bot) | Delivery over Socket Mode |
| App Home | Messages tab on, and not read-only | Your DMs to the app; Slack refuses them otherwise |

Your workspace admin may have to approve the user scopes. A user token missing `im:history` or `mpim:history` receives no DM events, and nothing reports that.

## 2. The router specialist

```toml
[specialists.slack-router]
workdir = "~/agents/slack-router"     # a folder of its own
kickoff_file = "~/agents/slack-router/kickoff.md"   # your copy of docs/router-kickoff.example.md
home_place = "discord:<channel id>"   # "discord:<channel id>" (Discord gateway) | "slack:<channel id>" (Slack gateway) | a bare channel id: where its thread opens, and where it asks you (tier 5). A #name is not resolved yet: it falls back to the default channel
emoji = "🛜"
model = "sonnet"                      # "sonnet" | "opus" | "haiku" | a full model id: it reads descriptions and asks questions, so Opus isn't needed
reachable_by = []                     # [] (only you) | ["role:<role>"] (roles you give people in [people]) | leave out (everyone in [people]); see below
sessions = "shared"                   # "shared" (one router for every thread) | "per-conversation" (one per thread)
handoff_at_pct = 25                   # replaced by a fresh session at 25% context…
handoff_protocol = "kill_and_respawn" # "kill_and_respawn" (no letter: its memory is `hydra events`) | "letter"
```

## 3. The kickoff

Copy [`router-kickoff.example.md`](router-kickoff.example.md) into the workdir. Then add your own lines: your user id as your gateway writes a mention (Discord `<@…>` | Slack `<@U…>`), so the router can tag you when it asks, and any standing hints about where kinds of work belong. The tiers, and how the router asks a live session "is this yours?", live in that file, not in hydra, so you tune the router by editing it. A running router picks up a kickoff edit only when it next starts.

## 4. Check it

1. Run `hydra config check <platform>` (`discord` | `slack`, your gateway). It names any key that is wrong.
2. Run `hydra route --person person:operator --place slack:<channel id> --app app:mine --mentioned app:mine`. It should say `delivers to specialist:slack-router (by router), and binds the conversation to it`.
3. Run `hydra health --daemon <platform>`. Your app should be up with `scopes ok`.
4. Tag the app in a Slack thread. The app reacts 👀 at once. The chosen session gets a notice in its Discord thread with the link and the reason, and nothing is posted in Slack.
5. Run `hydra events --kind bind --since 1d` to see each placement with its `why`.

## On the Slack gateway

Everything above works when you talk to hydra through Slack (`CHAT_PLATFORM=slack`) instead of Discord, with these differences:

- **Two Slack apps.** The router's app must be a second app, not the gateway's. hydra.toml refuses the gateway's `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` under `[slack.apps]`. The same token copied under another variable name passes the check, and then Slack splits events between two connections. The two apps may be in different workspaces.
- **`home_place = "slack:<channel id>"`**: a channel the gateway's bot is in. With several apps and none named `default`, also set `speaks_as = "<app>"` on the router.
- **Tier 5 happens in Slack.** The router asks you in its own thread in the gateway's channel. Put your gateway workspace's `<@U…>` in the kickoff, and treat links to that channel as internal, the way the kickoff treats Discord links.
- **Keep the session channel private.** Every bind notice, 📨/📤 line and router question is a real Slack message there, read by anyone in that channel.
- **A Discord custom `line_emoji` shows as 💬.** Use a unicode emoji or leave it out.

## Things to decide

- **What the router is for.** It places threads; it never does the work. It reads the thread, picks a session, binds the thread there and moves on. It doesn't answer in Slack or take the ask itself, and it never takes a thread back from the session it bound. All of its behaviour is its kickoff. It is one shared session running under your account: it spawns sessions and binds threads, so it can't be restricted, and whoever reaches it is staffing work through you.

- **Who may start routing.** `reachable_by` decides whose tag reaches the router. `[]` means only you. The default is everyone in `[people]`, and a stranger's tag gets a 🚫. The router runs under your account and can spawn sessions, so let in only people you would let staff work for you. Once a thread is bound, a tag from you or from anyone in `[people]` gets an answer from the bound session. Anyone else's message is delivered, but the session only listens.
- **Hearing is not speaking.** Your user token hears; only the bot posts, and only where it is a member. In a channel the bot isn't in, an answer goes to your DM with the app instead, with a link to the thread. Invite the bot wherever answers should land in the thread.
- **A whole channel still needs the bot.** The user token covers threads you are tagged or bound in. A place that routes every message in a channel (`messages = "all"`) is read through the bot.
- **The user token reads all your DMs.** Keep it in `.env`, and use it only in your own app.
- **When not to use your own app.** Give an agent its own app, listening through its own bot, when it must keep working without you, when people tag it by its own name, or when it serves a private channel you aren't in. A restricted specialist ([`restricted = true`](slack.md#a-specialist-other-people-talk-to-restricted--true)) belongs on such an app. The router itself cannot be restricted, and hydra.toml refuses one that is.
- **Nothing hydra-internal in Slack.** The bind posts nothing in Slack. Every Slack delivery tells the session that its audience is outside hydra: no Discord links and no session names.
- **A laptop that sleeps or goes offline.** Hydra runs where you run it. While the daemon is unreachable, Slack can turn the app's events off: api.slack.com/apps → the app → **Event Subscriptions** shows **Enable Events: Off**. They stay off until you switch them back on by hand. Hydra catches up on the threads it already knows when it reconnects, but nothing new arrives until events are on again. If `hydra health` shows the app up but its last event is hours old while people are tagging it, check that switch first.
- **Corrections teach it.** If a thread landed in the wrong place, bind it where it belongs (`hydra conversations bind`, or tell the session that has it). That bind is recorded, and the router reads its last 14 days of binds before every decision.
