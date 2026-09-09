---
name: hydra-console-billing
description: Move the hydra fleet (byte + spawned sessions) between Claude subscription billing and Anthropic Console API-usage billing. Use when sessions report "You've hit your individual spend limit", "org_spend_cap_reached", or a weekly/session limit that will not self-reset, when auditing which config dir and credential a live session is running under, or when choosing the fleet's default model to control usage-billing spend.
---

# Hydra: subscription ↔ Console billing

Written for the `slack` fleet. For any other platform, substitute it in **every** command below, not
just the first one — the platform name is baked into state paths, tmux session names and the log file.

## When this applies

Panes show, and the daemon log echoes:

```
You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit
```

That is an **admin-set org spend cap** (`overageDisabledReason: "org_spend_cap_reached"`), not the
5-hour rolling window. It does not self-reset on a useful timescale. Pointing the fleet's config dir
at a Console account moves the spend to API usage billing and unblocks immediately.

## Fast path

- **Step 0** — derive `$CFG`, the fleet's config dir. Never assume it. Sync the watchdog plist too,
  or the next watchdog restart reverts you.
- **Smoke test** — `.claude.json` metadata lies; a live call does not.
- **Step 1** — `/login` → Console, **with `CLAUDE_CONFIG_DIR` prefixed**. This is the actual change.
- **Step 2** — verify it landed on the fleet's identity. A wrong-identity login looks exactly like
  success until you restart the fleet on it.
- **Steps 3-6** — restart the daemon pinned, audit every session, migrate each stuck one, bounce
  daemon+byte.
- **Verify** — read a migrated session's transcript, and have it reply in its thread.
- **Trap 1** — log your own terminal into Console too. `$CFG` is now your personal dir, so an
  un-migrated terminal can write a subscription credential back over the Console one.

**The one non-negotiable: always pass the env prefix.** A bare `claude` login authenticates a
different identity and leaves the fleet exactly as capped as it was.

**The pane rule**, for every `tmux send-keys` in this document: capture first, and proceed only when
the capture shows the state this document names for that step — an idle empty prompt before sending
text, the named menu or dialog before sending a key. Never put text and `Enter` in one `send-keys`: a
live pane submits whatever is already in its input buffer the moment an `Enter` lands. Each fence ends
with its capture on purpose: run the fence, read the capture, then run the next one.

## Step 0 — find the fleet's config dir

Billing is a property of a Claude Code **config dir**, and the fleet's is whatever the state-dir
`.env` says. That value has changed twice; read it rather than trusting this document.

The parsing mirrors `shared/env-parse.ts` (`parseEnvLine`), which is what hydra itself uses: `export`
prefix, indentation, CRLF, quotes and trailing `# comments` are all legal and all stripped. On
duplicate keys hydra takes the first non-blank assignment *after* stripping — a rule no short pipeline
reproduces faithfully, so this refuses rather than guess.

```sh
STATE=$HOME/.claude/channels/slack
unset CFG
hits=$(grep -cE '^[[:space:]]*(export[[:space:]]+)?CLAUDE_CONFIG_DIR=' "$STATE/.env" 2>/dev/null || true)
hits=${hits:-0}
if [ "$hits" != 1 ]; then
  echo "BAD: $hits CLAUDE_CONFIG_DIR lines in $STATE/.env — wrong platform, or normalise it to one"
else
  line=$(grep -E '^[[:space:]]*(export[[:space:]]+)?CLAUDE_CONFIG_DIR=' "$STATE/.env" | tr -d '\r')
  line=$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  val=${line#*=}
  case $val in
    \"*) CFG=${val#\"}; CFG=${CFG%%\"*} ;;
    \'*) CFG=${val#\'}; CFG=${CFG%%\'*} ;;
    *)   CFG=$(printf '%s' "$val" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//') ;;
  esac
  [ -n "${CFG:-}" ] || { echo "BAD: CLAUDE_CONFIG_DIR is present but blank"; unset CFG; }
  case ${CFG-} in /*|'') ;; *) echo "BAD: not absolute: [$CFG]"; unset CFG ;; esac
  [ -z "${CFG-}" ] || [ -d "$CFG" ] || { echo "BAD: not a directory: [$CFG]"; unset CFG; }
  case ${CFG-} in */) echo "BAD: trailing slash — the hashed identity is path-exact, so this may pin
    a different identity than the unslashed path"; unset CFG ;; esac
fi
echo "[${CFG-<unset>}]"
```

Read the last line, not the warnings above it. Every failure path ends in `unset CFG`, so `[<unset>]`
means every `"${CFG:?}"` below refuses to run its command rather than silently resolving to the default
dir. (A `${VAR:?}` inside a pipeline kills only that element, not the shell — so the blocks below are
written so nothing downstream can manufacture a plausible value from the empty result.) The brackets
make a stray space or `\r` visible.

