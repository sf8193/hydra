# Schedules

A schedule is a clock that sends a message to a specialist. It is declared in `<state>/hydra.toml` under `[schedules.<id>]`: `cron` (5 fields, local time or the schedule's `timezone`), `target` (`specialist:<name>` or `main`), `message`, and an optional `check` script whose output is appended (empty output sends nothing). A schedule's message carries the operator's authority, and a failure alerts the operator. A run to a `sessions = "per-conversation"` specialist opens a fresh session in a new thread each time. Every key is in [`hydra.example.toml`](../hydra.example.toml).

```toml
[schedules.ledger-review]
cron = "0 11 * * FRI"
runner = "daemon"
needs = ["internet"]
check = "~/ledger/review-check.sh"
target = "specialist:ledger-review"    # a per-conversation specialist: each run, a fresh session in a new thread
```

**Old `jobs.toml`** keeps running as before until `hydra migrate` moves it (see [`jobs.example.toml`](../jobs.example.toml)). Each job becomes a schedule with the same id, so its state and launchd entry carry over, and the dry run shows each schedule's next slot and runner.

**Commands.** `hydra schedules sync <platform>` loads them now and registers launchd ones (the daemon also does this whenever hydra.toml changes). `schedules list` shows each one's runner, next run and last result; `schedules run <platform> <name>` runs one now; `schedules mark-done` covers a daemon schedule's slot without running it.

- **Pausing:** `paused = true` keeps the table, validated, without it ever firing. Unpausing starts at the next slot and never runs one missed while paused.
- **Time zone:** `timezone = "Asia/Dubai"` (an IANA name) makes `cron` that zone's wall-clock time. It needs `runner = "daemon"`. A time that does not exist (spring forward) runs just after the gap; one that happens twice runs once.

## `runner`

The runner decides what triggers a schedule; delivery to a session is always the daemon's. **`launchd` (the default) tries once, whatever happens. `daemon` keeps trying, as long as hydra runs.**

| On Friday at 11:00… | `launchd` | `daemon` |
|---|---|---|
| the lid is shut until 14:00 | runs at 14:00 on wake, once | runs at 14:00 on wake, once |
| Wi-Fi is down | runs, fails, and is gone until next Friday | waits (`needs = ["internet"]`), runs when you're back online |
| the check hits an API error | fails, alerts, gone until next Friday | retries with back-off; you're told only if it still fails after `alert_after` |
| the hydra daemon is down | the check runs; its output is delivered once hydra is back | waits for the watchdog to restart hydra, then runs |

Pick `daemon` for obligations (a review that has to happen this week); pick `launchd` for keepalives and probes, or anything that must run while hydra itself is broken. `needs` and `alert_after` need `runner = "daemon"`.

The daemon expects every launchd slot to report: a slot with no result 35 minutes after it is a failure (`no report for <slot>`), which is how a broken checkout, an unloaded entry or a macOS permission denial shows up instead of silence. Slots nobody was watching (the machine asleep, the daemon down) are never counted.

Flows: [`flow-jobs-dispatch.mmd`](../diagrams/flow-jobs-dispatch.mmd) (a daemon slot), [`flow-jobs-launchd.mmd`](../diagrams/flow-jobs-launchd.mmd) (a launchd slot), [`flow-jobs-sync.mmd`](../diagrams/flow-jobs-sync.mmd).
