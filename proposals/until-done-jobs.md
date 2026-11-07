# Until-done jobs

> Status: proposal v4, 2026-11-07. The user approved the direction. Shaped by the adversarial review (critic rounds 1–2)
> and an independent pass. For review before building.

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
- **Owed:** the latest slot at or before now is owed when its instant is after the last success's instant **and**
  its label differs from the last done slot's label (see Slots in local time). Missed slots collapse: only the latest
  can be owed, so a week offline runs a weekly job once, not seven times.
- **Attempt:** one run of the job's work. Its result is `done`, `nothing to do` (counts as done), or `failed`.
- **Not now:** a precondition isn't met (`needs`, exit 75). It is **not an attempt** and never uses up a slot, for any
  job.
- **Goal:** a plain job gets one attempt per slot, whatever its result. An `until_done` job is attempted while its
  slot is owed, with backoff, until it is done.
- **Done for spawn jobs** means the daemon accepted the spawn. Whether the session then does its work is session
  health (pane-probe, idle-limit), not job state. The two meet only at `overlap` (below).

Naming: not "durable". In durable execution and durable queues, that word means work that survives a crash and
resumes where it stopped. Here a failed attempt is simply retried from the start. The setting is named for its rule.

**The line between hydra and the job:** hydra owns *liveness* (is the work happening and succeeding?). The job owns
its *domain* (is the thing it watches healthy?). A sync can succeed every hour while the server it copies from has
stopped producing backups; detecting that stays in the job, as an ordinary failure exit.

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
| `until_done` | boolean | `false` | retry each tick while the slot is owed |
| `needs` | names; v1 knows `"internet"` | `[]` | unmet → "not now", checked before the work |
| `overlap` | `"absorb"` | unset | spawn only: an open, healthy session from this job counts as done for the owed slot; a stuck one is a failed attempt |
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

The action's own result decides the attempt: a spawn or delivery the daemon rejects is a failed attempt, and the
slot stays owed. That is the case that check scripts cannot handle today, because the spawn happens after they exit.

Exit 75 (`EX_TEMPFAIL`) is the general form of `needs`. `needs = ["internet"]` is built in because nearly every laptop
job has that precondition. A plain job whose tool leaks exit 75 shows "not now" in `jobs list`, not silence.

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
- **Wrong times.** `Bun.cron.parse` evaluates in UTC (`0 11 * * FRI` gives 03:00 on a Los Angeles machine), so
  `jobs list` shows wrong "next" times.

The daemon is already the always-on part of hydra. It is watched by the watchdog, and it already runs periodic work
(pr-watch, idle-limit, gateway-health).

**So the daemon owns the clock, and attempts run on their own.** The daemon restarts often, so an attempt must
not die with it.

- **One timer per daemon (platform),** every minute. It reads jobs.toml, decides whether the machine is online,
  computes each job's owed slot, and dispatches owed attempts. A wall-clock jump larger than the interval (wake from
  sleep) is just a tick that finds slots owed.
- **Online** means the captive-portal probe (`captive.apple.com` returns "Success") **or** the daemon's gateway
  connection is up (gateway-health). Two independent witnesses: a VPN or firewall that blocks the probe can't make
  every job "not now" forever, and a captive portal (probe fails, gateway down) still reads offline.
- **The daemon decides; the attempt records.** The daemon picks the slot and evaluates overlap at dispatch, because
  only it can see the session table and pane-probe's stuck states. It passes the decision to the attempt:
  `jobs attempt <platform> <name> --slot <label> [--absorbed-by <session> | --stuck <session>]`. The attempt records
  the slot it was given and never recomputes it.