If you cannot normalise the `.env` right now, set `CFG=/absolute/path` by hand — expanded, no `~`, no
trailing slash — then re-run the four checks above (`[ -n ... ]` through `echo "[...]"`) against it.
Nothing below needs anything but a correct `$CFG`, and a hand-set one skips exactly the guards that
catch a path-exact identity mismatch.

**`$CFG` is a shell variable, not a file.** It does not survive a new terminal, and every tool call an
agent makes gets a fresh shell. Re-run this block at the top of any shell before using one below.

As of 2026-09-11 `$CFG` is `~/.claude`, which is also the dir your own terminal Claude Code uses. It
was `~/.claude-byte` before that, which kept the two apart. Two concrete costs of losing that:

- **`$CFG/settings.json` is now your own terminal's settings file**, so the model you set there to cap
  fleet subagent spend also changes your personal default.
- **`hydra down` deletes `$CFG/.credentials.json` and `hydra up` rewrites it from the *bare* keychain
  entry** when `HYDRA_AUTH=keychain` (`cli/lifecycle.ts`). Unset today. See Step 6.
- **An OAuth token outranks `$CFG` entirely.** If `CLAUDE_CODE_OAUTH_TOKEN` is set, or (on slack)
  `~/.angellist-claude-token` exists, `up` exports it into the byte's shell and the byte authenticates
  with that instead of anything in the config dir (`cli/lifecycle.ts`). Step 4 reads only
  `CLAUDE_CONFIG_DIR`, so it would still print `$CFG` and look correct. Neither exists today; if a
  migrated byte still reports the cap, check for them before re-reading the keychain.
  (`HYDRA_CLAUDE_TOKEN_FILE` is set in both the `.env` and the plist and its file exists, so it looks
  like a third such path — it is not: nothing in the repo reads that variable. Re-check that before
  trusting this bullet, because the day something does read it, a live token is already on disk.)

`~/.claude/channels/` is hydra's **state** dir and stays `~/.claude`-rooted wherever `$CFG` points
(`cli/helpers.ts`, `daemon/config.ts`). Do not rewrite those paths when the config dir moves.

**The plist and the `.env` must agree.** Different launchers with opposite precedence: `env-setup.sh`
sources the `.env` with `set -a`, so the file wins on the shell path, while the CLI lets the
environment win. Disagreement means the dir you get depends on which launcher restarted last.

```sh
P=~/Library/LaunchAgents/com.hydra.watchdog.plist
/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:CLAUDE_CONFIG_DIR" "${P:?set P above}"
```

If it differs from `$CFG`, treat the `.env` as source of truth. The absolute path and the file operand
are both load-bearing: a bare `PlistBuddy` is not on `PATH`, and `-c "Set …"` without a file prints
usage and writes nothing. Nothing below checks its exit status, so the reload runs either way and
"succeeds" against an unchanged plist — which is why the `Print` back is here:

```sh
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:CLAUDE_CONFIG_DIR ${CFG:?run Step 0 first}" "${P:?set P above}"
/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:CLAUDE_CONFIG_DIR" "$P"
```

`Set` only edits a key that already exists — on a plist that never had one it prints
`Set: Entry, ":EnvironmentVariables:CLAUDE_CONFIG_DIR", Does Not Exist`, changes nothing, and still
exits 0. If the `Print` above says `Does Not Exist` rather than a path, create the key instead:

```sh
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:CLAUDE_CONFIG_DIR string ${CFG:?run Step 0 first}" "${P:?set P above}"
/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:CLAUDE_CONFIG_DIR" "$P"
```

Only once that prints `$CFG` — reloading after a failed `Set` restarts the watchdog on the old dir,
which is the revert this section exists to prevent:

```sh
launchctl unload "${P:?set P above}" || true
launchctl load "$P"
v=$(launchctl print "gui/$(id -u)/com.hydra.watchdog" 2>/dev/null |
    awk '/^[[:space:]]*CLAUDE_CONFIG_DIR/ {print $NF; exit}')
[ "$v" = "${CFG:?run Step 0 first}" ] ||
  echo "WATCHDOG env is [$v], not [$CFG] — not loaded, loaded without the var, or still on the old dir"
```

**A third file can override both, and only the daemon reads it.** `daemon/config.ts` sources a
repo-local `<repo>/.env` *before* the state-dir one, and first-non-blank-wins gives it precedence for
the daemon while the CLI reads only the state `.env`. It does not exist today; if it appears, the
daemon and the CLI can resolve different dirs. The daemon's own fallback is also `~/.claude-personal`,
not `~/.claude` — a dir with no keychain entry at all.

