# flow-slack-owed: where each box comes from

Checked against code at 42721c5. Bold names are README's core abstractions or the routing names in diagrams/README.md.

| Box or edge | Source | What the line shows |
|---|---|---|
| Owed: saved to disk | `connectors/slack/watch.ts:122-123`, `:923-927` | `owed` persisted before anything is sent |
| replayed by each Catch-up pass | `connectors/slack/catchup.ts:176-183`; `connectors/slack/watch.ts:645-648` | step 1 of every pass, deep or not: `owedHints` from `owed[0]` |
| flushed or replayed → delivered | `connectors/slack/watch.ts:929-936`, `:1265-1266`, `:1219-1228` | `settle` moves the ts from `owed` to `delivered`; flow-slack-deliver |
| 1. more than 200 owed in its conversation? / yes → the oldest cut: dropped: owed-full | `connectors/slack/watch.ts:331`, `:384-390`, `:937-940` | `OWED_KEEP = 200`; `insertTs` keeps the newest; a cut ts not in the window or in flight → `drop('owed-full')` |
| 2. the guard said exit 75 for longer than owed_max? / yes → dropped: expired | `connectors/slack/watch.ts:1477-1489` | `deferredSince` stamped at the first exit 75; past `owedMaxMs` → `drop('expired')`, `settle` |
| owed_max: 1 h by default, at most 7 days | `config/load.ts:56`, `:918` | `?? 3_600_000`; ceiling `7 * MAX_DAY_MS` |
| 3. the hourly sweep | `connectors/slack/runtime.ts:77`, `:257-258`; `connectors/slack/watch.ts:592` | `SWEEP_INTERVAL_MS = 60 * 60_000`; once at start, then hourly |
| sent over 24 h ago, and not waiting for a session → dropped: expired | `connectors/slack/watch.ts:332`, `:596`, `:624-629` | `OWED_MAX_AGE_S = 24 * 3600`, by message ts; only with `waitingSince` unset |
| waiting for a session over 3 days → dropped: expired | `connectors/slack/watch.ts:325`, `:617-622` | `WAIT_MAX_MS = 3 * 86_400_000` |
| its target gone, and catch-up no longer reads its place → dropped: unrouted | `connectors/slack/watch.ts:609-614` | not `isLive`, and not `hearsDms` / not in `routedChannels` |
| none → stays owed | `connectors/slack/watch.ts:598-632` | no branch matched |

Not drawn: the sweep spares a ts whose batch still waits in the 4 s window (`watch.ts:609`, `:625`); a thread catch-up finds gone drops what it owed as `expired` (`:675`).
