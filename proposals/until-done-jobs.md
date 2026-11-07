# Until-done jobs

> Status: proposal v7, 2026-11-07. The user approved the direction. Shaped by the adversarial review (critic rounds
> 1–5) and an independent pass. For review before building.

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
- **Goal:** the one thing `until_done` toggles is **whether a failed attempt uses up the slot**.
  - A plain job gets one attempt per slot, whatever its result.
  - An `until_done` job is attempted while its slot is owed, with backoff, until it is done.
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

One timer per daemon (platform), every minute. A wall-clock jump larger than the interval (wake from sleep) is just
a tick that finds slots owed. Each tick:

1. **Reads jobs.toml.** If it doesn't parse, the daemon keeps running the last good config and alerts once a local
   day.
2. **Decides whether the machine is online:** the captive-portal probe (`captive.apple.com` returns "Success")
   **or** the daemon's gateway connection (gateway-health). Two independent witnesses: a VPN that blocks the probe
   can't make every job "not now" forever, and a captive portal (probe fails, gateway down) still reads offline.
3. **For each job,** computes the owed slot. Then it skips the job if the attempt lock is held, holds it if backoff
   says wait, and records not-now itself if `needs` is unmet or overlap has no verdict yet. Otherwise it decides
   overlap and dispatches.
4. **Checks dispatches that never started** (below) and **decides alerts** from current state.
5. **Records the tick.**

