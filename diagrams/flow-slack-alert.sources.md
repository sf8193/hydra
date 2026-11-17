# flow-slack-alert: where each box comes from

Checked against code at 42721c5. Bold names are README's core abstractions or the routing names in diagrams/README.md.

| Box or edge | Source | What the line shows |
|---|---|---|
| a Drop | `connectors/slack/watch.ts:175-177`, `:979` | `DropKind`; `drop(kind, where, ts, why, alert = true)` |
| 1. this message dropped before? / yes → nothing more | `connectors/slack/watch.ts:980-981`, `:946-951` | `firstTime` per channel and ts; a replay does nothing |
| logged, counted by kind | `connectors/slack/watch.ts:982-984` | `stats_.dropped[kind]`, log line |
| 2. an alerted kind? | `connectors/slack/watch.ts:987` | `if (alert) this.alertOnce(…)` |
| alerted: expired, owed-full, too-large, tag-cap, table-full, catch-up-gap, unbound, refused, unrouted | `connectors/slack/watch.ts:585`, `:611`, `:618`, `:627`, `:715`, `:807`, `:842`, `:856`, `:861`, `:915`, `:940`, `:1074`, `:1085`, `:1117`, `:1121`, `:1261`, `:1264` | each call leaves `alert` at its default; `catch-up-gap` calls `alertOnce` itself |
| not alerted: guard (exit 10) | `connectors/slack/watch.ts:1110` | `drop('guard', …, false)` |
| no → logged and counted only | `connectors/slack/watch.ts:982-987` | log and counter run whatever `alert` is |
| 3. same app, kind and target alerted in this episode? | `connectors/slack/watch.ts:986-987`, `:995-1001` | key `${app}\|${kind}:${to}`; returns if `now - began < ALERT_EPISODE_GAP_MS` |
| an episode: 60 min from its first alert | `connectors/slack/watch.ts:339`, `:999-1001` | `ALERT_EPISODE_GAP_MS = 60 * 60_000`, from the episode's start |
| it also paces: guard redirects, exit 8, a specialist at max_sessions, the operator's token refused, a thread gone | `connectors/slack/watch.ts:1137`, `:1148-1149`, `:1255`, `:1259`, `:1246`, `:694`, `:688` | each uses `alertOnce` |
| yes → logged only | `connectors/slack/watch.ts:1000` | `return` before `deps.alert` |
| no: a new episode → an Alert | `connectors/slack/watch.ts:1001-1002` | `episodeStart.set`, `deps.alert(text, to, app)` |
| an App's connection trouble | `connectors/slack/runtime.ts:154`, `:188`, `:190` | shared-apps, listener and connections alerts all call `alert(text, undefined, app)` |
| checked every 60 s | `connectors/slack/listener.ts:79`, `:414` | `ALERT_CHECK_MS = 60_000` runs `checkAlerts` |
| down 5 min: once | `connectors/slack/listener.ts:83`, `:751-753` | `DOWN_ALERT_AFTER_MS = 5 * 60_000`, awake time (`:738`); `alerted.down` |
| back up: once | `connectors/slack/listener.ts:754-756` | "connected again" only when `alerted.down` |
| no complete catch-up for 25 min: once | `connectors/slack/listener.ts:77`, `:84`, `:759-766`, `:685` | `CATCH_UP_STALE_AFTER_MS = 10 min × 2.5`; cleared by a complete pass |
| a catch-up read refused for good: once each | `connectors/slack/listener.ts:37-41`, `:721-725`, `:685` | regex list; said again for a different fix, or after a complete pass |
| live events missed: at most hourly | `connectors/slack/listener.ts:85`, `:691-694` | `MISSED_LIVE_ALERT_EVERY_MS = 60 * 60_000`; periodic passes only |
| scopes missing: once per set, across restarts | `connectors/slack/listener.ts:712-718`; `connectors/slack/runtime.ts:161-172` | key = sorted missing options, kept in `slack-scopes-told.json` |
| names or membership unreadable: once | `connectors/slack/listener.ts:372-379`; `connectors/slack/apps.ts:245-256` | `namesWarned` (only when a `#name` place is unresolved); `said` per app |
| tokens missing: once per reason | `connectors/slack/connections.ts:105-108` | `skipped.get(app.id) !== why` |
| an old slack-watch.json with no app: each load | `connectors/slack/connections.ts:84`, `:97-99` | checked in every `reconcile`, which every hydra.toml load runs |
| an Alert: the text, the specialist it concerns, the app | `connectors/slack/runtime.ts:85` | `alert(text, to?, app?)` |
| 4. that specialist has a thread? / yes → posted in that thread | `connectors/slack/runtime.ts:88`, `:102-104` | `to && alertChannel(to)`: main's channel for `main`, a session's thread, else the specialist's `threadId` |
| no, or none named → 5 | `connectors/slack/runtime.ts:88` | falls to `audience` |
| 5. specialists that hear Slack through the app have threads? / yes → posted in each | `connectors/slack/runtime.ts:87`, `:89-97`; `routing/route.ts:156-160` | `slackSpecialistsOf(h, app)`; no app: every Slack specialist; an undeclared app: none |
| 6. main has a channel? / yes → posted in main's channel | `connectors/slack/runtime.ts:97`, `:103` | `post([MAIN])` via `mainChannel()` |
| no → the daemon log | `connectors/slack/runtime.ts:29`, `:98` | `log` writes to `process.stderr` |
| a post that fails is not retried | `connectors/slack/runtime.ts:93` | `safeSend(where, text).catch(() => {})` |

Not drawn: an `expired` drop for a thread catch-up finds gone is alerted only when no one holds it (`watch.ts:675`); a holder gets the "Let go of …" alert instead (`:686-688`).
