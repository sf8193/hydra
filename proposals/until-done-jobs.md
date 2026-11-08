# Until-done jobs

> Status: proposal v12, 2026-11-07. The user approved the direction. Shaped by the adversarial review (critic rounds
> 1–10) and an independent pass. For review before building.

## What hydra jobs should offer

**You say what should happen and when. Hydra makes sure it happens: once per slot, as soon as it can, and tells you
only when something is actually wrong.**

Today hydra jobs answers only "when": launchd fires the job at its time, or once on wake, and it runs once. Four
questions get merged into that one firing, and every script answers the other three itself:

| Question | Today | Offered |
|---|---|---|
| When is it owed? | cron fires once | the latest slot is owed until it is done |
| When can it run? | the script checks and exits 0 ("nothing") | `needs`, or exit 75: "not now" |
| What counts as done? | the firing happened | the work succeeded, as only the runner can see |
| When do you hear? | any failure, once a day | failures that persist past `alert_after`; never for being offline |

The scripts that motivated this (a weekly review spawn and an hourly backup sync, both on a laptop that sleeps and
travels) carry stamp files, internet probes, and "print a line so the spawn happens" tricks. Each of those is
compensating machinery for a concept the runner lacks. After this, the weekly review needs **no script at all**, and
the backup script keeps only its domain check.

## The model

- **Slot:** a local wall-clock instant the job's cron expression matches.
- **Owed:** the latest slot at or before now, unless a success already covers it (the rule is under Slots in local
  time). Missed slots collapse: only the latest can be owed, so a week offline runs a weekly job once, not seven
  times.
- **Attempt:** one run of the job's work. Its result is `done`, `nothing to do` (counts as done), or `failed`.
- **Not now:** a precondition isn't met (`needs`, exit 75). It is **not an attempt** and never uses up a slot, for any
  job.
- **Goal:** `until_done` toggles two things, and the second follows from the first:
  - **whether a failed attempt uses up the slot.** A plain job gets one attempt per slot, whatever its result. An
    `until_done` job is attempted while its slot is owed, with backoff, until it is done.
  - **how failures alert.** A plain job's slot is gone after one failure, so it reports daily. An `until_done` job
    keeps retrying, so a single failure isn't news: it alerts once per failure run, past `alert_after`.
- **Done for spawn jobs** means the daemon accepted the spawn. Whether the session then does its work is session
  health (pane-probe, idle-limit), not job state. The two meet only at `overlap`.

Naming: not "durable". In durable execution and durable queues, that word means work that survives a crash and
resumes where it stopped. Here a failed attempt is simply retried from the start. The setting is named for its rule.

**The line between hydra and the job:** hydra owns *liveness* (is the work happening and succeeding?). The job owns
its *domain* (is the thing it watches healthy?). A sync can succeed every hour while the server it copies from has
stopped producing backups; detecting that stays in the job, as an ordinary failure exit.

### Slots in local time

- **The matcher.** Hydra needs a local-time cron matcher that finds the latest match at or before a given instant.
  `Bun.cron.parse` only finds the next match, and in UTC (`0 11 * * FRI` gives 03:00 on a Los Angeles machine). The
  matcher is a small pure function with its own tests. The same matcher fixes `jobs list`'s "next".
- **The owed rule.** A slot's label is its local wall-clock time, `YYYY-MM-DD HH:MM`. The latest slot is owed iff
  its **instant** is after the last success's (for plain jobs: the last attempt's) instant **and** its **label**
  differs from the last done (attempted) slot's label.
  - The label stops the double Friday: done at 11:00 in Berlin, then in California the same day, the slot
    `2026-11-13 11:00` is later as an instant but has the same label, so it isn't owed.
  - The instant keeps frequent jobs moving. An hourly job done at Berlin 15:00 is owed again at 08:00 in California,
    a later instant with a different label. Comparing labels by sort order would stall it for 9 hours.
- **DST.** A fall-back time occurs twice but has one label, so it runs once. A spring-forward time that doesn't exist
  runs at the first instant after the gap, under its nominal label.

## A job