- **An attempt is a detached child:** `lockf -k -t 0 <state>/jobs-state/<name>.lock bun hydra.ts jobs attempt …`,
  spawned detached (its own process group: `child_process.spawn(..., { detached: true })`; macOS has no `setsid`
  command) so a daemon restart doesn't kill it.
  - The kernel holds the lock, and it is released when the process dies, so no pid file and no pid reuse.
  - The daemon ignores `lockf`'s exit code: a busy lock and the job's own exit 75 look alike. Busy is read from the
    `running` marker instead.
  - **Under the lock, first:** if a `running` marker from an earlier attempt is still there, that attempt died. A
    bun upgrade breaking import, an OOM, or `kill -9` all leave the marker. Record it as a **failed** attempt
    ("previous attempt died") before starting.
  - **Then** write `running: {startedAt, slot, pid}`, run the check (30m timeout) and the action (its own timeout),
    and write the result. The marker is cleared in the same write.
  - **A hard deadline:** check timeout + action timeout + 2 minutes. The attempt enforces it on itself: it records a
    failure and exits.
  - **The daemon's own deadline check:** if a `running` marker is older than the deadline plus a margin, the attempt
    is wedged past its own timer. The daemon kills its process group, which releases the lock, and the next attempt
    records "previous attempt died". So a hung spawn can't hold a job silently.
- **`hydra jobs run <platform> <name>`** goes through the daemon, so overlap is decided the same way, and runs the
  same attempt under the same lock. It can't race the clock. It runs now whatever is owed; success marks the latest
  slot done.
