# Durable jobs

> Status: proposal, 2026-11-07. Approved in direction by the user; this spec is for review before building.

## The problem

`hydra jobs` treats "the cron fired" as "run it now". launchd fires each job at its time, or once on wake if the
machine slept through it, and the job runs once. That merges four questions:

1. **When is the job owed?** The schedule.
2. **When can it run?** Preconditions, for example being online.
3. **What counts as done?** A spawn accepted, a check that succeeded.
4. **When should the user hear about it?** Alerts.

Because hydra answers only the first, check scripts answer the rest themselves. In practice a job on a laptop:

- **Fires on wake before Wi-Fi is up.** It fails, and the next chance is the next slot. For a weekly job, that loses a week.
- **Reports failure while offline.** A user travelling gets a failure message for something that isn't broken.
- **Keeps a stamp file of the slot it last handled,** to retry within a slot without running twice. Hydra can't help,
  because a check's exit 0 means both "done" and "couldn't run, skip".
- **Can't tell whether the spawn worked.** The check prints, hydra spawns afterwards, and only hydra knows if that
  spawn failed. A script that stamps "handled" before printing loses the slot when the spawn fails.

Each of those scripts is compensating machinery for a missing concept in the runner.

## The concept: the owed slot

A schedule defines **slots**: the local wall-clock instants its cron expression matches.