```toml
[weekly-review]                  # an obligation: once per slot, a miss or a duplicate is an error
schedule = "0 11 * * FRI"
until_done = true
needs = ["internet"]
overlap = "absorb"               # a still-open session from this job handles the owed slot
mode = "spawn"
prompt = "..."                   # no check: the work is the spawn itself

[backup-pull]                    # convergence: keep something true; repeating is harmless
schedule = "0 * * * *"
until_done = true
needs = ["internet"]
alert_after = "2d"
mode = "none"
check = "~/scripts/backup-pull.sh"   # the sync plus its domain check (newest dump fresh)

[dependency-scan]                # a probe: unchanged from today
schedule = "0 6 * * *"
check = "~/scripts/dependency_scan.sh"
mode = "spawn"
prompt = "Triage the scan output below."
```

| Key | Values | Default | Notes |
|---|---|---|---|
| `until_done` | boolean | `false` | a failed attempt doesn't use up the slot |
| `needs` | names; v1 knows `"internet"` | `[]` | unmet → "not now"; evaluated by the daemon before dispatch |
| `overlap` | `"absorb"` | unset | spawn only; see Overlap |
| `alert_after` | duration up to `30d` | `"1d"` with `until_done` | until-done only; see Alerts |

There is no `kind` key. Obligation, convergence and probe are combinations of these keys.

## The work contract

The work is the optional `check`, then the action for the mode (spawn, deliver to main, or nothing for `none`).

| Check result | Meaning | Then |
|---|---|---|
| no check | — | run the action |
| exit 0, output | findings | run the action with the findings; `none`: done |
| exit 0, no output | nothing to do this slot | done, no action |
| exit 75 | not now | stdout dropped; not an attempt; the slot stays owed for any job |
| other exit | failed | a plain job's slot is used; an until-done slot stays owed; counts toward alerts |

The action's own result decides the attempt: a spawn or delivery the daemon refuses is a failed attempt, and the slot
stays owed. That is the case that check scripts cannot handle today, because the spawn happens after they exit.

Exit 75 (`EX_TEMPFAIL`) is the job-specific form of "not now". `needs = ["internet"]` is built in because nearly
every laptop job has that precondition.

## The clock lives in the daemon

Today each job is a launchd entry made by `Bun.cron`. That choice kept the first version free of daemon changes.
Moving to owed slots exposes what it costs:

- **Stalled jobs.** launchd skips a firing while the previous one is still running, so with one shared tick, a
  30-minute check would stall every job.
- **Lost firings.** A `StartInterval` firing during sleep is lost.
- **A version-pinned interpreter.** Plists point at a versioned bun (`/opt/homebrew/Cellar/bun/<version>/...`), so a
  `brew upgrade` silently stops every job.
- **No watcher.** Nothing checks that the scheduler itself still runs.
- **Races.** A manual `jobs run` and a scheduled firing race on the state file.
- **Wrong times.** `jobs list` shows UTC "next" times, as above.

The daemon is already the always-on part of hydra. It is watched by the watchdog, and it already runs periodic work
(pr-watch, idle-limit, gateway-health). **So the daemon owns the clock and every decision, and attempts run on their
own**, because the daemon restarts often and an attempt must not die with it.

### The tick

One timer per daemon (platform), every minute. **One daemon per state dir owns the clock:** before its first tick
the clock opens `jobs-state/_daemon.lock` with `O_EXLOCK | O_NONBLOCK` and holds the descriptor for the daemon's
life. The kernel releases it on exit. Node's `fs` doesn't export `O_EXLOCK`; the darwin value is `0x20`, verified
under bun: a second open gets `EAGAIN`. A daemon that can't take the lock retries the
non-blocking open **every tick** (a routine restart briefly overlaps the exiting daemon). Until it has the lock it
dispatches nothing, applies nothing, and refuses `jobs run`. Its health loop runs regardless of whether it owns the
clock, and it reports a clock that stays unowned. This covers the
daemon's own singleton race (the socket probe comes before the listen), which is worth its own ticket.

**Ticks run one at a time.** A tick that is still running when the next is due delays it, so the daemon never
looks at its own reservation in the middle of its own spawn.