```sh
ls -la ~/RubymineProjects/hydra/.env 2>&1 | tail -1   # expect: No such file or directory
```

## Smoke test — not metadata

**Do not trust `.claude.json`.** Its `oauthAccount.billingType` reads `stripe_subscription` on a dir
that is demonstrably serving Console traffic — verified 2026-09-09 on both dirs at once, one working
and one hard-failing with the identical value. The field does not distinguish them.

**Run the first line below before Step 1, not after.** Post-migration it is an unprefixed `claude`
against the fleet's own directory, which is the credential clobber trap 1 describes.

Pre-Step-1 only — the unset-env identity (your own terminal):

```sh
claude -p "Reply with exactly: ok" --model 'claude-opus-5[1m]' 2>&1 | tail -4
```

The fleet's pinned identity — this is the one that matters, and the only one to re-run later:

```sh
CLAUDE_CONFIG_DIR="${CFG:?run Step 0 first}" claude -p "Reply with exactly: ok" --model 'claude-opus-5[1m]' 2>&1 | tail -4
```

`ok` means that *identity* is unblocked. Since the move, both lines name the same directory — but not
necessarily the same credential. Run both.

Step 2 re-runs the prefixed line; never re-run the first.

## Step 1 — flip the credential (interactive, human-only)

Needs a real TTY and a browser. An agent cannot do this step; ask the user to run it, or run it in the
session with a leading `!`. Step 0 must have run in **this** shell:

```sh
CLAUDE_CONFIG_DIR="${CFG:?run Step 0 first}" claude
```

**The env prefix is the whole point.** A bare `claude` + `/login`, from an ordinary terminal or from
inside a hydra session, authenticates the unset-env identity and may well leave the fleet as capped as
it was. Confirmed 2026-09-09, when the fleet dir was still `~/.claude-byte`: a Console login done that
way unblocked `~/.claude` while the fleet dir kept returning the spend-limit error.

Inside that REPL: `/login` → **`2. Anthropic Console account · API usage billing`** → on newer builds
pick **`Sign in with your Console account (recommended)`**, *not* `Create an API key (legacy)`. Finish
the browser OAuth, wait for `Login successful`, then `/exit`.

There is no API key to create or store. The org auto-provisions `claude_code_key_<user>_<suffix>`
through the login flow. Do not build an `apiKeyHelper` — that path was tried and abandoned.

## Step 2 — verify it landed in the right identity

```sh
CLAUDE_CONFIG_DIR="${CFG:?run Step 0 first}" claude -p "Reply with exactly: ok" --model 'claude-opus-5[1m]' 2>&1 | tail -4
```

If it still reports the spend limit, the login went to the wrong identity. Run the keychain loop in the
appendix: a bare `Claude Code-credentials` whose `mdat` is minutes old means the prefix was dropped.
The entry that must move is `Claude Code-credentials-<hash of $CFG>`. The remedy is to redo Step 1 in a
shell where Step 0 has set `$CFG` — not to re-run anything below.

## Step 3 — restart the daemon with the config dir PINNED

```sh
cd ~/RubymineProjects/hydra && CLAUDE_CONFIG_DIR="${CFG:?run Step 0 first}" bun cli/hydra.ts restart slack 2>&1 | tail -15
```

`restart` touches the daemon only — it never references the byte, which is why Step 6 exists. The
prefix is harmless on current `main` and **mandatory** on older checkouts — see trap 2.

## Step 4 — audit which identity each live session is on

Identify the `claude` process by name and read *its* environment. Two traps make the obvious loop lie:
the `claude` process is the pane pid for `slack-byte` but a child for spawned sessions, so
`pgrep -P | head -1` lands on `caffeinate` and reports `unknown` for the byte; and a spawned session's
pane is a shell whose **command line** carries a quoted `CLAUDE_CONFIG_DIR='…'` from the tmux spawn, so
grepping the pane pid returns a quoted value that never compares equal to `$CFG`.

```sh
for s in $(tmux ls -F '#{session_name}'); do
  pid=$(tmux list-panes -t "$s" -F '#{pane_pid}' 2>/dev/null | head -1); [ -z "$pid" ] && continue
  cproc=
  for c in "$pid" $(pgrep -P "$pid" 2>/dev/null); do
    [ "$(ps -p "$c" -o comm= 2>/dev/null | sed 's|.*/||')" = claude ] && { cproc=$c; break; }
  done
  [ -z "$cproc" ] && { echo "$s -> no-claude-process"; continue; }
  dir=$(ps eww -p "$cproc" 2>/dev/null | tr ' ' '\n' | grep '^CLAUDE_CONFIG_DIR=' | head -1 | cut -d= -f2-)
  echo "$s -> ${dir:-unknown}"
done
```

