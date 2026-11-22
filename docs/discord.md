# Discord Setup

## 1. Create a Discord application and bot

Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**. Give it a name.

Navigate to **Bot** in the sidebar. Give your bot a username.

Scroll to **Privileged Gateway Intents** and enable **Message Content Intent** — without this the bot receives messages with empty content.

## 2. Generate a bot token

On the **Bot** page, scroll to **Token** → **Reset Token**. Copy it — shown once only.

## 3. Invite the bot to a server

Discord requires a shared server for DMs. Navigate to **OAuth2** → **URL Generator**:
- Scope: `bot`
- Bot Permissions: View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, Add Reactions
- Integration type: **Guild Install**

Copy the generated URL, open it, add the bot to your server.

## 4. Install the bridge plugin

The Claude sessions reach the daemon through a plugin. Install it into the config dir the daemon will use (default `~/.claude`):

```bash
bun install
claude plugin install discord@claude-plugins-official
```

## 5. Configure

Write the token and working directory to `~/.claude/channels/discord/.env`:

```bash
mkdir -p ~/.claude/channels/discord
cat > ~/.claude/channels/discord/.env << 'EOF'
CHAT_PLATFORM=discord
DISCORD_BOT_TOKEN=MTIz...
SPAWN_CWD=~/your/project      # must be an existing directory
EOF
```

Then run `claude` once in a terminal. Accept the onboarding screens and log in, or a detached bot hangs on them. `hydra preflight` warns if this is missing.

## 6. Start

```bash
bun cli/hydra.ts install discord --cwd ~/your/project   # launchd watchdog, `hydra` CLI, preflight
hydra up discord                                          # daemon + bot
```

Fix every ✗ that preflight reports before `hydra up`. See [ONBOARDING_TIPS.md](ONBOARDING_TIPS.md) for the gotcha behind each step.

## 7. Name yourself the operator

Find your Discord user id (Settings → Advanced → Developer Mode, then right-click yourself → Copy User ID). With the daemon stopped, run:

```
hydra migrate discord --operator <your user id>
```

That writes `hydra.toml` with you as `operator`. The bot only accepts commands from the operator, and drops DMs from anyone else (there is no pairing). Then start it with `hydra up discord`.

To let the bot into a channel, tag it there as the operator: it adds the channel to `hydra.toml` and runs your message. Add another person with `hydra people add <name> discord:<id>`.

## Discord-specific behavior

- **Threads:** Bot creates threads on messages when `threadReply: true` is set in the channel policy. Replies go to the thread, keeping the main channel clean.
- **Typing indicator:** Automatic while Claude is processing.
- **Gateway singleton:** Discord enforces one WebSocket per bot token. The daemon architecture prevents race conditions from multiple sessions.
- **DM spawning:** Discord DMs don't support threads, so `spawn:` from a DM creates the session thread in `DEFAULT_SESSION_CHANNEL` instead.

## User IDs

Discord uses **snowflakes** (numeric IDs like `184695080709324800`). Enable Developer Mode in Discord settings, then right-click → Copy ID on any user or channel.
