# Hydra Onboarding Tips (agent-facing)

> **Last verified:** 2026-07-04 · Claude Code 2.1.201 · macOS 14 (darwin 24.3) · Discord
> **Audience:** a Claude Code agent bringing up a byte on a *non-primary* machine.
> Read before `hydra install`. Each step names the gotcha that cost real debugging time.

## Prereqs
`bun`, `tmux`, `claude` on PATH → `brew install bun tmux`.

## Ordered bring-up

1. **Deps + bridge plugin** — `bun install`; `claude plugin install discord@claude-plugins-official`.
   - *Gotcha:* if `$CLAUDE_CONFIG_DIR/settings.json` is a **dangling symlink**, the install fails with an ENOENT on a `.tmp` file. Resolve the symlink target first.

2. **State dir** — create `~/.claude/channels/<platform>/.env` (token, `CHAT_PLATFORM`, `SPAWN_CWD`, `DEFAULT_SESSION_CHANNEL`).
   - `SPAWN_CWD` **must be an existing directory** — a missing cwd fails every spawn silently.

3. **Onboarding flags** — seed `$CLAUDE_CONFIG_DIR/.claude.json` with `hasCompletedOnboarding` + `bypassPermissionsModeAccepted`. `hydra preflight` checks both.

4. **Auth** — set `CLAUDE_CODE_OAUTH_TOKEN` or log in once via `tmux attach`. For detached environments that can't read the keychain, set `HYDRA_AUTH=keychain`.

5. **Install, operator, up** — in this order: `hydra install <platform> --cwd <existing-dir>`; `hydra migrate <platform> --operator <your user id>` (required for commands, not just replies: an install with no operator drops every DM); `hydra preflight <platform>`; `hydra up <platform>`.

6. **Verify inbound end-to-end** — do not trust "connected":
   - `grep -E "main bridge connected|running tmux new-session" ~/hydra-<platform>-daemon.log`
   - Send a real message; a spawned session should appear in `hydra list` and greet its thread.
   - *Known failure* (Claude Code ≥ 2.1.199, inline plugins): bridge logs `Channel notifications skipped … inline` → byte replies but **never receives**. Run the plugin marketplace-installed + enabled and omit `--plugin-dir`.

See [reference.md Troubleshooting](reference.md#troubleshooting) for symptom→cause diagnosis.

## One-token-per-daemon
One Discord Application = one bot = one token = one gateway connection. Concurrent machines (laptop / work / VPS) each need their **own** Application + token. Same name/icon is fine; the Application ID and token cannot be shared.