`no-claude-process` is expected for `slack-daemon` and `hydra-transcribe`; on a session name it means
the pane died, and a dead pane needs no migration — it reads the keychain fresh when it restarts
(trap 0). The other three values decide the rest of the procedure:

| Step 4 printed (before) | Copy fence will | Lane A | Lane B | Reply proves billing — re-read Step 4 first |
|---|---|---|---|---|
| `$CFG` | skip | yes | yes | yes |
| `unknown` | skip today; copy if `$CFG` ever moves | yes | **no** | yes, once the re-read prints `$CFG` — an in-pane `/login` leaves it `unknown` and unproven |
| some other dir | **copy** | yes | no — use A | yes, once the re-read prints `$CFG` |

`unknown` means the process has no pinned dir, so it is on the bare credential: same path as `$CFG`
since the move, possibly a different and still-capped identity.

This is a snapshot and it decays — re-run it before each session you touch, and again after Step 6.

## Step 5 — migrate each stuck session

Repeat this whole step for **every** session Step 4 flagged. A half-migrated fleet is trap 1's failure
mode: a session still on subscription can write its refreshed credential back over the Console one.

Get the ids and worktree fields first:

```sh
node --input-type=module -e '
import {readFileSync} from "node:fs"
const raw = JSON.parse(readFileSync(process.env.HOME + "/.claude/channels/slack/sessions.json", "utf8"))
const list = Array.isArray(raw) ? raw : Object.values(raw.sessions ?? raw)
console.log("tmuxName | claudeSessionId | cwd | worktreePath | worktreeRepo | worktreeBranch | model")
for (const s of list.flat()) if (s?.tmuxName && !s.deadAt)
  console.log([s.tmuxName, s.claudeSessionId, s.sessionMetadata?.cwd,
               s.worktreePath ?? "-", s.worktreeRepo ?? "-", s.worktreeBranch ?? "-",
               s.sessionMetadata?.model].join(" | "))
'
```

The header and the `-` are not decoration: the three worktree fields are usually unset, and printed
raw they come out as the literal string `undefined`, which a hurried operator will paste into `WT=`.
A `-` means leave that variable empty.

`sessionMetadata.cwd` is the spawn-time working dir and goes **stale on resume** — never derive a
transcript path from it. `worktreePath` / `worktreeRepo` / `worktreeBranch` are separate fields and are
what the kill keys on.

Set these once for the session you are migrating, and use them for the rest of the step:

```sh
S=<tmuxName>
SID=<claudeSessionId>
SRC=<what Step 4 printed — a dir, or the literal word unknown>
WT=<worktreePath, empty if the query printed ->
WTREPO=<worktreeRepo, empty if the query printed ->
WB=<worktreeBranch; if the query printed -, use wt/$S — that is hydra's own default>
```

Same lifetime as `$CFG`: these die with the shell. Re-paste this block, and Step 0's, at the top of
every shell you run the rest of this step in — that is what `set S from Step 5` in an abort message is
telling you to do.

**Lane A — kill + resume (preferred; full context).** Use for any row in the table above; a session on
`$CFG` can still be serving an in-memory subscription token (trap 1).

`hydra kill` destroys a worktree only when `worktreePath` **and** `worktreeRepo` are both set
(`daemon/session-lifecycle.ts`). Unset, there is nothing to lose. Set, the destroy targets the
*registered* branch, which is not always the one checked out:

```sh
if [ -z "${WT?set WT from Step 5}" ] || [ -z "${WTREPO?set WTREPO from Step 5}" ]; then
  echo "worktreePath/worktreeRepo not both set — kill destroys no worktree"
else
  echo "registered: ${WB:?set WB — empty lists nothing and looks clean}   actually checked out: $(git -C "$WT" rev-parse --abbrev-ref HEAD)"
  git -C "$WT" status -sb                       # dirty tree: remove --force discards this
  git -C "$WTREPO" log --oneline "$WB" --not --remotes   # unpushed commits on the branch kill deletes
fi
```

Two different checks, and they read two different refs on purpose:

- `status -sb` covers **uncommitted** work, which `worktree remove --force` discards.
- The `log` covers **unpushed commits**, and it must name `$WB` in `$WTREPO` — not `HEAD` in `$WT`.
  Those are not the same ref whenever the worktree has been switched to a feature branch, which is the
  normal case: `hydra kill` runs `git branch -D $WB` (`daemon/worktree-manager.ts`), so auditing `HEAD`
  reports on a branch the kill will not touch and stays silent about the one it deletes. Live example
  while writing this: comet's worktree HEAD was `kevinliang/bank-1910` while its registered branch was
  `wt/flint` — two different commits.

