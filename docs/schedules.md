# Schedules (formerly jobs)

A schedule is a clock that sends a message to a specialist. It's declared in `<state>/hydra.toml` under `[schedules.<id>]`: `cron` (5 fields, in local time or the schedule's `timezone`), `target` (`specialist:<name>`, or `main`; none makes it a sensor), `message`, and an optional `check` script whose output is appended (empty output sends nothing), run in `workdir` if set. See `signal-routing.md`'s `[schedules.<id>]`. A schedule's message carries the operator's authority; a failure alerts the operator: main is told, and when main is stuck on a prompt it cannot answer (a login, the usage-limit dialog), the channel is told too, naming the state. A run to a `sessions = "per-conversation"` specialist opens a new conversation for that slot: a fresh session in a new thread in the specialist's home_place, run as `jobs:<id>`.

```toml
[schedules.ledger-review]
cron = "0 11 * * FRI"
runner = "daemon"
needs = ["internet"]
check = "~/ledger/review-check.sh"
target = "specialist:ledger-review"    # a per-conversation specialist: each run, a fresh session in a new thread
```

**`<state>/jobs.toml` keeps running exactly as before until `hydra migrate` moves it** (start from [`jobs.example.toml`](jobs.example.toml)). Its jobs become `[schedules]`, a spawn job becomes a per-conversation specialist, and the file is kept as `jobs.toml.migrated`. Each schedule keeps its job's id, so its record (`jobs-state/<id>.state.json`), its covered slots and its launchd entry carry over. The migrate dry run shows each schedule's next slot, whether one is owed, its runner, where it goes and as whom.

`hydra schedules sync <platform>` has the daemon load them now and registers launchd ones; the daemon also re-registers them whenever hydra.toml changes. `schedules list` shows each one's runner, next run and last result (`paused` instead of a next run, for one with `paused = true`); `schedules run <platform> <name>` runs one now; `schedules mark-done` covers a daemon schedule's slot without running it. `hydra jobs …` is the same command, for now.

**Pausing a schedule.** `paused = true` keeps a `[schedules.<id>]` table in the file, validated like any other, without it ever firing. The daemon clock skips it, and covers each slot that passes, so unpausing starts at the next slot and never runs one missed while paused. For the launchd runner, `schedules sync` (which the daemon also runs whenever hydra.toml changes) unregisters its launchd entry, as for a removed schedule, and registers it again once the key is gone; an entry that is still loaded runs nothing and leaves no result. A paused schedule raises no failure alert. Its state file and any earlier result waiting for delivery are kept. `schedules run` still runs it once on request.

**A schedule's time zone.** `cron` is in the host's time zone unless the schedule sets `timezone = "Asia/Dubai"` (an IANA name), and then its slots are that zone's wall-clock times: `0 9 * * *` is 09:00 in Dubai every day, through either side's daylight-saving changes. A time that does not exist in the zone (a spring-forward gap) runs at the first instant after the gap; a time that happens twice (a fall-back) runs once, at its first occurrence. `schedules list` shows the next fire in the zone and in the host's time. **`timezone` needs `runner = "daemon"`**: a launchd calendar entry fires in the host's zone, so a zoned launchd schedule would have to be re-registered at every daylight-saving change, in the host's and in the zone's. hydra.toml refuses it with that reason, and so refuses a name the runtime does not know, naming the key.

**A job's `runner` decides what triggers it; delivery to a session is always the daemon's.** Both are on time when all is well. They differ only when something fails:

| | `launchd` (default) | `daemon` |
|---|---|---|
| Depends on hydra running? | no | yes |
| After a failure | one shot: the next slot tries again | keeps trying until done |

In one line: **launchd tries once, no matter what. daemon keeps trying, as long as hydra runs.** Set `runner` at the top of the file for every job, or on a job to override that. With neither, it's `launchd`.

Take a weekly job, `weekly-review`, due Friday 11:00:

| On Friday at 11:00… | `launchd` | `daemon` |
|---|---|---|
| the lid is shut until 14:00 | runs at 14:00 on wake, once | runs at 14:00 on wake, once |
| Wi-Fi is down | runs, fails, and is gone until next Friday | waits (`needs = ["internet"]`), and runs when you're back online |
| the check hits an API error | fails, alerts, and is gone until next Friday | retries with back-off; you're told only if it's still failing after `alert_after` |
| the hydra daemon is down | the check runs at 11:00; its output is delivered once hydra is back | waits for the watchdog to restart hydra (~5 min), then runs |
| bun was just upgraded | keeps working | keeps working |

- **Pick `daemon`** for obligations: a review that has to happen this week, a backup that has to succeed eventually.
- **Pick `launchd`** for keepalives and probes, where the next run makes up for a missed one, or for anything that must run while hydra itself is broken.

A launchd job's entry is registered by `schedules sync` and runs a stable bun link, never a versioned Cellar path, which `brew upgrade` deletes. `needs` and `alert_after` need `runner = "daemon"`.

The daemon also expects every launchd slot to report. A slot with no result 35 minutes after it (a check's 30-minute limit plus slack, counted in awake time, so a sleep extends it) is a failure, `no report for <slot>`, one per missed slot, and it is alerted like any launchd failure. That is how a broken checkout, an unloaded entry, a moved bun or a macOS permission denial shows up: as silence otherwise. The watch restarts at the latest slot whenever it was not continuous, so a slot nobody was watching is never counted: the machine was asleep or off, the daemon was down, the schedule was out of hydra.toml for a while, or its cron changed (launchd runs a slept-through slot on wake). A late result clears the failure unless a later slot is still missed.

**Nothing changes unless you opt in.** An existing file runs under launchd as before. The old runner's entries keep working until `schedules sync` moves them onto the stable bun path, and `schedules list` flags any that remain. `schedules sync` registers and unregisters launchd entries only for the platform's live state dir, and removes one only when its job leaves the file or moves to `runner = "daemon"`.

Known and accepted for daemon-runner jobs: in the hour the clocks fall back, a frequent job (`*/5`) pauses for about an hour, once a year. Flows: [`flow-jobs-dispatch.mmd`](diagrams/flow-jobs-dispatch.mmd) (a daemon-runner slot), [`flow-jobs-launchd.mmd`](diagrams/flow-jobs-launchd.mmd) (a launchd-runner slot), [`flow-jobs-sync.mmd`](diagrams/flow-jobs-sync.mmd).
