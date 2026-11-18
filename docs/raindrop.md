# Raindrop observability (opt-in, off by default)

Reports session lifecycle metadata to [Raindrop](https://raindrop.ai) — spawn, reply,
death, and 👍/👎 reactions as sentiment signals. **No message text is ever sent.**

Events go to `/v1/events/track`, the vendor's plain-event endpoint, as a
one-element array. Not `track_partial`: hydra sends no prompt or completion
text, and a finalized partial carrying neither renders as an empty
AI-generation row — the vendor's own Rust and Python SDKs drop that shape
client-side. The price is that the plain endpoint's ingest schema has no
conversation field, so the thread id travels as an ordinary property and
grouping is a filter rather than a built-in conversation view.

Two wire bodies, both in `daemon/raindrop-payload.ts`. An event carries the
event name, your `user_id`, an ISO timestamp, a platform message or session id
as `event_id`, and `properties`: the `SESSION_PROPERTY_KEYS` allowlist
(`tmuxName`, `engine`, `sessionType`, `originType`, `platform`) plus `repo`,
`threadId`, `model` and `replyChars`. A signal carries an `event_id`, a fixed
signal name, a sentiment, and the constant `signal_type`. Nothing else leaves
the machine.

Every property value is shape-checked at the boundary, not trusted from
upstream: 64 identifier characters, and anything else is dropped rather than
sent. Three fields carry a value the calling session or its spawner chose.
`model` is resolved against the model catalogue and dropped if it isn't one.
`repo` is the git project the session's worktree belongs to, capped at 40
identifier characters — which bounds it but does not close it, since a session
that can create directories under `SPAWN_CWD` chooses up to 40 of those bytes.
Set `RAINDROP_OMIT_REPO=1` and the field is never sent; any non-empty value
omits, so the control fails closed. `threadId` is a spawned session's own
thread and, for main, the reply's chat id; it is bounded to 32 identifier
characters plus an optional Slack timestamp rather than closed.

Set in the state-dir `.env` alongside the bot tokens. The daemon reads that
file itself and then removes the four `RAINDROP_` vars from its own
environment, so they are in no command line, no `ps` output, and nothing the
daemon forks — a child started with the daemon's environment would otherwise
carry the key where any process running as you can read it. That is not a
secret from a session that goes looking: the file is `0600` and every session
runs as you, exactly as it already does for the bot tokens.

The spawn boundary scrubs as well, because the CLI reaches `tmuxNewSession()`
on paths that never load the daemon's config. Creating a tmux
*session* goes through `tmuxNewSession()` in `shared/spawn-env.ts` and nothing
else may; spawning codex goes through `codexSpawnEnv()`. Both are enforced by
test. A new *window* in an existing session is not covered and does not need to
be — a window's pane inherits the server environment, which the sweep has
already cleared. `tmuxNewSession()` does two things — it sanitizes the environment handed
to the child, and it sweeps an already-frozen server with `set-environment -gr`
— because a pane inherits the tmux server's environment rather than the
client's. `codexSpawnEnv()` only sanitizes; codex never starts a tmux server,
and a pane it lands in was already swept. On the shell path
`scrub-raindrop.sh` does both halves, sourced by `env-setup.sh` and by
`start-transcribe.sh`. That also means a value
frozen there would outrank both `.env` files. Only the daemon re-reads them,
from the file. Starting the daemon clears them from a server that already holds
a copy.

Three rungs, highest first: the daemon's inherited environment, the repo-root
`.env`, the state-dir `.env` — each only fills what the one above left blank.
So a stray `RAINDROP_` line at the repo root overrides the state dir, including
an explicit `off`. The top rung is not a way in: exporting a `RAINDROP_` var in
your shell does **not** work, because the CLI and `env-setup.sh` both strip them
before the daemon starts — `RAINDROP_MODE=dryrun hydra restart` is a silent
no-op. It has to go in a file.

```bash
# dryrun writes payloads to <state-dir>/raindrop-dryrun.jsonl and sends nothing.
# Over 5MB the oldest lines drop back to a 2MB tail, checked once a minute —
# sample that file, don't archive it.
# Switch to `live` once you've read it and are happy with it.
RAINDROP_MODE=dryrun
# Printable ASCII only. A key that picked up a zero-width space or smart quote
# on the way out of the browser is refused, and hydra health names it. Quote the
# value: env-setup.sh shell-sources this file, and a bare quote inside it aborts
# that source — under watchdog.sh, silently, dropping every var below this line.
RAINDROP_WRITE_KEY="..."
# Any non-empty value omits the field — a misread value withholds data rather
# than sending it. Blank or absent leaves repo names on. hydra health names a
# value that isn't the literal 1.
# RAINDROP_OMIT_REPO=1
# Your own platform user id (Slack U…/Discord snowflake), stamped on EVERY
# session's events. Required once the top-level allowFrom has more than one
# entry; until then the module refuses to guess and sends nothing. On Slack,
# channel groups are skipped rather than counted; on Discord any group stops
# recording entirely.
# Leave blank rather than guessing: a wrong id attributes every event to a
# stranger, silently.
RAINDROP_USER_ID=
```

Unset `RAINDROP_MODE` means no listeners are registered at all. `live` without a
write key is treated as `off` and logged, never as a silent dry-run. Changes need a
daemon restart.

`hydra health` (CLI and chat) reports the current mode, a running count of
events and signals recorded with how long ago the last one was, whether events are
attributable, whether `RAINDROP_USER_ID` names someone who can actually drive a
session, whether `RAINDROP_OMIT_REPO` was understood, and any failures. **That count is the check after switching to
`live`:** send one message to a session, re-run `hydra health`, and confirm it
went up. Before any traffic a healthy install and a bad key look identical — a
401 only shows once a send has been attempted. A rising count proves the vendor
accepted the POST, not that it landed where you meant: open Raindrop and
confirm the `hydra.session.*` events and thumbs signals appear under the user
id you configured. Note the write key is org-scoped and hydra sends no
`X-Raindrop-Project-Id`, so everything lands in the org's **Production**
project regardless of which project page you copied the key from. The counters reset on restart. The dry-run file is created lazily
— it won't exist until the first session event — so on a fresh enable, check
`hydra health` rather than `ls` — `grep raindrop
~/hydra-<platform>-daemon.log` only confirms registration and names failures,
since nothing is logged per event. It is also append-only across restarts, so an old file is not evidence the
current daemon is writing; check its mtime.

Switching back to `dryrun` stops egress but is not a teardown — the key stays
live on disk, and health will not mention it because a key is expected during a
dry run.

Turning it off stops the reporting, not the whole change: the tmux environment
sweep, `scrub-raindrop.sh`, the capture that strips the four vars from the
daemon's own environment, the `reaction` event, the Discord reaction intent and
the dry-run file's 5MB trim are all unconditional. If the problem is in one of those, this is a revert
and a restart, not an `.env` edit.

To turn it off: remove `RAINDROP_MODE` **and** `RAINDROP_WRITE_KEY` from **both**
the state-dir `.env` and the repo-root one, then restart and confirm `hydra
health` no longer prints a Raindrop line (`raindrop:` on the CLI,
`• Raindrop:` in chat). Both files, because either rung alone re-enables it. A
key left behind is inert but still a live credential on disk.
Delete `<state-dir>/raindrop-dryrun.jsonl` yourself; re-enabling appends to the
existing file. The 5MB trim keeps running from the vitals tick whatever the mode
is, so a dry-run file kept as evidence still loses its oldest lines — copy it
elsewhere if you need it intact. Anything already sent in `live` mode
is at the vendor: deleting it there is your job, not hydra's.

Known limits:

- `hydra.session.death` fires on every `killSession` path — kill, respawn, reap,
  protocol completion, thread `destroy`. A session that *crashes* emits nothing
  at the moment it dies; it only reports when something reclaims the thread.
  Reclaiming in the same daemon does emit, stamped with the crash time rather
  than the reclaim, so duration stays honest. Reclaiming after a daemon restart
  emits nothing at all — the new process never knew the session — so deaths are
  under-counted by the crashed-then-restarted population.
- A daemon restart emits no `hydra.session.spawn` for sessions already alive at that
  moment — they are re-seeded as known. On the very first enable that is every
  session running at the time, so their deaths arrive with no matching spawn. A
  spawn-vs-death funnel will therefore under-count spawns across restarts.
- 👍/👎 signals only attach to replies this daemon process sent, and only the
  most recent 1000 messages — a reply split into chunks uses one slot per chunk,
  so the window is shorter than 1000 replies. Reacting to an older message
  records nothing.
- 👍/👎 need the platform to deliver reaction events: a Slack app needs
  `reaction_added` in its bot events (`docs/slack.md`), and reacting in a Discord
  DM needs the `DirectMessageReactions` intent. Slack needs the manifest updated
  and the app reinstalled; the Discord intent is code-side and non-privileged, so
  a `hydra restart` on this version is enough.
- `model` is the model the session *launched* with, for claude sessions: an
  in-session `/model` switch does not change it, and for main a byte restart
  surfaces within 10 minutes. Codex sessions differ — the app-server reports the
  thread's current model on every daemon boot, so a switch does surface. A model
  outside the catalogue is dropped rather than sent, which reads the same as a
  session that had none.
- Switching to `dryrun`, or a vendor outage, needs a daemon restart to take
  effect — the mode is read once at boot. There is no runtime off switch, and a
  `live` install with an unreachable vendor keeps trying one 5s request per
  event, logging each failure, until you restart it.
- A 👍 then 👎 on the same reply records both, permanently. Signals are not
  retractable and `reaction_removed` is not subscribed; repeating the *same*
  reaction is de-duplicated, changing your mind is not.
- `repo` is present only for a session spawned into a worktree. A plain
  `spawn:` session runs in `SPAWN_CWD` and reports none, so a repo-grouped view
  covers part of the fleet rather than all of it.
- main reports replies only. It has no registry entry, so it produces no spawn
  and no death event.
- `model` is a plain property, not Raindrop's built-in model dimension — that
  dimension is fed from `ai_data`, which this does not send. Filterable, but it
  won't group Events or Costs by model for you.
- Every event carries the one configured `RAINDROP_USER_ID`. On a shared
  install a colleague's session is reported under your id — only their 👍/👎 is
  dropped, not their sessions.

## 🔪 now works in Discord DMs

The intent that carries 👍/👎 also reaches the `:hocho:`/🔪 delete handler,
which could not fire in a Discord DM before. Intended, and gated on the
top-level `allowFrom` as it already was in guilds — but it is a permission
change, and turning Raindrop off does not revert it.

## Troubleshooting

**Raindrop is enabled but nothing is being recorded.**

Run `hydra health` — **after restarting the daemon**, which reads its
environment at boot, so an edited `.env` means nothing until then. No Raindrop
line (`raindrop:` on the CLI, `• Raindrop:` in chat), or one reading
`RAINDROP_MODE is off or unset`, means the mode resolved to `off` — either unset everywhere, or an
`off` that outranked your `dryrun`. Check the **repo-root** `.env` first; it
beats the state dir. That same line after a teardown is the reminder that the
write key is still on disk.

"no allowlisted user" means nobody can be identified at all: nobody has paired
yet, or `access.json` was corrupt and got reset (hydra moves it aside and
starts from defaults). If it says "no attributable user", the opposite — the
top-level `allowFrom` has more than one id — and nothing is sent until
`RAINDROP_USER_ID` is set. Channel groups don't count: on Slack their sessions
and replies are skipped and health says how many group channels that covers; on
Discord, where a thread id doesn't name its channel, any group stops recording
and health says so. That
can start happening long after boot, because `access.json` is re-read on every
message. Signals are narrower than events: an event is *attributed* to
`RAINDROP_USER_ID`, so only a reaction from that same id records one. Anyone
else's 👍/👎 is dropped rather than filed as yours, and `hydra health` does not
count it as a failure.

"N send failures" (live) or "N write errors" (dryrun) counts rejected posts,
failed local writes, and any error thrown inside a raindrop listener. Get the
detail from `grep -E 'raindrop: (send|write) failed' ~/hydra-<platform>-daemon.log`
— a 401 is a bad write key. If health shows a normal mode and no failures, the dry-run file is
created lazily and only appears after the first session event.