`--not --remotes` rather than `@{u}..`, matching `checkUnpushedCommits` (`daemon/worktree-manager.ts`):
hydra's `wt/*` branches have no upstream, so `@{u}..` dies on stderr and lists nothing on exactly the
branch where every commit is unpushed. Any commits listed, or any dirty files: push or stash first.

Run this before the kill for **every** session, whatever Step 4 printed — the fence decides for itself
and prints `no copy needed` when there is nothing to do. It locates the transcript by id, because the
project-dir slug derives from the session's cwd and goes stale on resume:

```sh
case "${SRC:?set SRC from Step 5}" in unknown) SRC=$HOME/.claude ;; esac   # unpinned = the default dir
if [ "$SRC" = "${CFG:?run Step 0 first}" ]; then
  echo "no copy needed — transcript already under \$CFG"
else
  f=$(find "$SRC/projects" -maxdepth 2 -name "${SID:?set SID from Step 5}.jsonl" | head -1)
  if [ -z "$f" ]; then
    echo "STOP: no transcript for $SID under $SRC — find out why before killing anything"
  else
    d="${CFG:?}/projects/$(basename "$(dirname "$f")")"
    mkdir -p "$d" && { cp -n "$f" "$d/" || true; ls -l "$f" "$d/$SID.jsonl"; }   # cp -n exits 1 on skip
  fi
fi
```

Compare the two `ls -l` sizes and mtimes: `cp -n` declines silently when the destination exists.

This moves the session's main transcript only, not the `<claudeSessionId>/subagents/` sidecars beside
it. `resume` replays the main one, so the conversation survives; subagent detail does not follow.

Then kill it — with `hydra kill`, never `tmux kill-session`, because only `killSession` records
`claudeSessionId` into the thread registry and `resume` degrades to a tier-3 respawn without it
(trap 4):

```sh
cd ~/RubymineProjects/hydra && bun cli/hydra.ts kill "${S:?set S from Step 5}"
```

Then type `resume` in that session's chat thread. `resume` is chat-only; there is no CLI equivalent.
The daemon relaunches tier-1 `claude --resume <claudeSessionId>` and the conversation survives intact.

**Lane B — in-pane `/login` (for sessions you must not kill).** Only when Step 4 printed exactly
`$CFG`. A session that is `unknown` **and** unkillable — an unpushed worktree — has no clean route:
push or stash and use Lane A. Failing that, `/login` in the pane fixes that pane and not the fleet, and
Step 4 will still read `unknown` afterwards.

Apply the pane rule:

```sh
tmux capture-pane -p -t "${S:?set S from Step 5}" | tail -8
```

Only continue if that shows an idle, empty prompt. Then one batch at a time, re-capturing between each
— the menus differ if the session is mid-dialog:

```sh
tmux send-keys -t "${S:?set S from Step 5}" '/login'; sleep 2; tmux send-keys -t "${S:?set S from Step 5}" Enter; sleep 6
tmux capture-pane -p -t "${S:?set S from Step 5}" | tail -8
```

Only once that shows the `/login` menu — picking blind here selects option 1 (subscription) or the
legacy API-key path:

```sh
tmux send-keys -t "${S:?set S from Step 5}" Down; sleep 1; tmux send-keys -t "${S:?set S from Step 5}" Enter; sleep 6   # 2. Console account
tmux capture-pane -p -t "${S:?set S from Step 5}" | tail -8
```

Only once that shows the Console sign-in screen:

```sh
tmux send-keys -t "${S:?set S from Step 5}" Enter; sleep 12
tmux capture-pane -p -t "${S:?set S from Step 5}" | tail -8
```

That 12s is a floor, not a wait — it is a human browser round-trip (trap 0). Only once the capture
shows `Login successful`:

```sh
tmux send-keys -t "${S:?set S from Step 5}" Enter; sleep 2
tmux capture-pane -p -t "${S:?set S from Step 5}" | tail -8
```

Only on an idle, empty prompt — that capture is also the only confirmation the `Enter` above dismissed
the post-login screen rather than landing somewhere else:

```sh
tmux send-keys -t "${S:?set S from Step 5}" 'Reply with only the result of 7*6'
sleep 2; tmux send-keys -t "${S:?set S from Step 5}" Enter; sleep 6
tmux capture-pane -p -t "${S:?set S from Step 5}" | tail -8
```

`42` in that capture is the confirmation the in-pane `/login` took. Ask for something the *model* must
produce, never a token you supplied: a Claude Code pane leaves the submitted prompt on screen, so a
capture gated on `probe-ok` matches your own echo and passes whether the model answered, is still
thinking, or came back with the spend-limit error a beat later.

## Step 6 — restart the byte (this bounces the daemon too)

