---
name: configure
description: Set up the Discord channel — save the bot token and review who it hears. Use when the user pastes a Discord bot token, asks to configure Discord, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /discord:configure — Discord Channel Setup

Writes the bot token to `~/.claude/channels/discord/.env` and orients the
user on who the bot hears (hydra.toml). The server reads both files at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Token** — check `~/.claude/channels/discord/.env` for
   `DISCORD_BOT_TOKEN`. Show set/not-set; if set, show first 6 chars masked.

2. **Access** — read `~/.claude/channels/discord/hydra.toml` (missing = no
   operator). Show:
   - Operator: the person and their `discord:` address, or "none: every DM is dropped"
   - People on the roster: count
   - Admitted channels: count, with each channel id and whether it needs a tag
   - Whether `off = true` is set under `[gateways.discord]`

3. **What next** — pick by the state, in plain words:
   - No token → *"Run `/discord:configure <token>` with the token from the
     Developer Portal → Bot → Reset Token."*
   - Token set, no operator → *"Name yourself the operator. Find your user id
     (Settings → Advanced → Developer Mode, right-click yourself → Copy User ID),
     then with the daemon stopped run `hydra migrate discord --operator <id>`
     and `hydra up discord`."* There is no pairing: strangers' DMs are dropped.
   - Operator set, no channels → *"Tag the bot in a channel to let it in: it adds
     the channel to hydra.toml and runs your message."*
   - An `access.json` still in the folder → *"Run `hydra down discord`,
     `hydra migrate discord`, `hydra up discord`: the daemon won't start until it
     is moved into hydra.toml."*
   - Everything set → say so; `/hydra:access` changes who is let in.

Don't dwell on access: the point of this skill is the token.

---

### `<token>` — save it

1. Treat `$ARGUMENTS` as the token (trim whitespace). Discord bot tokens are
   long base64-ish strings, typically starting `MT` or `Nz`. Generated from
   Developer Portal → Bot → Reset Token; only shown once.
2. `mkdir -p ~/.claude/channels/discord`
3. Read existing `.env` if present; update/add the `DISCORD_BOT_TOKEN=` line,
   preserve other keys. Write back, no quotes around the value.
4. `chmod 600 ~/.claude/channels/discord/.env` — the token is a credential.
5. Confirm, then show the no-args status so the user sees where they stand.

### `clear` — remove the token

Delete the `DISCORD_BOT_TOKEN=` line (or the file if that's the only line).

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. Token changes need a session restart
  or `/reload-plugins`. Say so after saving.
- `hydra.toml` is re-read within a second of a change: access changes via
  `/hydra:access` take effect without a restart.
