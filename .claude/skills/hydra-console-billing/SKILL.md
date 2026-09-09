---
name: hydra-console-billing
description: Move the hydra fleet (byte + spawned sessions) between Claude subscription billing and Anthropic Console API-usage billing. Use when sessions report "You've hit your individual spend limit", "org_spend_cap_reached", or a weekly/session limit that will not self-reset, and when auditing which config dir a live session is running under.
---

# Hydra: subscription ↔ Console billing

## When this applies

Panes show, and the daemon log echoes:

```
You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit
```

That is an **admin-set org spend cap** (`overageDisabledReason: "org_spend_cap_reached"`), not the
5-hour rolling window. It does not self-reset on a useful timescale. Switching the fleet's config
dir to a Console account moves the spend to API usage billing and unblocks immediately.

## The one fact that makes this safe

Every hydra session runs under a **separate config dir**, pinned in
`~/.claude/channels/<platform>/.env`:

```
CLAUDE_CONFIG_DIR=/Users/kevin/.claude-byte
```

Logging that dir in to Console flips the whole fleet and leaves personal `~/.claude` (your terminal
Claude Code) on subscription billing. Never run the login against `~/.claude` unless you mean to
change your own billing too.

## Preflight — smoke test, not metadata

**Do not trust `.claude.json`.** Its `oauthAccount.billingType` can read `stripe_subscription` on a
dir that is demonstrably serving Console traffic. Verified 2026-09-09: personal `~/.claude` reported
`stripe_subscription` while answering requests fine, and `.claude-byte` reported the identical value
while hard-failing. The field does not distinguish the two.

The only reliable check is a live call against each dir:

```sh
claude -p "Reply with exactly: ok" --model 'claude-opus-5[1m]' 2>&1 | tail -4
CLAUDE_CONFIG_DIR=/Users/kevin/.claude-byte claude -p "Reply with exactly: ok" --model 'claude-opus-5[1m]' 2>&1 | tail -4
```

`ok` means that dir is unblocked. The spend-limit sentence means it is not. Run both — they fail
independently, and the fleet only cares about the second.

Keychain freshness tells you *where a recent login landed*, which is the usual surprise:

```sh
for s in "Claude Code-credentials" "Claude Code-credentials-a21d4e95"; do
  printf '%-42s ' "$s"; security find-generic-password -s "$s" 2>&1 | grep -E 'cdat|mdat' | tr -d '\n'; echo
done
```

Bare `Claude Code-credentials` is `~/.claude`; the `-a21d4e95` suffix is `.claude-byte`. Timestamps
are UTC.

## Step 1 — flip the credential (interactive, human-only)

Needs a real TTY and a browser. An agent cannot do this step; ask the user to run it, or run it in
the session with a leading `!`.

```sh
CLAUDE_CONFIG_DIR=/Users/kevin/.claude-byte claude
```

**The env prefix is the whole point.** Running `claude` and `/login` from an ordinary terminal, or
from inside a hydra session, authenticates `~/.claude` and leaves the fleet exactly as capped as it
was. Confirmed 2026-09-09: a Console login done this way unblocked `~/.claude` while `.claude-byte`
kept returning the spend-limit error.

Inside that REPL: `/login` → **`2. Anthropic Console account · API usage billing`** → on newer
builds pick **`Sign in with your Console account (recommended)`**, *not* `Create an API key
(legacy)`. Finish the browser OAuth, wait for `Login successful`, then `/exit`.

There is no API key to create or store. The org auto-provisions `claude_code_key_<user>_<suffix>`
through the login flow. Do not build an `apiKeyHelper` — that path was tried and abandoned.

## Step 2 — verify it landed in the right dir

Re-run the preflight smoke test. `.claude-byte` must now answer `ok`:

```sh
CLAUDE_CONFIG_DIR=/Users/kevin/.claude-byte claude -p "Reply with exactly: ok" --model 'claude-opus-5[1m]' 2>&1 | tail -5
```

If it still reports the spend limit, the login went to the wrong dir. Check which keychain entry was
just created — a fresh bare `Claude Code-credentials` with a `cdat` from minutes ago means the login
landed on personal `~/.claude`, and you need to redo Step 1 **with the env prefix**.

The credential lives in the macOS keychain under `Claude Code-credentials-a21d4e95` for
`.claude-byte`. Reading its body is blocked by the auto-mode classifier and you do not need it.

