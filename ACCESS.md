# Access control

Who the bot hears, and where. Everything lives in `hydra.toml`, in the state dir (`~/.claude/channels/<platform>/`). hydra re-reads it within a second of a change, and keeps the last good copy if a change doesn't load. `hydra config check <platform>` loads it the way the daemon does and prints what is wrong.

There is no `access.json` and no pairing. An old install runs `hydra migrate <platform>` once; a new one runs `hydra migrate <platform> --operator <your user id>`.

## The operator

```toml
operator = "operator"

[people.operator]
addresses = ["discord:184695080709324800"]   # one address per platform, as <platform>:<user id>
```

The operator is the one person whose DMs reach `main`, who runs commands (`spawn:`, `kill:`, `/sessions`, `/health`) and who may admit channels. Anyone else's DM is dropped, with no reply. Another person goes on the roster with `hydra people add <name> <platform>:<id>`; that lets specialists whose `reachable_by` names them hear them, and lets you name them in a channel's `allow`; it does not let them DM `main` or run commands.

## Channels

A channel is admitted when its access table exists. The key is the platform and the channel **id** (never a name):

```toml
[places."discord:846209781206941736".access]
mention = true          # a top-level message must tag the bot (default true)
allow = ["anyone"]      # required. People from [people], or ["anyone"] for everyone who tags
listen = true           # a session thread started here listens without a tag
```

`allow` is always written out, and an empty list does not load. `["anyone"]` is the only way to leave a channel open. People named in `allow` who have no address on this platform hear nobody.

To admit a channel, **tag the bot there as the operator**. It writes that table (`mention = true`, `allow` = the operator, `listen = true`) and runs the same message's command. If hydra.toml can't take the write, it says so once in that channel and does nothing else. Anyone else's tag admits nothing. To remove a channel, delete its `[places."…".access]` table; to change who may speak, edit `allow`.

`thread_reply = true` on the same place (`[places."discord:846209781206941736"]`) makes a session reply in a thread of the message. The connector's own place options (`ack`, `messages`, `files`, …) share that table; a place with only an access table is not "named" for the Slack connector.

Threads follow their parent channel: a thread inside an admitted channel uses its table. A reply to the bot or a `mention_patterns` match does not count as a tag when admitting.

## Whole-platform settings

```toml
[gateways.discord]      # or [gateways.slack]
ack_reaction = "👀"     # emoji added to every message a session picks up
listen = true           # default for session threads; a channel's listen overrides it
off = true              # drop every message that would reach a session, channels too (the old dmPolicy "disabled"); the operator's commands still run
mention_patterns = ["^hey claude\\b"]   # extra text that counts as a tag
```

On Discord, `[gateways.discord]` also takes `bot_token_env` (the variable holding the token). A table with only these settings leaves Discord's connector unchanged.

## Upgrading from access.json

An old install keeps working until its daemon next starts. On start the daemon refuses to boot while `access.json` still holds channels or settings, so migrate first. Per platform, on each machine:

1. `git pull --ff-only` in the hydra checkout.
2. `hydra migrate <platform> --dry-run`. It prints the `hydra.toml` it would write and changes nothing. Read the notes: they name anything left out.
3. `hydra down <platform>`, then `hydra migrate <platform>`, then `hydra up <platform>`.
4. Tag the bot in a channel it has not been in. It adds the channel to `hydra.toml` and answers.

`hydra migrate` keeps the old file as `access.json.migrated` (`access.json.2.migrated` if one exists). To roll back, `hydra down <platform>`, put that file back as `access.json`, and delete `hydra.toml`.

To have Claude Code do it: open it in the hydra checkout and say "migrate hydra for <platform> per ACCESS.md, dry run first". Paste the refusal message if you have one. Keep the `--dry-run` step: read what it prints before the real run.

If a daemon refuses to start, `hydra up` and `hydra restart` print why and change nothing. A daemon started another way writes `boot-refused.json` in the state dir, which `hydra health` shows. The watchdog also tells the operator once in a direct message.

## What went away

| Old | Now |
|---|---|
| `dmPolicy` `pairing` / `allowlist` | strangers' DMs are always dropped; people come in through `hydra people add` |
| `dmPolicy` `disabled` | `[gateways.<platform>] off = true` |
| `allowFrom`, `groups` | The first `allowFrom` id becomes the operator; the others become `[people]` entries that no longer reach `main` or run commands. Each group becomes a `[places."…".access]` table; `migrate` stops if a group's `allowFrom` names someone not yet in `[people]` (add them with `hydra people add`, then run it again). |
| `replyToMode`, `textChunkLimit`, `chunkMode`, `threadArchiveMinutes` | fixed: markdown chunks of the platform's maximum, the first chunk answers the message, threads archive after a day. `hydra migrate` stops if an old file sets one. |
| `DISCORD_ACCESS_MODE=static` | none |