A wall-clock jump larger than the interval (wake from sleep) is just
a tick that finds slots owed. Each tick:

1. **Reads jobs.toml.** If it is missing or doesn't parse, the daemon keeps running the last good config and alerts
   once a local day. A corrupt `_daemon.json` is treated the same way: the daemon alerts and starts it fresh.
2. **Decides whether the machine is online:** the captive-portal probe (`captive.apple.com` returns "Success")
   **or** the daemon's gateway connection (gateway-health). Two independent witnesses: a VPN that blocks the probe
   can't make every job "not now" forever, and a captive portal (probe fails, gateway down) still reads offline.
3. **For each job,** computes the owed slot. Then it skips the job if it has a live dispatch, holds it if backoff
   says wait, and records not-now itself if `needs` is unmet or overlap has no verdict yet. Otherwise it decides
   overlap and dispatches.
4. **Applies results,** and catches dispatches that ended without one (below). Then it **decides alerts** from
   current state.
5. **Records the tick.**

**Backoff:** after a failure, the next attempt waits min(2^n minutes, 1h, the schedule's period). n and the
starting time come from the failure run (State); a dispatch that ended without a result counts like any failure.
Not-now re-probes every
tick, because probing is cheap.

### Overlap

Overlap counts only connected sessions with initiator `jobs:<name>`, using a per-session verdict that pane-probe
exports: `clean | active | stuck(<kind>, confirmed) | unprobeable`.

- `clean` and `active` **absorb**: the slot is done, by that session.
- `stuck` (confirmed, of a named kind) is a **failure** ("previous session stuck: <kind>"), dispatched only when
  backoff allows. A session stuck on a prompt must not turn into silent success.
- `unprobeable` (Codex sessions today) **absorbs**. That choice is explicit: they can't be inspected, the idle limit
  reaps them, and the cross-slot rule below catches one that lingers.
- **No verdict yet** since the daemon started is **not now** for that tick. That takes about 2 minutes.
- **Only a session spawned after the previous slot's instant may absorb.** Domain reason: a session that covers
  everything since its predecessor (like a weekly review) is still doing slot N−1's work when slot N arrives, so it
  legitimately covers N, once. Still open at N+1, it is not doing the work, so that is a **failure** ("session from
  <label> still open"). Don't "fix" the one absorbed slot: it is the point.

### Dispatch, attempts and results

**The daemon is the only writer of job state.** It decides, it dispatches, and it records. An attempt does the
work and reports one result. It never reads or writes job state.

**Outcomes that need no work are recorded by the daemon directly,** with no process: absorbed and stuck (overlap),
needs unmet or no verdict yet (not now), and the baseline.

**Everything else is dispatched, in two phases:**

1. **Reserve.** Check "no live dispatch" and write `dispatch: {id, nonce, at, slot, deadline}` with the next per-job
   id and a random nonce, as one synchronous step with no `await` in between. The tick and a `jobs run` request both go through this one step,
   so they can't both dispatch. The id is reserved before anything runs, so it is never reused.
2. **Spawn**, then add `pid` and `lstart` to the record.

The detached child:

`bun hydra.ts jobs attempt <platform> <name> --dispatch <id> --nonce <nonce> --slot <label>`

- **Detached:** its own process group (`child_process.spawn(..., { detached: true })`; macOS has no `setsid`
  command), so a daemon restart doesn't kill it. The daemon records the child's `pid` and `lstart`
  (`ps -o lstart= -p <pid>`).
- **Input:** the resolved job definition on stdin, so the attempt never reads jobs.toml, and a broken or mid-dispatch
  edit can't make it run something the daemon didn't evaluate.
- **Output:** stdout and stderr go to `jobs-state/<name>.log`, never to a pipe to the daemon, so the first write after
  a daemon restart can't hit EPIPE.
- **The result:** one file, `jobs-state/results/<name>.<id>.json`, written atomically once and never changed:
  `{dispatch, at, result: done | nothing | failed | not-now, note?, absorbedBy?}`.
- **Deadlines:**
  - The action has its own timeout: `hydra spawn` and `deliver` are killed after 2 minutes.
  - The attempt enforces a hard deadline on itself: the check timeout (30m) + the action timeout + 2 minutes. When it
    hits, it writes a failed result, then kills its own process group, which it leads. That is one call, and it
    leaves no grandchild of the check running after the dispatch ends.
- **SIGTERM** (a cancel, below): the attempt kills its own group, then writes "cancelled" as not-now, or "done" if
  the action had already succeeded. A signal that arrives after the result is written does nothing.

**A live dispatch is the record, not the process.** A job has a live dispatch while `dispatch` is set. It is cleared
only when a result, or "ended without a result", is applied. The process is just how a dispatch ends. Nothing
dispatches a job that has a live dispatch.

**On each tick the daemon applies results.** It reads any result for the live dispatch, applies it to state, clears
`dispatch`, and then deletes the file. Applying is idempotent: state keeps `appliedDispatch`, and a result whose id is at or below
it is ignored. So a crash between applying and deleting changes nothing.

**A dispatch that ends without a result is a failure**, "ended without a result". It is one outcome for every way an
attempt can be lost: a bun upgrade breaking the import, unreadable stdin, an unwritable result dir, an OOM,
`kill -9`, or a wedge. The daemon detects it from what it already holds:

- **Process gone, no result:** the dispatched `pid` no longer runs with the recorded `lstart`, and no result file has
  appeared after a short grace for the final write. Then it is a failure.
- **Process alive past the deadline:** the attempt is wedged past its own timer. The daemon kills process group
  `pid`, but only while `lstart` still matches, so a reused pid is never killed. The next tick then sees "process
  gone, no result".

The dispatched process is identified by `pid` + `lstart`, which is all the daemon needs to tell whether it still
runs.

**A reservation without a `pid`** means the daemon died between spawning and recording. On the next tick, past a
grace measured from `dispatch.at`, it looks for the orphan with `ps -ax -o pid=,lstart=,command=`. It matches by whole argv tokens:
`--dispatch <id>` **and** `--nonce <nonce>`. The nonce makes the match unique across installs (a worktree or test
daemon has its own small ids), and token matching keeps `--dispatch 1` from matching `--dispatch 12`.
- **found:** the daemon adopts it and records its `pid` and `lstart`;
- **not found:** if a result exists, it is applied; otherwise it is "ended without a result" after the grace.

So a crash in that window never produces a second concurrent attempt or a reused id.

**Stale results.** Recording "ended without a result" for a dispatch also sets `appliedDispatch` to its id. Each
tick deletes result files with an id at or below `appliedDispatch`, including a result that landed after its
dispatch was already given up. A result above `appliedDispatch` that isn't the live dispatch can't arise after
reservation. If one appears, it is logged and left alone.

### Commands

- **`hydra jobs run <platform> <name>`** is a dispatch like any other, waited on in the foreground. The daemon reserves
  and spawns the same detached `jobs attempt … --dispatch <id> --nonce <n>` child the tick uses. The CLI waits for
  its result file and prints it, and the daemon applies it on its next tick. There is one attempt runner, so a manual
  run gets everything a scheduled one has: adoption after a daemon crash, the deadline kill, and the result
  surviving a closed terminal.
  - A manual run means "run now": it ignores owed state, backoff and `needs`, and skips overlap.
  - **For until-done jobs**, its success marks the latest slot done. **For plain jobs** it changes nothing about
    the schedule: it never sets `attemptedSlot`, so the scheduled slot is still attempted.
  - **Ctrl-C** sends SIGTERM to the attempt's group, and the attempt records "cancelled" (see above). A Ctrl-C before
    the daemon has answered the request cancels nothing: the CLI exits, and if the reservation was made, its
    attempt runs and reports as usual.
  - With a live dispatch, the daemon refuses with "already running".
  - With the daemon down, or without the clock lock, it refuses ("daemon not running", "clock not owned"). The daemon
    is the one source of decisions, and a dead daemon is the thing to fix.
- **`hydra jobs mark-done <platform> <name>`** asks the daemon to record a baseline: the latest slot is marked done
  without running anything. It is for cutovers and for an "owed (unconfirmed)" slot.
- **`hydra jobs sync <platform>`** validates jobs.toml and removes the old launchd entries.

**What this costs:** jobs need the daemon running to be *dispatched*, and their results are applied when it runs.
Spawn and main jobs need it anyway. A `mode = "none"` attempt that is already running survives a restart, and its
result waits on disk. The daemon is supervised, and it is the component that would report a failure anyway.

## Duplicate protection

The attempt writes its done result as soon as the spawn returns success. The only window for a duplicate is a crash
between those two steps: the dispatch then ends without a result and is retried.
Spawn uses the idempotency key `jobs-<name>-<slot label>`, which the daemon keeps for 24
hours (`DEFAULT_TTL_MS`), so a retry after such a crash is deduplicated. A manual `jobs run` uses a per-minute key, so
it is never swallowed by the slot's key.

**A duplicate-key answer is an outcome, not a rejection.** The daemon's `checkIdempotency` answers exit 2 for a key
it already holds:

- **`spawned` or `completed`:** the slot was served. Record **done**, absorbed by the existing session. This happens
  when the attempt that spawned died before writing its result.
- **`pending`:** record **not now**; the next tick sees how it ended.

Accepted residual, written down rather than hidden: if the daemon restarts in the middle of a spawn, the pending
idempotency key loads as failed, and a spawn that actually landed can be repeated once.

## State

Every file is written atomically (tmp + rename).

```ts
type JobState = {                 // jobs-state/<name>.json
  doneSlot?: string               // label of the latest done slot
  doneAt?: string                 // its success instant
  attemptedSlot?: string          // plain jobs: label of the latest attempted slot
  attemptedAt?: string            // plain jobs: its instant
  dispatch?: { id: number; nonce: string; at: string; slot: string; deadline: string;
               pid?: number; lstart?: string }   // set = a live dispatch; pid/lstart added after the spawn
  appliedDispatch?: number        // the last dispatch id whose result was applied
  failures?: number               // consecutive failures (backoff)
  failingSince?: string           // first failure since the last success; cleared on success
  last?: { at: string; result: 'done' | 'nothing' | 'failed'; note?: string; absorbedBy?: string;
           v0?: 'nothing' | 'findings' | 'failed' }   // v0: the original outcome of a translated record
  notNow?: { since: string; reason: string }   // the latest not-now, from any source; never overwrites `last`
  alertedFor?: string             // the failingSince already alerted for: alerted iff equal
  reportedDay?: string            // plain jobs: local date a failure was last reported
  announcedUnconfirmed?: string   // slot already announced as "owed (unconfirmed)"
  untilDone?: boolean             // set when the daemon first applies until-done rules (see Migration)
}

type DaemonState = {              // jobs-state/_daemon.json
  lastGoodConfig?: string
  configAlertDay?: string         // local date
  lastTick?: string
}
```

**What each outcome does:**

| Outcome | `doneSlot`/`doneAt` | `failures` | `failingSince` | Shown as |
|---|---|---|---|---|
| **Success:** done, nothing, absorbed, dup-hit served, baseline | set | 0 | cleared | done / nothing / "absorbed by <s>" / "baseline: no work ran" |
| **Failure:** failed, stuck, ended without a result | — | +1 | set if unset | failed, with the note ("previous session stuck: <kind>", "ended without a result") |
| **Not now:** needs unmet, no verdict yet, exit 75, dup-hit pending | — | — | — | "not now: <reason>" |

For plain jobs, success and failure also set `attemptedSlot` and `attemptedAt` (except a manual run), and not-now
doesn't.

`last.at` is the time of the last failure whenever `failures > 0`: not-now never touches `last` or `failures`, and
every reset to 0 is a success that also rewrites `last`.

## Alerts

An alert means the work keeps failing, not that it is late.

- **Until-done jobs.** One alert per failure run, sent when the latest outcome is a failure and
  `now − run start ≥ alert_after`. It is "alerted" iff `alertedFor` equals `failingSince`. A success
  ends the run, so the next failure run can alert, and the daemon never has to write anything to reset it.
  - Not-now neither starts nor ends a run. Being offline is never alerted.
  - Frequent jobs work too: an hourly sync failing for two days alerts once, because the clock measures the failing
    run, not the age of any one slot.
  - A job that fails whenever it's online and keeps dropping offline still alerts, and its backoff holds.
- **Plain jobs.** As today, one message per job per day while it is failing. Sent by the **daemon** on its tick,
  when `last.result` is failed (which includes "ended without a result") and `reportedDay` isn't today's
  **local** date. A plain job broken by a `brew upgrade` is therefore reported, not silent. The attempt sends
  nothing, so a 5-minute job can't post every 15 minutes through the deliver key's window.
- **Lateness itself is not alerted.** A slot stays owed while offline, then runs on reconnect. If staleness matters
  in the domain (a backup older than 2 days), the job's check reports it as a failure.

The daemon decides alerts on every tick from current state, so it never sends a stale queued message.

**Delivery:** alerts go to main through `deliver`. If main can't take one (no live main session, deliver refused),
it goes straight to a channel with `safeSend`: the job's own `channel` if set, else the jobs.toml top-level
`channel`, else the daemon's home channel. The stale-tick flag and the config-error alert always take that direct
path, because they report on the machinery main depends on.

**Why failures and not lateness:** a failure clock alerts on what is broken. A stuck session under `overlap` is a
failure, so it counts. A job that can be stuck in its own "not now" must say so with a failure exit, because exit 75
means "nothing is wrong, just not yet".

**The invariant this rests on:** while the machine is online, every owed state that persists either becomes a
failure or carries a reason you can see. Every state that could break it is covered:

| Persistent state | Covered by |
|---|---|
| hung attempt | its own deadline, then the daemon's kill |
| attempt that died, or never started | the dispatch ended without a result |
| stuck session, or one open across slots | overlap failure |
| probe blocked (VPN) | the gateway witness |
| config that won't parse | the daily config alert |
| dead tick | the health loop, which is separate from the job timer, flags a tick older than 5 minutes on the direct path |
| dead daemon | the watchdog |
| a job's own exit 75 | its reason, shown in `jobs list` |

## `jobs list`

Per job, in local time: next slot; owed or not, and since when; the last result with its note ("absorbed by <s>",
"baseline: no work ran", "not now: <reason>", "ended without a result"); failing since, if failing.
Above the list, the
clock's last tick.

## Migration

- **Existing jobs.toml files** parse and keep their behaviour: plain jobs, same outcomes, same daily failure message.
  **One deliberate change:** a plain job whose tool exits 75 used to be "failed, plus a daily message". It is now
  "not now": silent, and retried every tick until another result. `jobs list` shows it.
- **Today's records** (v0, `{at, outcome, note}`) are translated, not treated as unreadable or missing:
  `attemptedAt = at`; `attemptedSlot` = the latest slot at or before `at`;
  and `last = {at, result, note, v0: outcome}`,
  keeping the original outcome. Plain jobs don't fire at cutover, and PR 3's until-done rule below reads the
  translated `last.v0`.
- **A job with no record** gets a **baseline**: the daemon records the latest slot as done. Adding a job doesn't
  fire it mid-period. Use `jobs run` to start one now.
- **An unreadable record** is not "no record". The daemon records a failure ("state unreadable, reset"), so it is
  timed and alerted. Then:
  - for `none`, the slot stays owed and runs;
  - for spawn and main, it is "owed (unconfirmed)" and not run. A downgrade's schema mismatch is likelier than
    corruption, and the 24h key won't stop a second session.
- **Turning on `until_done`** is detected by the daemon: the job has `until_done` in jobs.toml, but its state lacks
  `untilDone: true`. At that moment the daemon decides the latest slot once, sets `untilDone: true`, and from then on
  the normal rules apply. The decision reads `last` in whatever format it is: `last.v0` if present (a translated old
  record), otherwise `last.result` (a run under the new runner). The slot counts as done only if `last.at` is after
  the slot's instant and:
  - for spawn and main, the action ran (`v0: findings`, or `result: done`);
  - for `none`, the work succeeded (`done` or `nothing`).

  A `nothing` after the slot on a spawn or main job is ambiguous, in either format: a script that gates itself also
  exits 0 when it is offline. That slot is "owed (unconfirmed)": shown in `jobs list`, announced once on the direct
  channel, and never run on its own, because for a spawn job a duplicate is the worst case. It waits for `jobs run`
  or `jobs mark-done`. A clear record decides on its own: a cutover on Friday 11:30 while offline, before the review
  ran, reads owed.
- **Renaming a job** gives it a baseline under the new name. The old `jobs:<old>` initiator no longer counts for
  overlap. Keep names stable, or follow a rename with `jobs run`.
- **Editing a schedule** needs no reset. The owed rule works with any schedule: the new schedule's latest slot is
  owed if it falls after the last success. A slot can therefore run twice on the day the schedule changes, which is
  accepted for a deliberate edit.
- **Scripts that read hydra's job state files** (for example, a check that reads `<name>.json`'s `outcome` to clear
  its own stamp) break at PR 2, when the format changes. They must move with PR 2. A script that misreads the new
  format can silently lose a slot.
- **Moving a self-gating job onto `until_done`** (an hourly schedule with a stamp file, becoming a weekly schedule
  with `until_done` and `overlap`) is **one edit**: schedule, keys, and the script's removal together. Overlap on the
  old hourly schedule would read the session as "still open" across slots two hours after each spawn.
- **Check scripts written for the old runner** should drop their own gating (stamps, internet probes, "print to
  spawn") and stop masking failures. A failed step exits nonzero, so the runner's failure clock times it. Only domain
  checks remain.

## Building it: three PRs, one concern each

1. **Local-time matcher**, plus fixing `jobs list` "next". This is a bug fix, useful on its own.
2. **The clock moves into the daemon.** Keeping today's behaviour without launchd already needs most of the
   machinery:
   - the clock-owner lock, retried each tick
   - plain-job owed state from the matcher, or the catch-up run on wake is lost
   - the daemon as the only writer, with v0 translation
   - two-phase dispatch: synchronous reserve, a nonce, adoption by argv
   - detached attempts that report result files, with deadlines, the action timeout and the group kill
   - `appliedDispatch`, the stale-result sweep, and "ended without a result" with the safe kill
   - the baseline
   - the definition on stdin
   - `jobs run` as a dispatch waited on in the foreground
   - the config alert and the direct path
   - plain-job messages sent by the daemon on local days
3. **Owed slots:** `until_done`, `needs` and the online witnesses, exit 75, `overlap` with pane-probe's verdict, the
   failure clock and alerts, `mark-done` and the unconfirmed migration, and `jobs list`.

## Tests

`jobsIO.now` is already injectable; the daemon clock takes an injectable timer. **Each rule and each table row above
has a test.** In addition, these cases a builder wouldn't derive from the rules:

- flights west and east, for a weekly and an hourly job;
- fall-back with a 5-minute schedule;
- a cutover on Friday 11:30 while offline;
- a reused pid at the daemon's liveness and kill checks;
- a daemon crash between spawning and recording the `pid`: the orphan is adopted by argv, never run twice;
- a `jobs run` request arriving while the tick is awaiting the probe: exactly one dispatch;
- two daemons starting at once: only one runs jobs; a restart whose old daemon is still exiting takes the clock on a
  later tick;
- an attempt from another install with the same name and id: never adopted (nonce);
- a late result after "ended without a result": deleted, not applied;
- Ctrl-C on `jobs run`: the attempt's group is killed, the result is "cancelled" (or "done" if the action had
  landed), and no work is left running;
- a closed terminal during `jobs run`: the attempt finishes and its result is applied;
- an attempt hitting its own deadline: its whole group is gone before the next dispatch;
- a daemon restart while an attempt runs: the result waits on disk and is applied once;
- a crash between applying a result and deleting it: no double apply;
- EPIPE: an attempt writing output after a daemon restart;
- a stuck session while in backoff;
- a job alternating between failure and not-now;
- a broken import (an attempt that ends without a result) for days, then an ordinary failure: one failure run with
  its original start.

## Out of scope

- Preconditions other than `internet`.
- Backfilling every missed slot (a job that needs every slot records its own coverage).
- `overlap = "wait"` (no current job needs it).
- Non-macOS hosts.