`down` unloads the watchdog, kills the byte, kills the **daemon**, and kills transcribe if no other
platform daemon is alive (`cli/lifecycle.ts`). Every session's bridge drops and has to reconnect, and
there is **no auto-recovery between these two commands** — do not stop in the middle.

**Check `HYDRA_AUTH` first.** Set to `keychain`, this pair undoes the migration: `down` deletes
`$CFG/.credentials.json`, then `up` re-creates it from the **bare** `Claude Code-credentials` entry —
hardcoded, regardless of `$CFG`. On a shared config dir that writes your personal, possibly
still-subscription credential straight into the fleet's dir.

`HYDRA_AUTH` is read by the **CLI** process you are about to run (`cli/helpers.ts`), not by the daemon,
so check both places it can come from. The CLI lets a non-blank environment value win over the `.env`
(the same precedence noted above), so a `keychain` exported in your shell beats an `auto` in the file.
The `|| true` on both lines matters: `grep` exits 1 when it finds nothing and `printenv` exits 1 on an
unset var, so under `set -e` either would kill the shell and hand you the same silence that means
"safe".

```sh
grep -nE '^[[:space:]]*(export[[:space:]]+)?HYDRA_AUTH=' "$HOME/.claude/channels/slack/.env" || true
printenv HYDRA_AUTH || true
```

Silence from both is the safe answer, and is the case today.

If either prints `keychain`, do **not** rely on `unset` — the fence below is a fresh shell, and a
`keychain` visible to a fresh shell comes from a profile or `launchctl`, so an `unset` here will not
reach it. Pin the safe value on the command line instead, exactly as the commands below already do for
`CLAUDE_CONFIG_DIR`. A non-blank environment value beats both an inherited export and the `.env`, so
this is sufficient on its own. Write `auto`, never a bare `HYDRA_AUTH=` — a *blank* value counts as
absent and gets backfilled straight from the `.env` you were trying to override. Back up
`$CFG/.credentials.json` if one exists, and re-run Step 2 after `up`.

`hydra preflight slack` is worth a run here too — it flags the first-run trust gate below before you
hit it. Its "byte auth resolvable" check reads the same bare entry, so it does **not** prove the pinned
identity.

```sh
cd ~/RubymineProjects/hydra && HYDRA_AUTH=auto CLAUDE_CONFIG_DIR="${CFG:?run Step 0 first}" bun cli/hydra.ts down slack 2>&1 | tail -6
n0=$(wc -l < ~/hydra-slack-daemon.log); echo "mark: n0=$n0"   # write this number down
cd ~/RubymineProjects/hydra && HYDRA_AUTH=auto CLAUDE_CONFIG_DIR="${CFG:?run Step 0 first}" bun cli/hydra.ts up slack 2>&1 | tail -8
```

A config dir the byte has never run in triggers a first-run trust dialog. Apply the pane rule:

```sh
tmux capture-pane -p -t slack-byte | tail -8
```

Only if that shows the trust prompt — move the highlight, confirm where it landed, then commit, since
the second item is not the accept option on every build:

```sh
tmux send-keys -t slack-byte Down; sleep 1; tmux capture-pane -p -t slack-byte | tail -8
```

If the highlight started on the accept option, `Down` moves it off — send `Up` and re-capture rather
than guessing.

Only once that capture shows the highlight on the accept option:

```sh
tmux send-keys -t slack-byte Enter; sleep 2; tmux capture-pane -p -t slack-byte | tail -8
```

Confirm the byte's bridge separately from the spawned sessions' — a combined `tail` fills with
registrations and passes with no evidence the byte came back:

```sh
tail -n +$(( ${n0:?set n0 to the mark printed above — do NOT re-run down/up} + 1 )) ~/hydra-slack-daemon.log |
  grep 'main bridge connected' ||
  echo "NO main-bridge CONNECT since your mark — the byte did not come back"
echo "sessions registered since your mark: $(tail -n +$(( ${n0:?set n0 to the mark} + 1 )) ~/hydra-slack-daemon.log | grep -c 'daemon: bridge registered for session')"
```

**If you are in a new shell, re-set `n0` to the number the mark printed — do not re-run `down`/`up`.**
That pair drops every session's bridge again and `n0` cannot be re-derived once the log has grown,
which is why the mark is echoed rather than only assigned.

Two things this fence is careful about. It anchors to the line count *you* took, not to anything in
the log; and it greps `main bridge connected`, not the looser `main bridge`. The log is
append-only across `down`/`up` — a dozen `Daemon started` banners in the current one — and the bridge
lines carry **no timestamp**, so a bare `grep … | tail` returns proof from a daemon that died hours
ago. Anchoring to the last banner is not enough either: `lifecycleUp` exits before writing one if a
tmux session survived the `down`, if orphaned byte processes are found, or if the compile check fails
(`cli/lifecycle.ts`). In all three the log keeps growing, the newest banner is still the *previous*
boot's, and the check happily reports that dead daemon's `main bridge connected`. A mark you took
yourself cannot be stale.