- **Backoff.** After a failed attempt, the next one waits min(2^n minutes, 1h, the schedule's period). "Not now"
  re-probes every tick, because probing is cheap.
- **Overlap** counts only connected sessions with initiator `jobs:<name>`. Which of them may absorb:
  - **Stuck:** the attempt **fails** ("previous session stuck"), so `failingSince` starts and the alert fires. A
    session stuck on a prompt must not turn into silent success.
  - **Not yet probed:** a session pane-probe hasn't seen clean since the daemon started (its stuck map starts empty)
    is "not now" until it has been, which takes about 2 minutes.
  - **Spawned before the previous slot:** a session open across two slots is not doing the work. It is a failure
    ("session from <label> still open"). Only a session spawned after the previous slot's instant may absorb.
- **`jobs sync`** validates jobs.toml and removes the old launchd entries. The daemon rereads jobs.toml each tick.
  If it doesn't parse, the daemon keeps the last good config and alerts once a day.
- **Watching the watcher:** the daemon records its last tick. `jobs list` shows it. The daemon's health loop, which
  is separate from the job timer, flags a tick older than 5 minutes through the direct channel (see Alerts). If the
  daemon itself is down, the watchdog already reports that.

**What this costs:** jobs need the daemon running to be *dispatched*. Spawn and main jobs need it anyway. A
`mode = "none"` attempt that is already running survives a restart. The daemon is supervised, and it is the
component that would report a failure anyway.

## Slots in local time

- **The matcher.** Hydra needs a local-time cron matcher that finds the latest match at or before a given instant.
  `Bun.cron.parse` only finds the next match, and in UTC. The matcher is a small pure function with its own tests.
  The same matcher fixes `jobs list`.
- **Owed = after the last success, and a different label.** A slot's label is its local wall-clock time,
  `YYYY-MM-DD HH:MM`. The latest slot is owed iff its **instant** is after the last success's instant **and** its
  **label** differs from the last done slot's label.
  - The label stops the double Friday: done at 11:00 in Berlin, then in California the same day, the slot
    `2026-11-13 11:00` is later as an instant but has the same label, so it isn't owed.
  - The instant keeps frequent jobs moving. An hourly job done at Berlin 15:00 is owed again at 08:00 in California,
    a later instant with a different label. Comparing labels by sort order would stall it for 9 hours.
  - State therefore keeps both the done label and the success instant.
- **DST.** A fall-back time occurs twice but has one label, so it runs once. A spring-forward time that doesn't
  exist runs at the first instant after the gap, under its nominal label.

## Duplicate protection

The attempt marks the slot done as soon as the spawn returns success. The only window for a duplicate is a crash
between those two steps. Spawn uses the idempotency key `jobs-<name>-<slot label>`, which the
daemon keeps for 24 hours (`DEFAULT_TTL_MS`). A retry after such a crash is deduplicated, so the slot can't be spawned
twice. A manual `jobs run` uses a per-minute key, so it is never swallowed by the slot's key.

## Alerts

An alert means the work keeps failing, not that it is late.

- **Until-done jobs.** `failingSince` is the time of the first failed attempt since the last success; success clears
  it. One alert is sent when the latest attempt failed and `now − failingSince ≥ alert_after`. Then quiet until a
  success, after which a new failing run can alert again.
  - "Not now" (`needs`, exit 75) neither starts nor clears `failingSince`. Being offline is never alerted.
  - This works for frequent jobs too: an hourly sync failing for two days alerts once, because it measures the
    failing run, not the age of any one slot.
- **Plain jobs.** As today: a failed attempt posts one message per job per day. The reported day is stored on its
  own, so a later "nothing" or "not now" record can't reset it.
- **Lateness itself is not alerted.** A slot stays owed while offline, then runs on reconnect. If staleness matters
  in the domain (a backup older than 2 days), the job's check reports it as a failure.

The daemon decides about alerts on every tick from the current state, so it never sends a stale queued message.

**Delivery:** alerts go to main through `deliver`. If main can't take one (no live main session, deliver refused),
it goes straight to the channel with `safeSend`: the jobs.toml top-level `channel`, else the daemon's home channel.
The stale-tick flag and the config-error alert always take that direct path, because they report on the machinery
main depends on.

**The invariant this rests on:** while the machine is online, every owed state that persists either becomes a
failure or carries a reason you can see. The states that could break it are each covered:
- a hung attempt: the deadline makes it a failure;
- a dead attempt: the stale marker becomes a failure;
- a stuck session, or one open across slots: a failure;
- the probe blocked by a VPN: the gateway witness;
- an unparseable config: the daily alert;
- a dead tick: the health loop.

"Not now" from a job's own exit 75 is the job's declared reason, shown in `jobs list`.

Why the alert clock counts failures, not lateness: lateness (an `owedSince` clock) would alert after every trip,
because a slot owed while offline is late but nothing is wrong. Counting failures alerts on what is broken. That
includes a stuck session under `overlap`, which is a failed attempt. A job that can be stuck on its own "not now"
must say so with a failure exit; exit 75 means "nothing is wrong, just not yet".

## State

One writer per file, so no update is lost; both are written atomically (tmp + rename):

- `jobs-state/<name>.json`: written **only by the attempt**, under its lock.
- `jobs-state/<name>.alert.json`: written **only by the daemon**.

```ts
type JobState = {                 // <name>.json, the attempt's
  doneSlot?: string               // label of the latest done slot
  doneAt?: string                 // instant of the success that did it
  attemptedSlot?: string          // plain jobs: label of the latest attempted slot
  attemptedAt?: string            // plain jobs: its instant (the owed rule needs instant + label for plain jobs too)
  failures?: number               // consecutive failed attempts, for backoff
  failingSince?: string           // first failed attempt since the last success; cleared on success
  running?: { startedAt: string; slot: string; pid: number }
  last?: { at: string; result: 'done' | 'nothing' | 'not-now' | 'failed'; note?: string; absorbedBy?: string }
}
type AlertState = {               // <name>.alert.json, the daemon's
  alertedFor?: string             // the failingSince value already alerted for: alerted iff equal
  reportedDay?: string            // plain jobs: the day a failure was last reported
}
```

A success clears `failingSince`, so the stored `alertedFor` stops matching and the next failing run can alert,
without the daemon writing anything.

## `jobs list`

Per job, in local time: next slot; owed or not, and since when; last attempt and its result ("absorbed by <session>"
when overlap applied); failing since, if failing. Above the list, the clock's last tick.

## Migration

- Existing jobs.toml files parse and keep their behaviour: plain jobs, same outcomes, same daily failure message.
- **An until-done job** counts its latest slot as done only if its existing record shows the work ran after that
  slot's instant:
  - For spawn and main jobs, only an old `findings` record counts, because that is when the action ran. An old
    `nothing` is ambiguous: a gating script also exits 0 empty when it is offline.
  - For `mode = "none"`, exit 0 counts.

  So switching while a slot is really owed (sync on Friday 11:30 while offline, before the review ran) leaves it owed.
- **Editing a schedule** needs no reset. The owed rule works with any schedule: the new schedule's latest slot is
  owed if it falls after the last success. A slot can therefore run twice on the day the schedule changes, which is
  accepted for a deliberate edit.
- **Check scripts written for the old runner** should drop their own gating (stamps, internet probes, "print to
  spawn") and stop masking failures. A failed step exits nonzero, so the runner's failure clock times it. Only domain
  checks remain.
- **A brand-new job with no record** counts its latest slot as done, so adding a job doesn't fire it mid-period. Use
  `jobs run` to start one now.

## Building it: three PRs, one concern each

1. **Local-time matcher** plus fixing `jobs list` "next". This is a bug fix, useful on its own.
2. **The clock moves into the daemon,** with today's semantics unchanged. `jobs sync` removes the launchd entries and
   `jobs run` becomes a daemon command.
3. **Owed slots:** `until_done`, `needs`, exit 75, `overlap`, the alert rules, the new state, and `jobs list`.

## Tests

`jobsIO.now` is already injectable; the daemon clock takes an injectable timer.

- **Matcher:** a non-UTC zone, both DST transitions, Friday before and after the slot minute, labels across time
  zones, and the latest match for every field kind (lists, ranges, steps, day-of-week).
- **Until-done:** a failure then a success; no attempt after done; collapse across a long gap; a failed spawn leaves
  the slot owed; a check that exits 0 with no output is done with no spawn; a job with no check runs its action.
- **Not now:** `needs` unmet and exit 75 are both recorded as not-now, keep the slot owed, and leave `failingSince`
  alone.
- **Alerts:** quiet inside `alert_after`; exactly one alert past it; none if the attempt succeeds first; an hourly job
  failing for two days alerts once; offline time never alerts.
- **Overlap:** a connected, probed, clean session spawned after the previous slot absorbs. A disconnected one
  doesn't. A not-yet-probed one is not-now. A stuck one, or one open across slots, is a failure.
- **Dead and hung attempts:** a stale `running` marker becomes a failure on the next attempt. A wedged attempt past
  its deadline is killed by the daemon.
- **Online witness:** the probe blocked with the gateway up reads online. Probe down with the gateway down reads
  offline.
- **Delivery:** with main dead, an alert goes to the channel. A broken jobs.toml alerts once a day and keeps the
  last good config.
- **One writer:** a success between the daemon's alert decision and its write can't resurrect the failing run.
- **Concurrency:** a tick while the job runs doesn't start a second attempt. A manual run while the job runs is
  refused with "already running". An attempt survives a daemon restart and records its result.
- **Backoff:** the waits between failed attempts, capped at the schedule's period. "Not now" doesn't back off.
- **Owed rule:** weekly and hourly jobs, flying west and flying east, and fall-back with a 5-minute schedule.
- **Stuck session under overlap:** a failed attempt, and an alert after `alert_after`.
- **Clock heartbeat:** a stale heartbeat shows in `jobs list` and in daemon health.
- **Plain jobs:** unchanged, including one message a day across a mix of results.
- **Migration:** the Friday-11:30 case stays owed; a new job doesn't fire mid-period.

## Out of scope

- Preconditions other than `internet`.
- Backfilling every missed slot (a job that needs every slot records its own coverage).
- `overlap = "wait"` (no current job needs it).
- Non-macOS hosts.