## Step 3 — restart the daemon with the config dir PINNED

```sh
cd ~/RubymineProjects/hydra && CLAUDE_CONFIG_DIR=/Users/kevin/.claude-byte bun cli/hydra.ts restart slack 2>&1 | tail -15
```

The prefix is harmless on current `main` and **mandatory** on older checkouts — see trap 2.

## Step 4 — audit which dir each live session is on

```sh
for s in $(tmux ls -F '#{session_name}'); do
  pid=$(tmux list-panes -t "$s" -F '#{pane_pid}' 2>/dev/null | head -1); [ -z "$pid" ] && continue
  cpid=$(pgrep -P "$pid" 2>/dev/null | head -1); [ -z "$cpid" ] && continue
  dir=$(ps eww "$cpid" 2>/dev/null | tr ' ' '\n' | grep '^CLAUDE_CONFIG_DIR=' | head -1 | cut -d= -f2)
  echo "$s -> ${dir:-unknown}"
done
```

## Step 5 — migrate each stuck session

Pick a lane per session.

**Lane A — kill + resume (preferred; full context).**

```sh
cd ~/RubymineProjects/hydra && bun cli/hydra.ts kill <name>
```

Then type `resume` in that session's chat thread. `resume` is chat-only; there is no CLI
equivalent. The daemon relaunches tier-1 `claude --resume <claudeSessionId>` and the conversation
survives intact.

If the session was stranded on `~/.claude`, copy its transcript across **before** the kill:

```sh
mkdir -p ~/.claude-byte/projects/-Users-kevin-RubymineProjects
cp ~/.claude/projects/-Users-kevin-RubymineProjects/<claudeSessionId>.jsonl \
   ~/.claude-byte/projects/-Users-kevin-RubymineProjects/
```

Get the id from the registry:

```sh
node --input-type=module -e '
import {readFileSync} from "node:fs"
const raw = JSON.parse(readFileSync(process.env.HOME + "/.claude/channels/slack/sessions.json", "utf8"))
const list = Array.isArray(raw) ? raw : Object.values(raw.sessions ?? raw)
for (const s of list.flat()) if (s?.tmuxName && !s.deadAt) console.log(s.tmuxName, s.claudeSessionId, s.sessionMetadata?.model)
'
```

**Lane B — in-pane `/login` (for sessions you must not kill).**

Fully scriptable; no need to attach. The whole flow is four keystroke batches:

```sh
S=<name>
tmux send-keys -t $S '/login'; sleep 2; tmux send-keys -t $S Enter; sleep 6   # menu
tmux send-keys -t $S Down;     sleep 1; tmux send-keys -t $S Enter; sleep 6   # 2. Console account
tmux send-keys -t $S Enter;            sleep 12                               # Sign in with Console
tmux send-keys -t $S Enter                                                    # dismiss "Login successful"
```

Capture the pane between batches (`tmux capture-pane -p -t $S | tail -8`) and confirm each screen
before sending the next key. The menus differ if the session is mid-dialog. Then verify:

```sh
tmux send-keys -t $S 'Respond with exactly: probe-ok'; sleep 2; tmux send-keys -t $S Enter
```

Only safe for a session already on `.claude-byte`. Costs one browser authorization prompt.

Use Lane B when the session holds a git worktree with unpushed commits, or is mid-flight in a
review gate.

## Step 6 — restart the byte

```sh
cd ~/RubymineProjects/hydra && CLAUDE_CONFIG_DIR=/Users/kevin/.claude-byte bun cli/hydra.ts down slack 2>&1 | tail -6
cd ~/RubymineProjects/hydra && CLAUDE_CONFIG_DIR=/Users/kevin/.claude-byte bun cli/hydra.ts up slack 2>&1 | tail -8
```

A fresh config dir triggers a first-run trust dialog in the byte pane. Clear it:

```sh
tmux send-keys -t slack-byte Down Enter
```

Confirm: `grep -E 'main bridge|bridge registered' ~/hydra-slack-daemon.log | tail -3`

## Verification that actually proves it

Metadata alone is not proof. Open a migrated session's transcript and confirm the spend-limit error
appears before the switch and normal completed turns appear after.

## Traps