But a mark only proves a line is **new**, not that it came from a **new daemon** — and that is why the
grep names `connected`. If a tmux session survived the `down`, the old daemon is still up and still
flapping; its reconnect line (`daemon/main-bridge-cycle.ts`, throttled to once a minute but exempt for
the first three cycles) lands after your mark and would satisfy a bare `main bridge`. `connected` is
written only on cycle 1 of a daemon process (`daemon/bridge-server.ts`), which a surviving incumbent
cannot produce and a genuinely fresh one always does. `reconnected` does not contain it.

The `|| echo` matters too: `tail | grep` exits 1 on no match, which under `set -e` is the same
suppression-plus-silence that has bitten this runbook twice.

## Verification that actually proves it

Metadata is not proof. Open the migrated session's transcript — by id, as in Step 5:

```sh
find "${CFG:?run Step 0 first}/projects" -maxdepth 2 -name "${SID:?set SID from Step 5}.jsonl" |
  grep . || echo "no transcript under \$CFG for $SID — the migration did not bring it across"
```

Confirm the spend-limit error appears before the switch and normal completed turns appear after.

Then have the session confirm in its own thread. Apply the pane rule:

```sh
tmux capture-pane -p -t "${S:?set S from Step 5}" | tail -4
```

Only on an idle, empty prompt:

```sh
tmux send-keys -t "${S:?set S from Step 5}" 'Post a short status update in this thread: confirm you are back online, state which task you were mid-way through, and flag anything you lost.'
sleep 2; tmux send-keys -t "${S:?set S from Step 5}" Enter; sleep 3
tmux capture-pane -p -t "${S:?set S from Step 5}" | tail -6
```

That last capture is how you tell the two failure modes apart: if the prompt is still sitting in the
buffer unsent, the `Enter` did not land; if it submitted and no reply reaches the thread, the bridge is
the problem.

A reply proves the bridge is routing and the context survived. It proves *billing* once Step 4, re-run
after Step 6, prints `$CFG` for that session.

## Traps

0. **Budget one browser prompt per live session you migrate in place.** A restarted process reads the
   keychain and needs no login — that is why the byte restart is silent. A *running* process holds its
   OAuth pair in memory, so the only in-place fix is `/login`, and each is its own authorization
   round-trip. There is no way to broadcast one login across sessions.

1. **A healthy running session never re-reads the keychain.** It refreshes from its in-memory token
   pair; the store is only re-read after a refresh *fails*. Prompting the session does nothing. A
   restart or in-pane `/login` is the only way to flip it. Worse, a still-subscription session can
   write its refreshed credential back over the Console one, so roll every session promptly rather than
   leaving a mixed fleet overnight. Since `$CFG` is now your personal dir too, **your own terminal
   `claude` counts as one of those sessions** — log it into Console as well, or leave it exited.

2. **Older checkouts silently launch the daemon under the wrong config dir.** `resolveConfig` used to
   read `CLAUDE_CONFIG_DIR` *before* sourcing the state-dir `.env`, so `hydra up` / `restart` from a
   clean shell handed the daemon an unpinned default. Symptom: kill+resume and kill+respawn both appear
   to "fail", because the daemon is minting sessions under the wrong dir. Fixed on `main`; the env
   prefix above is belt-and-braces and still required on any branch predating that fix. To check what
   the running daemon actually got, filter to the `bun` process — the pane pid is a shell whose command
   line carries a quoted copy, the same trap as Step 4:

   ```sh
   dpid=$(tmux list-panes -t slack-daemon -F '#{pane_pid}' | head -1)
   for cp in $(pgrep -P $dpid) $dpid; do
     [ "$(ps -p $cp -o comm= | sed 's|.*/||')" = bun ] || continue
     ps eww -p $cp -o command= | tr ' ' '\n' | grep -E '^(CLAUDE_CONFIG_DIR|HYDRA_MODEL)='
   done | sort -u
   ```

3. **`hydra kill` destroys a worktree** when `worktreePath` and `worktreeRepo` are both set, targeting
   the *registered* branch rather than the one checked out — see the Lane A fence. It does post an
   unpushed-commit warning into the thread, but fire-and-forget: `destroyWorktree` runs regardless
   (`daemon/session-lifecycle.ts`). That warning is not a gate. The Lane A fence is.

4. **Kill with `hydra kill <name>`, never `tmux kill-session`.** Only `killSession` records
   `claudeSessionId` into the thread registry. Skip it and `resume` degrades to a tier-3 respawn with
   thread history only and no conversation context.