**Backoff:** after a failed attempt, the next waits min(2^n minutes, 1h, the schedule's period), measured from
`last.at`. Not-now re-probes every tick, because probing is cheap.

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

### Dispatch and the attempt

**The daemon decides; the attempt records.** The daemon picks the slot and decides overlap, because only it sees the
session table and pane-probe. It hands the attempt everything:

- the **resolved job definition** on stdin, so the attempt never reads jobs.toml, and a broken or mid-dispatch edit
  can't make it run something the daemon didn't evaluate;
- the **slot**, as `--slot <label>`, which the attempt records and never recomputes;
- the daemon's **never-started run**, if any, which the attempt folds into its own record (see State);
- a **record-only outcome** when there is no work to do: `--absorbed-by <s>`, `--stuck <s>` or `--baseline`. These
  write their result directly, with no marker, check or action.

**An attempt is a detached child:**
`lockf -k -t 0 <state>/jobs-state/<name>.lock bun hydra.ts jobs attempt <platform> <name> --slot … [outcome]`. It is
spawned detached (its own process group: `child_process.spawn(..., { detached: true })`; macOS has no `setsid`
command), so a daemon restart doesn't kill it.

- **Stdio:** stdin is a pipe carrying the job definition. Truncated or unparseable stdin is a recorded failure.
  stdout and stderr go to `jobs-state/<name>.log`, never to a pipe to the daemon, so the first write after a daemon
  restart can't hit EPIPE.
- **The lock is the only liveness witness.** The kernel holds it, and it is released when the process dies.
  "Running" means `lockf -t 0 <lock> true` exits 75 (`true` can't exit 75, so this is unambiguous). Dispatch,
  `jobs run` and the stale checks all use this probe, never `lockf`'s exit code from a real attempt.
- **The marker is metadata:** `running: {startedAt, slot, pgid, lstart}`, where `pgid` is `lockf`'s pid (the
  attempt's `process.ppid`, the group leader) and `lstart` is `ps -o lstart= -p <pgid>` read at start. It is written
  under the lock first thing, and cleared in the result write.
- **A marker present while the lock is free** means the previous attempt died (an OOM, `kill -9`, a crash). The next
  attempt, under the lock, records that as a failure ("previous attempt died") before starting. A dead plain
  attempt still uses up `running.slot`.
- **Deadlines:**
  - The action has a timeout of its own: `hydra spawn` and `deliver` are killed after 2 minutes.
  - The attempt enforces a hard deadline on itself: the check timeout (30m) + the action timeout + 2 minutes. When it
    hits, it records a failure and exits.
  - If an attempt is wedged past its own timer (the lock is held and the marker is past the deadline plus a
    margin), the daemon kills process group `pgid`, but only if `ps -o lstart= -p <pgid>` still matches `lstart`. A
    reused pid is never killed. The next attempt records the death.

**The daemon owns "did it start"; the attempt owns "how did it end".** At dispatch the daemon records
`dispatched: {at, slot, kind}`. The attempt can't report that it never ran, so the daemon does: past a 2-minute
grace, either of these is a **never-started** failure in the daemon's file:

- the lock is free and the attempt's file has nothing newer than `dispatched.at` (import broken by a bun upgrade,
  unwritable state dir, a baseline that never lands);
- the lock is held but no marker was written.

### Commands

- **`hydra jobs run <platform> <name>`** asks the daemon for a dispatch decision (slot and job definition), then runs
  the same attempt **in the foreground** under the same lock and prints its result.
  - A manual run means "run now": it ignores owed state, backoff and `needs`, and skips overlap.
  - With the lock held, it refuses with "already running".
  - With the daemon down, it refuses with "daemon not running". The daemon is the one source of decisions, and a
    dead daemon is the thing to fix.
  - Success marks the latest slot done.
- **`hydra jobs mark-done <platform> <name>`** dispatches a `--baseline` attempt: the latest slot is marked done
  without running anything. It is for cutovers and for an "owed (unconfirmed)" slot.
- **`hydra jobs sync <platform>`** validates jobs.toml and removes the old launchd entries.

**What this costs:** jobs need the daemon running to be *dispatched*. Spawn and main jobs need it anyway. A
`mode = "none"` attempt that is already running survives a restart. The daemon is supervised, and it is the
component that would report a failure anyway.

## Duplicate protection

The attempt marks the slot done as soon as the spawn returns success. The only window for a duplicate is a crash
between those two steps. Spawn uses the idempotency key `jobs-<name>-<slot label>`, which the daemon keeps for 24
hours (`DEFAULT_TTL_MS`), so a retry after such a crash is deduplicated. A manual `jobs run` uses a per-minute key, so
it is never swallowed by the slot's key.

**A duplicate-key answer is an outcome, not a rejection.** The daemon's `checkIdempotency` answers exit 2 for a key
it already holds:

- **`spawned` or `completed`:** the slot was served. Record **done**, absorbed by the existing session. This happens
  when the attempt that spawned died before writing.
- **`pending`:** record **not now**; the next tick sees how it ended.

Accepted residual, written down rather than hidden: if the daemon restarts in the middle of a spawn, the pending
idempotency key loads as failed, and a spawn that actually landed can be repeated once.

## State

One writer per file, so no update is lost. All are written atomically (tmp + rename).

```ts
type JobState = {                 // jobs-state/<name>.json: written only by the attempt, under its lock
  doneSlot?: string               // label of the latest done slot
  doneAt?: string                 // its success instant
  attemptedSlot?: string          // plain jobs: label of the latest attempted slot
  attemptedAt?: string            // plain jobs: its instant
  failures?: number               // consecutive failed attempts (backoff)
  failingSince?: string           // first failure since the last success; cleared on success
  running?: { startedAt: string; slot: string; pgid: number; lstart: string }
  last?: { at: string; result: 'done' | 'nothing' | 'failed'; note?: string; absorbedBy?: string }
  notNow?: { at: string; note: string }   // the job's own exit 75, or dup-hit pending; never overwrites `last`
}

type JobDaemonState = {           // jobs-state/<name>.daemon.json: written only by the daemon
  dispatched?: { at: string; slot: string; kind: 'attempt' | 'absorbed' | 'stuck' | 'baseline' }
  neverStarted?: { count: number; since: string; lastAt: string }
  notNow?: { since: string; reason: string }   // needs unmet, or no overlap verdict yet; nothing dispatched
  alertedFor?: string             // the failure-run start already alerted for: alerted iff equal
  reportedDay?: string            // plain jobs: local date a failure was last reported
  announcedUnconfirmed?: string   // slot already announced as "owed (unconfirmed)"
}

type DaemonState = {              // jobs-state/_daemon.json: daemon-wide
  lastGoodConfig?: string
  configAlertDay?: string         // local date
  lastTick?: string
}
```

**The never-started hand-off.** A job that never starts has no attempt file, so the daemon keeps the run in its own
file, and the failure clock reads both. When an attempt finally runs, the daemon passes `neverStarted` on stdin. The
attempt folds it in (`failures += count`, `failingSince = earlier of the two`) and writes the result. Only then
does the daemon clear its copy. A broken import that ran for 3 days and then turns into an ordinary failure keeps
its 3-day run.

**The failure clock**, computed from both files:

- consecutive failures = `failures` + `neverStarted.count`
- the run started at the earlier of `failingSince` and `neverStarted.since`
- the last failure was at the later of `last.at` (when `last.result` is failed) and `neverStarted.lastAt`

`last.at` is the time of the last failure whenever `failures > 0`: not-now never touches `last` or `failures`, and
every reset to 0 is a success that also rewrites `last`.

**What each outcome does:**

| Outcome | `doneSlot`/`doneAt` | `failures` | `failingSince` | Recorded in | Shown as |
|---|---|---|---|---|---|
| **Success:** done, nothing, absorbed, dup-hit served, baseline | set | 0 | cleared | attempt's file | done / nothing / "absorbed by <s>" / "baseline: no work ran" |
| **Failure:** failed, stuck, previous attempt died | — | +1 | set if unset | attempt's file | failed, with the note ("previous session stuck: <kind>", "previous attempt died") |
| **Never started** | — | `neverStarted.count` +1 | `neverStarted.since` if unset | daemon's file | "never started" |
| **Not now:** exit 75, dup-hit pending; needs unmet, no verdict | — | — | — | attempt's `notNow`; daemon's `notNow` | "not now: <reason>" |

For plain jobs, success and failure also set `attemptedSlot` and `attemptedAt`.

## Alerts

An alert means the work keeps failing, not that it is late.

- **Until-done jobs.** One alert per failure run, sent when the latest attempt failed (or never started) and
  `now − run start ≥ alert_after`. It is "alerted" iff the daemon's `alertedFor` equals the run's start. A success
  ends the run, so the next failure run can alert, and the daemon never has to write anything to reset it.
  - Not-now neither starts nor ends a run. Being offline is never alerted.
  - Frequent jobs work too: an hourly sync failing for two days alerts once, because the clock measures the failing
    run, not the age of any one slot.
  - A job that fails whenever it's online and keeps dropping offline still alerts, and its backoff holds.
- **Plain jobs.** As today, one message per job per day while its latest attempt has failed. Sent by the **daemon**
  on its tick, when `last.result` is failed and `reportedDay` isn't today's **local** date. The attempt sends
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
| hung attempt | its deadline, then the daemon's kill |
| attempt that died | the marker left behind |
| attempt that never started | the daemon's dispatch record |
| stuck session, or one open across slots | overlap failure |
| probe blocked (VPN) | the gateway witness |
| config that won't parse | the daily config alert |
| dead tick | the health loop, which is separate from the job timer, flags a tick older than 5 minutes on the direct path |
| dead daemon | the watchdog |
| a job's own exit 75 | its reason, shown in `jobs list` |

## `jobs list`

Per job, in local time: next slot; owed or not, and since when; the last result with its note ("absorbed by <s>",
"baseline: no work ran", "not now: <reason>", "never started"); failing since, if failing. Above the list, the
clock's last tick.

## Migration

- **Existing jobs.toml files** parse and keep their behaviour: plain jobs, same outcomes, same daily failure message.
  **One deliberate change:** a plain job whose tool exits 75 used to be "failed, plus a daily message". It is now
  "not now": silent, and retried every tick until another result. `jobs list` shows it.
- **Today's records** (v0, `{at, outcome}`) are translated, not treated as unreadable or missing:
  `attemptedAt = at`, and `attemptedSlot` = the latest slot at or before `at`. Plain jobs don't fire at cutover.
- **A job with no record** gets a **baseline**: the daemon dispatches `--baseline`, and the attempt (still the only
  writer) records the latest slot as done. Adding a job doesn't fire it mid-period. Use `jobs run` to start one now.
- **An unreadable record** is not "no record". The next attempt records a failure ("state unreadable, reset"), so it
  is timed and alerted. Then:
  - for `none`, the slot stays owed and runs;
  - for spawn and main, it is "owed (unconfirmed)" and not run. A downgrade's schema mismatch is likelier than
    corruption, and the 24h key won't stop a second session.
- **Turning on `until_done` for an existing job:** its latest slot is done only if the v0 record shows the work ran
  after that slot's instant:
  - for spawn and main, only `findings` counts;
  - for `none`, exit 0 counts.

  An old `nothing` after the slot is ambiguous: the old record holds only the latest run, and a gating script also
  exits 0 when it's offline. That slot is "owed (unconfirmed)": shown in `jobs list`, announced once on the direct
  channel, and never run on its own, because for a spawn job a duplicate is the worst case. It waits for `jobs run`
  or `jobs mark-done`. A clear record decides on its own: a cutover on Friday 11:30 while offline, before the review
  ran, reads owed.
- **Renaming a job** gives it a baseline under the new name. The old `jobs:<old>` initiator no longer counts for
  overlap. Keep names stable, or follow a rename with `jobs run`.
- **Editing a schedule** needs no reset. The owed rule works with any schedule: the new schedule's latest slot is
  owed if it falls after the last success. A slot can therefore run twice on the day the schedule changes, which is
  accepted for a deliberate edit.
- **Check scripts written for the old runner** should drop their own gating (stamps, internet probes, "print to
  spawn") and stop masking failures. A failed step exits nonzero, so the runner's failure clock times it. Only domain
  checks remain.

## Building it: three PRs, one concern each

1. **Local-time matcher**, plus fixing `jobs list` "next". This is a bug fix, useful on its own.
2. **The clock moves into the daemon.** Keeping today's behaviour without launchd already needs most of the
   machinery:
   - plain-job owed state from the matcher, or the catch-up run on wake is lost
   - the state files and their one-writer split, with v0 translation
   - the detached attempt: the lock probe, the marker, the deadlines and the action timeout
   - never-started detection and its hand-off
   - the baseline
   - the definition on stdin
   - `jobs run` in the foreground
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
- a reused pid at the daemon's kill check;
- a success landing between the daemon's alert decision and its write;
- EPIPE: an attempt writing output after a daemon restart;
- a stuck session while in backoff;
- a job alternating between failure and not-now;
- a never-started run followed by an ordinary failure, which keeps the run start and count.

## Out of scope

- Preconditions other than `internet`.
- Backfilling every missed slot (a job that needs every slot records its own coverage).
- `overlap = "wait"` (no current job needs it).
- Non-macOS hosts.