- A job is **owed** for the latest slot at or before now, unless that slot is already **done**.
- A **durable** job stays owed until an attempt succeeds. It is retried on every tick while owed.
- A plain job (today's behaviour) is attempted once per slot, whatever the outcome.
- **Missed slots collapse:** only the latest slot can be owed. A machine that was off for a week runs a weekly job
  once, not seven times.

Every job lands in one of three shapes, made from the same keys; there is no `kind` setting:

| Shape | Example | Keys |
|---|---|---|
| Obligation: once per slot, a duplicate or a miss is an error | weekly review session | `durable`, `overlap`, `alert_after` |
| Convergence: keep something true; repeating is harmless | hourly backup sync | `durable`, frequent `schedule`, `alert_after` |
| Probe: look and report | dependency scan | none (today's behaviour) |

**The line between hydra and the job:** hydra owns *liveness* (is the job running and succeeding?). The job owns its
*domain* (is the thing it watches healthy?). A sync job can succeed every hour while the server it copies from
stopped producing backups; detecting that stays in the check, as an ordinary failure exit.

## Configuration

New optional keys. A job without them behaves as today.

```toml
[weekly-review]
schedule = "0 11 * * FRI"
mode = "spawn"
prompt = "..."
durable = true           # owed until an attempt succeeds; retried each tick
needs = ["internet"]     # don't attempt until met; not an attempt, not a failure
overlap = "absorb"       # spawn only: an open session from this job handles the owed slot
alert_after = "1d"       # durable only: alert if still owed this long after the slot

[backup-pull]
schedule = "0 * * * *"
mode = "none"
check = "~/scripts/backup-pull.sh"
durable = true
needs = ["internet"]
alert_after = "2d"
```

| Key | Values | Default | Applies to |
|---|---|---|---|
| `durable` | boolean | `false` | all modes |
| `needs` | array of precondition names; v1 knows only `"internet"` | `[]` | all modes |
| `overlap` | `"absorb"` \| `"wait"` \| `"allow"` | `"allow"` | `spawn` only |
| `alert_after` | duration (`90m`, `12h`, `2d`; at most `30d`) | `"1d"` when `durable` | `durable` only |

Validation follows `parseJobs`' style: unknown precondition names, `overlap` on a non-spawn job, and `alert_after`
without `durable` are config errors.

## The check contract

| Exit | Meaning | Effect on the slot |
|---|---|---|
| `0` | Done. Stdout, if any, is findings: spawn/main jobs pass them to the agent. | The attempt continues to the action; if the action succeeds, the slot is done. |
| `75` (`EX_TEMPFAIL`) | Not now: a job-specific precondition isn't met. | Not an attempt and not a failure. A durable job stays owed; a plain job's slot is dropped. |
| anything else | Failed attempt. | A durable job stays owed; a plain job's slot is dropped. |

For a job with a check, "the action" is the spawn or main delivery when output was printed; with no output, or for
`mode = "none"`, a check exit 0 is itself success. A job without a check has only the action.

Exit 75 is the general form of `needs`. `needs = ["internet"]` is the built-in for the precondition nearly every
laptop job has, so scripts don't each reimplement it.

## The clock

**One tick replaces one launchd entry per job.** `hydra jobs sync` registers a single launchd entry that runs the
tick every minute and removes the per-job entries. launchd runs a missed tick once on wake.

Each tick, for each job:

1. Compute the latest slot at or before now, in **local time**. (`Bun.cron.parse` evaluates in UTC: on a
   `America/Los_Angeles` machine, `0 11 * * FRI` returns 03:00 local. Slot math must not use it as-is; `jobs list`
   "next" has the same bug today.)
2. If the slot is done, or is a plain job's slot that was already attempted, skip.
3. If the job is running (a per-job lock held by a live pid), skip. A check can run up to 30 minutes; ticks must not
   stack attempts.
4. If a `needs` entry is unmet, record "deferred: <need>" and skip.
5. For `overlap = "absorb"`: if a session with initiator `jobs:<name>` is open, mark the slot done and skip.
   For `"wait"`: if one is open, record "deferred: previous session open" and skip.
   If the session list itself fails, that is a failed attempt, never "none open".
6. Attempt: run the check, then the action. Record the outcome. On success, mark the slot done.
7. Alert (below).

`hydra jobs run <platform> <name>` attempts the job now, ignoring whether a slot is owed. Success marks the latest
slot done.

### Slot identity

A slot is identified by its **local wall-clock label**, `YYYY-MM-DD HH:MM`, not by an epoch. The latest slot is owed
only if its label sorts **after** the label of the last done slot.

This makes travel safe. A weekly slot done at Friday 11:00 in Berlin is labelled `2026-11-13 11:00`. After a flight
to California the same day, the local latest slot is `2026-11-13 11:00` again, so nothing is owed. Flying east never
produces an earlier label that sorts after.

DST:

- **Fall-back:** an ambiguous local time occurs twice but has one label, so it runs once.
- **Spring-forward:** a nonexistent local time maps to the first instant after the gap.

### Duplicate protection

A spawn or main delivery uses the idempotency key `jobs-<name>-<slot label>`, and the slot is marked done as soon as
the action returns success. The daemon remembers keys for 15 minutes. If hydra crashes between the action and the
record, a tick within that window is deduplicated. A crash followed by more than 15 minutes of downtime can still
repeat the action once. This residual at-least-once window is accepted and documented, not hidden.

## Alerts

- **Plain jobs:** unchanged: a failed attempt posts one "job failed" message per job per day.
- **Durable jobs:** individual failed or deferred attempts are recorded and stay quiet. One alert is posted per slot
  when the slot is still owed `alert_after` past its instant. It names how long the slot has been owed, the last
  attempt's outcome and note, and any unmet need.
- **Offline:** the alert is evaluated after the tick's attempt, so a machine coming back online first tries the
  work. It alerts only if the slot is still owed. An alert that can't be delivered stays pending and is retried on
  later ticks, so it arrives once the machine reconnects.

## State

Today's per-job record (`jobs-state/<name>.json`) is overwritten every run. It becomes:

```ts
type JobState = {
  last?: { at: string; outcome: 'nothing' | 'findings' | 'failed' | 'deferred'; note?: string }
  doneSlot?: string        // label of the latest done slot
  attemptedSlot?: string   // plain jobs: label of the latest attempted slot
  alertedSlot?: string     // durable jobs: label of the slot already alerted for
}
```

The write stays atomic (tmp + rename). The per-job lock is `jobs-state/<name>.lock` holding a pid; a lock whose pid
is dead is stale and taken over.

## `jobs list`

Per job, in local time: next slot, whether a slot is owed (and since when), last attempt and outcome, and the
deferral reason if deferred.

## Migration

- Existing jobs.toml files parse and behave as before: same outcomes, same failure messages.
- The first tick after `sync` treats a job with no `doneSlot` as having done its latest slot. Enabling `durable` on
  an existing job therefore doesn't fire it mid-period. A new durable job first runs at its next slot. To run one
  now, use `hydra jobs run`.
- `sync` removes the per-job launchd entries and adds the tick entry. `jobs.example.toml` gains a durable example.

## Tests

`jobsIO.now` is already injectable. Cover:

- **Slot computation** in a non-UTC zone, both DST transitions, Friday before and after the slot minute, and the
  label comparison across time-zone changes.
- **Durable retry:** a failed attempt, then a later tick succeeds and the slot is done; no attempt after done.
- **Collapse:** a gap spanning several slots yields one attempt.
- **Exit 75 and `needs`:** recorded as deferred, no failure message, the slot still owed.
- **`overlap`:** absorb marks done, wait defers, and a failing session list is a failure.
- **A failed spawn** leaves the slot owed. This is the case check scripts currently get wrong.
- **Alerts:** quiet inside `alert_after`, exactly one alert past it, and none if the tick's attempt succeeds first.
  An undeliverable alert is retried.
- **Lock:** a second tick while the job runs doesn't attempt; a stale lock is taken over.
- **Plain jobs:** unchanged behaviour, including the once-a-day failure message.
- **Migration:** a job with no state doesn't fire mid-period.

## Out of scope

- Preconditions other than `internet` (add them as named needs when a second one is real).
- Backfilling missed slots (a job that needs every slot should record its own coverage, the way a weekly review covers
  everything since the last one).
- Non-macOS schedulers.