5. **Resume keeps the dead session's model**, not the current `HYDRA_MODEL`. To change model, use
   `/model <id>` in the pane or spawn fresh.

6. **Queued-message misrouting.** After a kill+resume in the same DM channel, a previously-killed
   session's queued bootstrap prompt can be re-delivered into the resumed session, and can rename the
   thread. Harmless, but do not mistake it for a bug in your migration.

7. **`hydra spawn` requires both** `--idempotency-key` and `--initiator`. It reports them one at a time.

## Rolling back to subscription

Same flow, choosing option 1 (`Claude account with subscription`) at the `/login` menu, then **steps 2
through 6**. Do not skip Step 2: rollback deliberately returns you to the identity that was capped, and
the smoke test is how you find out whether the cap is still in force *before* restarting the fleet. On
a shared `$CFG` this moves your personal terminal back to subscription too.

## Companion lever: burn rate

Once the fleet is on usage-based billing, model choice is a direct dollar cost rather than a cap. Fable
bills at exactly twice Opus per token. These rates are not derivable from anything in this repo and do
change — confirm against current pricing before leaning on them for a spend decision:

| Model | Input $/1M | Output $/1M |
|---|---|---|
| `claude-fable-5` / `claude-fable-5-1` | 10.00 | 50.00 |
| `claude-opus-5` / `claude-opus-4-8` / `claude-opus-4-6` | 5.00 | 25.00 |
| `claude-sonnet-5` | 2.00 | 10.00 |

Two places pin the default, and both matter:

- `~/.claude/channels/slack/.env` → `HYDRA_MODEL` — the `--model` flag on every new spawn.
- `$CFG/settings.json` → `model` — the fallback for anything launched without `--model`, including
  **subagents spawned inside sessions**, which is often the larger share of spend. While `$CFG` is
  `~/.claude` this is also your own terminal's settings file.

Neither takes effect until the daemon restarts, and neither retroactively changes a live session.
`resume` re-launches with the *dead session's* model. To move a running session, either send
`/model claude-opus-5[1m]` into its pane or respawn it.

## Appendix — reading the keychain

Timestamps tell you *where a recent login landed*, which is the usual surprise. The `while read` form
is deliberate — the service names contain a space:

```sh
security dump-keychain 2>/dev/null | grep -o '"Claude Code-credentials[^"]*"' | tr -d '"' | sort -u |
while IFS= read -r s; do
  printf '%-42s ' "$s"; security find-generic-password -s "$s" 2>&1 | grep -E 'cdat|mdat' | tr -d '\n'; echo
done
```

`dump-keychain` without `-d` reads metadata only: no prompt, no credential bodies. Timestamps are UTC.

`Claude Code-credentials-<hash>` is a pinned config dir, where the hash is the first 8 hex of the
sha256 of its absolute path — verified for three of the five entries here: `a21d4e95` =
`~/.claude-byte`, `983846fb` = `~/.claude-slack`, `1391f22c` = `~/.claude`. The hash is path-exact; a
trailing slash or an unexpanded `~` is a different digest.

A hashed entry you cannot identify, with a `cdat` inside a login window, means a login landed somewhere
you did not intend — check `cdat` before assuming otherwise. The fifth here, `5edcfcc7`, is exactly
that shape: created 2026-09-11 18:09:56Z, 49s after `~/.claude-byte` was last written, and matching no
path on this machine. An entry outlives the directory that made it, so a since-deleted dir is the
benign reading.

```sh
CFG="${CFG:?run Step 0 first}" && printf %s "$CFG" | shasum -a256 | cut -c1-8
```

The assignment and the `&&` are both deliberate. A `${VAR:?}` in the *first element of a pipeline* only
kills that subshell, so `printf %s "${CFG:?…}" | shasum` would still hash empty stdin and print
`e3b0c442` — sha256 of the empty string, eight hex digits, indistinguishable from a real suffix and
matching nothing. Keeping the assignment out of the pipeline fixes that, and the `&&` keeps it fixed if the line is ever
split back into two — a failed assignment does not stop the next line in an interactive shell.

**Whether a bare `Claude Code-credentials` entry is a separate identity from `-<hash of ~/.claude>` is
unresolved.** The obvious reading is "bare = the unset-env identity", and nothing in any shell profile
or `launchctl getenv` sets the variable. But `-1391f22c` was created 2026-06-25, months before the
fleet moved to `~/.claude`, and the bare entry was created after it — so bare is not an older default
the hashed ones were carved from. If the current build hashes the resolved default unconditionally, an
unset-env `claude` would write `-1391f22c` too, and an ordinary login *would* flip the fleet.

Which is why it is safe to leave unresolved: always pass the env prefix, and confirm with the smoke
test rather than with a mental model of the keychain.
