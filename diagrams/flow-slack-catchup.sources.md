# flow-slack-catchup: where each box comes from

Checked against code at 42721c5. Bold names are README's core abstractions or the routing names in diagrams/README.md.

| Box or edge | Source | What the line shows |
|---|---|---|
| a Catch-up trigger | `connectors/slack/listener.ts:669` | `runCatchUp(deep, why)` |
| deep: boot, reconnect, resume | `connectors/slack/listener.ts:419`, `:456`, `:489`, `:650`; `connectors/slack/runtime.ts:278` | `runCatchUp(true, …)`; `clock:resumed` → `onResume` |
| deep: every 10 min | `connectors/slack/listener.ts:77`, `:414` | `CATCH_UP_INTERVAL_MS = 10 * 60_000`, `'periodic'` |
| deep: a retry after 60 s | `connectors/slack/listener.ts:78`, `:700-702` | `CATCH_UP_RETRY_MS = 60_000`, after a pass that is not complete |
| not deep: all apps joined, a place freed | `connectors/slack/listener.ts:566`; `connectors/slack/runtime.ts:39`, `:263-267` | `'apps joined'`; `wake` when a conversation session ends with waiters |
| 1. the app declared, and connected once? | `connectors/slack/listener.ts:670`, `:343` | `!this.view() \|\| !this.app` → null; `view()` is null while the app is undeclared or its bot id unknown |
| no → nothing | `connectors/slack/listener.ts:670` | returns null |
| 2. a pass already running? / yes → runs once more when it ends | `connectors/slack/listener.ts:671`, `:704` | `rerun` keeps the deepest request, run as `'queued'` |
| one pass, in order | `connectors/slack/listener.ts:677-680`; `connectors/slack/catchup.ts:114` | names refreshed, membership read, then `catchUp` |
| 0. new bot DMs / 0: read back 24 h, if routing would deliver | `connectors/slack/catchup.ts:152-171` | `api.dms()`; `route(… at: [slack:dm], addressed: true).fate === 'deliver'`; from `now - 24 * 3600` |
| 1. threads with Owed messages / from the first owed message | `connectors/slack/catchup.ts:179-183`; `connectors/slack/watch.ts:645-648` | `owedHints` from `owed[0]`, inclusive |
| a DM's owed are read in 3 | `connectors/slack/catchup.ts:181`, `:209-210` | a top-level hint sets `dmFrom`; the history scan starts there |
| 2. every watched thread, if deep | `connectors/slack/catchup.ts:187-192` | from the channel cursor, else `ownCursor` |
| 3. channel and DM history / named channels, then DMs, least read first | `connectors/slack/catchup.ts:198-204` | sort: routed first, then by cursor |
| no cursor yet: from now, no backfill | `connectors/slack/catchup.ts:211` | `newest.set(channel, nowTs(now))` without reading |
| 4. thread replies / the threads 1 to 3 found; never moves a cursor | `connectors/slack/catchup.ts:228`, `:247-272` | `want` from the scans; `:270-271`: a reply's ts never moves the cursor |
| budget: 2 per watch, 1 per known DM, plus 20; at least 60, at most 400 | `connectors/slack/catchup.ts:107`, `:110`, `:116` | `MIN_CALLS = 60`, `MAX_CALLS_CAP = 400`, `2 * list + dmChannels + 20` |
| budget: 1 per new DM | `connectors/slack/catchup.ts:173` | `maxCalls + newDm.size`, still capped at 400 |
| a page read as the operator: 1 more | `connectors/slack/catchup.ts:268` | `if (res.via === 'user') spend()` |
| pages: at most 5 per channel or thread | `connectors/slack/catchup.ts:117` | `maxPages ?? 5` |
| a DM that starts near the budget's end: skipped | `connectors/slack/catchup.ts:109`, `:207` | `calls >= maxCalls - threads.size - THREAD_SLACK (10)` → `skipped` |
| → each message it finds: flow-slack-accept | `connectors/slack/catchup.ts:126-134` | `feed` → `watcher.handle(ev)`, oldest first |
| a thread Slack says is gone, or refused to the operator's token: skipped; the pass goes on | `connectors/slack/catchup.ts:105`, `:256-266` | `GONE_THREAD` → `threadGone`; `OPERATOR_TOKEN_REFUSED` → `operatorTokenRefused`; `break`, not `throw` |
| a channel past 5 pages: catch-up-gap, the older rest dropped, alerted | `connectors/slack/catchup.ts:232-238`; `connectors/slack/watch.ts:708-716` | `catchUpGap`: counted `catch-up-gap`, logged, `alertOnce` |
| 3. how did the pass end? | `connectors/slack/catchup.ts:278-287` | a throw → incomplete; else complete |
| all read → complete: each Cursor moves to the newest message read | `connectors/slack/catchup.ts:286`; `connectors/slack/watch.ts:699-702` | `endCatchUp(channel, newest)` for every scanned channel |
| a DM skipped for budget stays held | `connectors/slack/catchup.ts:285-286` | `if (!skipped.has(channel))` |
| budget spent, a thread past 5 pages, a DM out of budget while being read, another Slack error | `connectors/slack/catchup.ts:121`, `:275`, `:263`, `:278-282` | `OutOfBudget` from `spend()` or a thread's last page; a non-gone error rethrown |
| or a crash | `connectors/slack/listener.ts:695-696`, `:700` | `result` stays null, so a retry is scheduled |
| incomplete: cursors held | `connectors/slack/catchup.ts:279-282` | returns before any `endCatchUp` |
| except a DM read empty: now | `connectors/slack/catchup.ts:224` | first page empty, no next → `markRead(channel, now)` at once |
| a retry in 60 s, unless one is pending | `connectors/slack/listener.ts:700-702` | `!result?.complete && !this.retryTimer` |

Not drawn: a periodic pass that finds messages while the stream held is alerted at most hourly (`listener.ts:691-694`), drawn in flow-slack-alert.
