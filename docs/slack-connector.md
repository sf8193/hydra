# Slack connector

The Slack connector (`connectors/slack/`) routes what Slack apps hear to specialists, from `hydra.toml`. It is one connector of [routing](../diagrams/flow-route.mmd), not the Slack gateway (the operator's own chat surface, [slack.md](slack.md)). Routing reads who sent a message, where, and which apps it tags, never the rest of what it says. Every key is in [`hydra.example.toml`](../hydra.example.toml).

**Where a message goes.** A conversation is an app, a channel and a thread (or a DM's top level). Its first message binds it to a specialist: the first matching `[[rules]]` entry (a place, an app, or both), else `main` for the operator's DM. Later messages follow the binding, tagged or not, until the conversation is idle a week. A config change re-routes only new conversations. A tag nothing else takes goes to the app's `router` ([the app's router](#the-apps-router)). `hydra route --person <person:id> --place <place>` shows every candidate and why the winner won; `hydra conversations bind` moves one.

**Who may reach it.** `reachable_by` lists roles (`role:<name>`), never people. It is checked on arrival and again on delivery. The operator reaches everyone, `main` hears only the operator, `role:people` is the roster and `role:anyone` admits strangers. A refused tag or DM gets a 🚫 reaction, once. Hydra's notices to senders are reactions, never prose.

**Replies.** A specialist answers with `reply`, passing the delivery's `conversation` as `chat_id`. The text goes into that thread, split at 3,900 characters, and only when the conversation is bound to the caller. A specialist can also post to its own `home_place`. `reply_to=<message ts>` answers one message; in a DM it opens a thread under it, bound to the replier.

**Reactions.** With `reactions` set on a Slack place, a person's emoji reaction is delivered to the session that owns the conversation it is in. It counts once per message, emoji and person (a skin tone is part of the emoji). One person may react 30 times in 10 minutes (`maxReactionsPer10Min`); past that a reaction is counted and logged as `reaction-cap`, not delivered. A reaction made while hydra was disconnected is not recovered.

**One session per conversation.** `sessions = "per-conversation"` gives each conversation its own session (`<specialist>_<conversation>`), so what one person says is never in another's memory. At most `max_sessions` (default 20) run at once; the rest wait, so give such a specialist an `idle`.

**What the specialist reads.** Each delivery is other people's words in a nonce-marked envelope, never instructions. `person`, `roles` and `operator` come from `hydra.toml`; trust those. `name` is only a label.

**Never silent.** A message is *owed* from acceptance until a delivery lands, saved before anything is sent, so a restart loses nothing and a replay never delivers twice. Drops (`expired`, `owed-full`, `too-large`, `tag-cap`, `table-full`, `catch-up-gap`) are logged, counted, and alerted in the specialist's thread. `hydra conversations` is the operator view.

**Guard.** `[guard]` is your own command, run for each message from anyone but the operator. Exit 0 delivers, 10 drops, 75 keeps it owed; printing `{"target": "specialist:x"}` redirects it. Anything else delivers anyway: a broken guard never silences anyone.

**Catch-up.** Slack replays nothing missed while disconnected, so a pass reads channel history and every owed thread after boot, after each reconnect and every 10 minutes. It cannot recover a tagged reply posted while disconnected in an older thread no conversation was open in.

## Apps in hydra.toml

```toml
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"     # required: the bot token (xoxb-…)
socket_token_env = "CONNECTOR_SLACK_APP_TOKEN"  # the Socket Mode token (xapp-…); needed to connect
operator_token_env = "SLACK_USER_TOKEN"         # optional: also hear the channels and DMs the operator is in; edits and deletes the operator's own messages, never posts
display_name = "Acme helper"                    # the name in the manifest and every alert (at most 35 characters)

[slack.apps.sales]
bot_token_env = "SALES_SLACK_BOT_TOKEN"
socket_token_env = "SALES_SLACK_APP_TOKEN"
```

- An app id is lowercase letters, digits, `-` and `_`, at most 35 characters. Each token needs its own variable; hydra keeps token variables from every session it starts, and refuses `PATH`, `HOME`, `ANTHROPIC_API_KEY` and the like.
- An app connects when `hydra.toml` loads, with no restart, if its token variables are already in the daemon's environment. One with missing tokens is skipped, with the key to fix named in the alert and the log.
- `hydra slack manifest [<app>]` prints the Slack app to create: Messages tab on and writable, every scope and event the connector uses. Each app's bot must be in the channels it hears, and nothing else should hold a Socket Mode connection on it.

## Apps and routing

Each app is its own connection, with its own bot, reconnects and catch-up. A message leaves through the app that heard it. `hydra route --app <app:id>` shows how an app changes the answer.

- **Rules** name a `place`, an `app`, or both; the first match in file order wins. `target` is `main` or `specialist:<name>`.
- **Pinning:** `pinned_to = ["app:sales"]` on a specialist makes it answer only through those apps, and makes those apps deliver only to specialists pinned to them. `main` is exempt.
- **One owning app answers each message** when several apps share a channel: the app the message tags (first tag wins, even over the bound app), else the app the conversation is bound through, else the place's `default_app`, else the app named `default`, else the first app that delivers there. The others do nothing.
- Hydra reads which bots are in a channel with `conversations.info` (a member is believed for 10 minutes, a non-member for 30 seconds). Adding a second app means adding the `member_joined_channel` and `member_left_channel` events to every existing app and reinstalling each ([Adding an app](slack.md#adding-an-app)).
- Another app's bot message is passed over unless the place has `bots = true` or the thread is bound to a session. Hydra's own apps are never heard.

## Which app listens

The operator's harness uses the operator's app: a bot plus `operator_token_env`, so a thread in a channel the bot isn't in is still read, as the operator, and routed to the operator's own sessions. Agents for other people use an app of their own, whose bot sits in the channels the agent serves. Give an agent its own app when it must keep working without the operator (an operator token hears only the channels the operator is in), when people tag it by its own name, or when it lives in a private channel the operator isn't in.

Hearing and speaking are separate. The operator token reads and edits or deletes the operator's own messages; it never posts. Replies, reactions and new threads go out through a bot, only where that bot is a member, and the bot never joins a channel by itself. Where it is not a member, the answer goes to the operator's DM with the app, with a link to the thread.

### The app's router

A tag of an app in a channel thread goes to one place, by the first of these that applies:

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

`router = "main"` sends the tag to `main`, which hears only the operator. `router = "specialist:<name>"` sends it to that specialist, the **router**, which hears whoever its own `reachable_by` lets in. With no `router` the tag is unrouted and logged. The router never sees a thread bound to a session, nor a message a rule matched, nor a DM. Its first tag binds the thread to it, so later messages go to it, tagged or not, until it binds the thread to another session. The app reacts 👀 on the tag at once. A router cannot be restricted or write-confined: it binds conversations to other sessions and spawns them, so it is an operator-account session; set `reachable_by` to the people you would let route a thread. Setting one up: [the router guide](slack-router.md).

**A session listens to a thread.** Any session except a protocol guest can call `bind_conversation(<conversation>)` (a Slack app must be declared in hydra.toml) to bind a Slack thread to itself and `unbind_conversation` to let it go; the bind is refused if neither the bot nor the operator can read the thread. Each message then arrives with `tagged=true|false` and `from=operator|approved|other`, and a plain session may `reply` into it through the app's bot. A restricted or write-confined session only listens.

**Binding to another session.** `bind_conversation` takes `target` (main and the router only), a session by name (`list_sessions`) or `thread:<id>`, and `why`, one line; `hydra conversations bind <conversation> thread:<id> --why "<reason>"` does the same. Nothing is posted in the Slack thread, because its audience is outside hydra. The notice `→ <session> <link>: <why>` goes to the bound session's own thread, which then listens and answers in Slack itself when it judges so. A tag in a thread bound to a session stays with that session.

**Finding the session** is the router's own behaviour, written in its kickoff ([`router-kickoff.example.md`](router-kickoff.example.md) is one to copy). It looks in tiers and stops at the first that fits:

| Tier | Where it looks | How it takes the thread |
|---|---|---|
| 1 | A **live** session that fits (`list_sessions`) | Asks it, with `send_to_thread(type="question")`, whether the thread is its to handle; on a confident yes, binds it. A no or no answer in about two minutes: the next candidate, never asking a decliner twice |
| 2 | An **ended** session whose thread fits (`list_sessions` with `include_ended`) | Revives it (`hydra deliver --to thread:<id> --revive`), then binds the thread to it |
| 3 | A **declared specialist** that fits (`hydra specialist list`) | Starts it (`hydra deliver --to specialist:<name>`), then binds the thread to it |
| 4 | **Nothing fits** | Spawns a new session for the thread and binds it |
| 5 | **Last resort** | Asks the operator |

**The event stream.** The daemon appends one JSON line per event to `<state dir>/events/YYYY-MM-DD.jsonl`: ids, names and a bind's `why`, never message text. Three kinds: `route` (a message was delivered or stopped, and which step chose), `bind` (a binding set or changed, with its `why`) and `unbind` (a conversation let go, with a reason). It is the router's memory and the tuning surface: a correction is another bind of the same conversation, and `hydra events --kind bind` shows both. Day files older than `[events] keep_days` (default 30) are deleted.

```sh
hydra events --kind bind --since 14d --limit 40       # the newest 40 binds in 14 days
hydra events --by hydra --since 7d                    # what hydra moved or let go by itself, with why
hydra events --conversation slack:C0ABC:1793732224.093059 --json
```

## DMs and group DMs the operator's app hears

With `operator_token_env`, the operator's app also hears the operator's DMs and group DMs (user scopes `im:history`, `mpim:history` and `im:read`; `hydra slack manifest` adds them, and a reinstall applies them). **Hearing is not delivering:** a place no rule, `[places]` entry or open conversation names is dropped first. Place names:

| Where it happened | Place |
|---|---|
| A DM with one app's bot, from anyone | `slack:app-dm:<app>` (`*` for every app's; `default` for a single-app setup) |
| The operator's DM with one person | `slack:person-dm:<person>` (`*` for every person; a `[people]` id with a Slack address) |
| One group DM | `slack:group-dm:<G id>` (`*` for every group DM) |

```toml
[[rules]]
place = "slack:person-dm:alice"   # the operator's DM with alice
target = "specialist:deals"
```

A DM with someone not in `[people]` goes by no name and is dropped. A refused DM with the bot gets 🚫; a DM with a person or a group DM that nothing routes is logged and counted, never reacted to. DMs with people and group DMs are heard live only: catch-up does not rescan them. `[places]` settings resolve the specific place before `*`. Only `ack` and `files` apply to person-DM and group-DM places.

## Conversations and replies, per app

A conversation is an app, a channel and a thread, so one thread heard through two apps is two conversations. Its id, as `hydra conversations`, `reply`, `bind_conversation` and the guard's stdin write it:

| App | Conversation id | Example |
|---|---|---|
| `default` | `slack:<channel id>[:<thread ts>]` | `slack:C0ABC:1793732224.093059` |
| any other | `slack:<app>:<channel id>[:<thread ts>]` | `slack:sales:C0ABC:1793732224.093059` |

A DM, or a top-level message where `messages = "all"`, has no thread ts. Copy the id from the delivery you are answering.

Replies leave through the app that heard the message. A post that answers no message (a specialist's `home_place`, a new thread) uses the specialist's `speaks_as`, an app it is pinned to; with several apps and none named `default`, a specialist with a Slack `home_place` must set it.

### Slack lines in a session's thread

A session bound to a Slack conversation shows its Slack traffic in its own chat thread as one quiet line, never posted into Slack: `📨 from <emoji> [sam](<permalink>) → <summary>` when someone in `[people]` tags the app, and `📤 to <emoji> [thread](<permalink>) → <summary>` when the session replies. `[slack] line_emoji` sets the emoji (default 💬).

### Editing and deleting Slack messages

`edit_message` and `delete_message` take a conversation id as `chat_id` and the message's ts as `message_id`. A bot's message is rewritten with that app's bot token; the operator's own message with the operator token (it needs the user scope `chat:write`). A restricted specialist may touch only its own app's bot messages, in a conversation bound to it. An edit is one message (at most 3,900 characters) with no files. `fetch_messages` reads a conversation through the app its id names, oldest first, `limit` 1 to 100; a restricted session reads only a conversation bound to it.

## Health and alerts, per app

`hydra health` prints one line per app, kept on its own, so one app's trouble neither raises, hides, nor repeats another's:

```
slack connector: 2 apps · 14 conversations · 0 owed
  default: up · last event 1 min ago · catch-up ok 3 min ago · scopes ok
  sales: down 12 min · last event 14 min ago · catch-up failing (…) 40 min ago · missing chat:write (replies)
```

`hydra health --json` has `slack.apps.<id>`: `state` (`off`, `connecting`, `up`, `down`, `exhausted`), the last event and catch-up, `missingScopes`, `tokens`, `connection`. `owedLate` lists each conversation whose oldest owed message is older than 20 minutes, with the cause. A missing scope is shown in health and alerted once per episode, naming the app, the scope and the fix (`hydra slack manifest <app>`, reinstall, restart). An alert about one app goes to the specialists that app serves, and to `main` when none does.

| You see | Do this |
|---|---|
| `off`, a key named | The token variable is empty: put it in `.env` and restart. |
| `down` or `exhausted` | Check both tokens and the app's Socket Mode setting. Hydra retries (10 s doubling to 5 min) until it connects. |
| `missing <scope>` | `hydra slack manifest <app>`, add it, reinstall, restart. |
| `catch-up failing (…)` | A budget or rate limit resumes from the held cursor on the next pass; a permanent error says what to do. |
| `live events probably off` | Slack switched the app's events off after too many failed deliveries: turn **Enable Events** back on in its Event Subscriptions. |
| `up` and `catchUp.accepted > 0` pass after pass | A second connection holds the app and Slack splits events: stop the other process. |
| `owed … oldest N min` | The line names the cause; with none, wait for the next pass. |

## Known limits

- A restricted session already running when last checked is not checked again while it runs (#617); only a new start is.
- Slack edits are not covered by `link_previews` (`chat.update` takes no unfurl argument).
- Where two apps share a channel and who is in it is not yet known, each may answer, so both may answer until the membership read lands.
- A tag of a declared app that is down and not in the channel is answered by no one until it is back.