0. **Budget one browser prompt per live session you migrate in place.** A restarted process reads
   the keychain and needs no login at all — that is why the byte restart is silent. A *running*
   process holds its OAuth pair in memory, so the only in-place fix is `/login`, and each one is its
   own authorization round-trip. Three live sessions means three prompts. There is no way to
   broadcast one login across them. Choose per session: restart costs context (or a `resume`), and
   in-place login costs a prompt. Verified 2026-09-09 on ember, pixel and patch.

1. **A healthy running session never re-reads the keychain.** It refreshes from its in-memory token
   pair; the store is only re-read after a refresh *fails*. Prompting the session does nothing. A
   restart or in-pane `/login` is the only way to flip it. Worse, a still-subscription session can
   write its refreshed credential back over the Console one, so roll every session promptly rather
   than leaving a mixed fleet overnight.

2. **Older checkouts silently launch the daemon under the wrong config dir.** `resolveConfig` used
   to read `CLAUDE_CONFIG_DIR` *before* sourcing the state-dir `.env` and return the stale value, so
   `hydra up` / `hydra restart` from a clean shell handed the daemon and byte `~/.claude`. Symptom:
   kill+resume and kill+respawn both appear to "fail", because the daemon is minting sessions under
   the wrong dir. Fixed on `main`; the env prefix in the steps above is belt-and-braces and is still
   required on any branch predating that fix. Verify what the daemon actually got rather than
   trusting either:

   ```sh
   dpid=$(tmux list-panes -t slack-daemon -F '#{pane_pid}' | head -1)
   for cp in $(pgrep -P $dpid) $dpid; do ps eww -p $cp -o command= | tr ' ' '\n' | grep -E '^(CLAUDE_CONFIG_DIR|HYDRA_MODEL)='; done | sort -u
   ```

3. **`hydra kill` destroys worktrees** and checks the *registered* branch, not the worktree's actual
   branch. A session whose registry says `wt/<name>` may really be on a feature branch with
   unpushed commits. Check before every migration kill:
   `git -C <worktreePath> status -sb && git -C <worktreePath> log --oneline @{u}..`

4. **Kill with `hydra kill <name>`, never `tmux kill-session`.** Only `killSession` records
   `claudeSessionId` into the thread registry. Skip it and `resume` degrades to a tier-3 respawn
   with thread history only and no conversation context.

5. **Resume keeps the dead session's model**, not the current `HYDRA_MODEL`. To change model, use
   `/model <id>` in the pane or spawn fresh.

6. **Queued-message misrouting.** After a kill+resume in the same DM channel, a previously-killed
   session's queued bootstrap prompt can be re-delivered into the resumed session, and can rename
   the thread. Harmless, but do not mistake it for a bug in your migration.

7. **`hydra spawn` requires both** `--idempotency-key` and `--initiator`. It reports them one at a
   time.

## Rolling back to subscription

Same flow, choosing option 1 (`Claude account with subscription`) at the `/login` menu, then
steps 3 through 6.

## Companion lever: burn rate

Once the fleet is on usage-based billing, model choice is a direct dollar cost rather than a cap.
Fable bills at exactly twice Opus per token:

| Model | Input $/1M | Output $/1M |
|---|---|---|
| `claude-fable-5` / `claude-fable-5-1` | 10.00 | 50.00 |
| `claude-opus-5` / `claude-opus-4-8` / `claude-opus-4-6` | 5.00 | 25.00 |
| `claude-sonnet-5` | 2.00 | 10.00 |

Two places pin the default, and both matter:

- `~/.claude/channels/slack/.env` → `HYDRA_MODEL` — the `--model` flag on every new spawn.
- `~/.claude-byte/settings.json` → `model` — the fallback for anything launched without `--model`,
  including **subagents spawned inside sessions**, which is often the larger share of spend.

Neither takes effect until the daemon restarts, and neither retroactively changes a live session.
`resume` re-launches with the *dead session's* model. To move a running session, either send
`/model claude-opus-5[1m]` into its pane or respawn it.

## Asking migrated sessions to report in

After a session comes back live, have it confirm in its own thread rather than trusting the pane:

```sh
tmux send-keys -t <name> 'Post a short status update in this thread: confirm you are back online, state which task you were mid-way through, and flag anything you lost.' Enter
```

Do this per session once its bridge is connected. A reply landing in the thread proves three things
at once — the model is answering (so billing is unblocked), the bridge is routing, and the
conversation context survived the migration.
