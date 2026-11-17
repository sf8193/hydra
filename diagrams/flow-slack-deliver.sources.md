# flow-slack-deliver: where each box comes from

Checked against code at 42721c5. Bold names are README's core abstractions or the routing names in diagrams/README.md.

| Box or edge | Source | What the line shows |
|---|---|---|
| a batch of Owed messages, one conversation, after 4 s | `connectors/slack/watch.ts:933`, `:1029-1044`, `:1057` | the coalesce timer → `flushKey` → `deliverItems` → `deliverBatches`, on the conversation's run |
| 1. its Binding's target still declared? | `connectors/slack/watch.ts:1063-1069`; `routing/route.ts:101-110` | `currentId(entry.specialist)` (follows `renamed_from`); `homeless` = none, or not `isLive` |
| no, and nothing does → dropped: unrouted | `connectors/slack/watch.ts:1072-1076` | routed anew as its sender; not `deliver` → `drop('unrouted')`, `settle` |
| no, but a rule takes it now → stays owed; routed anew when catch-up replays it | `connectors/slack/watch.ts:1077-1078` | logged; taken out of this batch, still in `owed` |
| Person, roles, from hydra.toml now | `connectors/slack/watch.ts:1058-1062`, `:1080`; `routing/route.ts:71-79` | `identify(h, addressOf(user))` on the current config |
| 2. Reach, judged again / no → dropped: refused | `connectors/slack/watch.ts:1081-1088`; `routing/route.ts:86-99` | `refusal(h, home, sender, { app })`; refused → `drop('refused')`, `settle` |
| 3. the Guard | `connectors/slack/watch.ts:1101-1102` | `g && !i.operator ? judge(…) : deliver` |
| 4 messages at a time | `connectors/slack/watch.ts:344`, `:1102` | `GUARD_CONCURRENCY = 4`, through `mapLimit` |
| timeout: 5 s by default, at most 30 s | `config/load.ts:57`, `:917`; `routing/guard.ts:74` | `?? 5_000`; `GUARD_TIMEOUT_MAX_MS = 30_000`; past it, `open` |
| output: at most 4096 characters | `routing/guard.ts:42`, `:82-85` | `GUARD_STDOUT_MAX = 4096` against a utf8 string's `length`; more → `open` |
| the operator, no guard, or exit 0 → send | `routing/guard.ts:104`, `:112`; `connectors/slack/watch.ts:1133` | empty stdout or no `target` → `deliver`; `to = home` |
| another exit, a timeout, unusable output: sent anyway | `routing/guard.ts:74`, `:78-81`, `:85`, `:102`, `:106-110`, `:116`; `connectors/slack/watch.ts:1128`, `:1213-1215` | every `open` verdict is logged "delivering anyway" and sent to `home` |
| exit 0 with a target → 4 | `routing/guard.ts:117`; `connectors/slack/watch.ts:1133` | `deliver` with `target`; `to = currentId(target)` |
| exit 10 → dropped: guard, not alerted | `routing/guard.ts:40`, `:100`; `connectors/slack/watch.ts:1109-1112` | `GUARD_DROP = 10`; `drop('guard', …, false)`, `settle` |
| exit 75 → stays owed until owed_max | `routing/guard.ts:41`, `:101`; `connectors/slack/watch.ts:1114-1126` | `GUARD_LATER = 75`; drawn in flow-slack-owed |
| 4. may the sender reach the redirect? | `connectors/slack/watch.ts:1134-1154` | a session thread, or a `refusal` for `to` |
| no: to the binding | `connectors/slack/watch.ts:1134-1139`, `:1144-1150` | `to = home`; alerted when unserved, undeclared or a session thread |
| yes: to the redirect | `connectors/slack/watch.ts:1151-1153` | `fallbackOf.set(to, home)` |
| grouped by Target, in order | `connectors/slack/watch.ts:1103`, `:1156` | `groups` keyed by target, burst order kept |
| files saved | `connectors/slack/watch.ts:1159-1160` | `saveFiles` before the send |
| packed into 8000-byte batches | `connectors/slack/watch.ts:402`, `:1232` | `BATCH_MAX_BYTES = 8000`; `packItems` |
| sent one batch at a time | `connectors/slack/watch.ts:1161-1166`, `:1232-1239` | one global `this.chain`; each batch awaited |
| files: only where the place sets files | `connectors/slack/watch.ts:1159`, `:1177` | `placeOptions(…).files`; else "files is off for this place" |
| 2 messages at a time, 20 MB each | `connectors/slack/watch.ts:1160`, `:341`, `:1179` | `mapLimit(group, 2, …)`; `FILE_MAX_BYTES = 20 MB` |
| a file not saved is listed, with why | `connectors/slack/watch.ts:1176-1198` | `ref.note`: off, no link, too large, not connected, read as the operator, download failed |
| 5. the answer? | `connectors/slack/watch.ts:1239-1266` | branches on `result` |
| ok, or already delivered → delivered: settled, the place's ack reaction if set | `specialists/targets.ts:150-153`; `connectors/slack/runtime.ts:135`; `connectors/slack/watch.ts:1265-1266`, `:1271-1281` | a duplicate key is `ok`; `ack`, then `settle` |
| replies go out through the same App | `connectors/slack/runtime.ts:471-472` | `postParts(app, …)`: "Through the app that heard the conversation, and no other" |
| over 10000 bytes → dropped: too-large | `shared/constants.ts:34`; `specialists/targets.ts:144`; `connectors/slack/watch.ts:1264` | `DELIVER_MAX_MESSAGE_BYTES = 10_000` → `permanent`; `drop('too-large')`, `settle` |
| at max_sessions, or older waiters ahead → waits for a session of its own; stays owed, alerted | `connectors/slack/runtime.ts:126-134`; `specialists/targets.ts:288`; `connectors/slack/watch.ts:1242-1247` | `wait`; `waitingSince` set; `alertOnce('max:…')` |
| exit 8 after a redirect: sent to the binding, alerted | `connectors/slack/watch.ts:1253-1257` | `exit === 8 && fallback` → `alertOnce`, `deliverGroup` to the binding |
| exit 8, alerted; or another error → stays owed | `specialists/targets.ts:182`, `:268`; `connectors/slack/watch.ts:1250-1262` | not `permanent`: stays in `owed`; exit 8 → `alertOnce('no-such-specialist')` |
| stays owed: catch-up replays it | `connectors/slack/watch.ts:645-648`; `connectors/slack/catchup.ts:180-183` | `owedHints` tells each pass where to reread |

Not drawn: a guard `later` for a ts the owed list already cut is `owed-full` (`watch.ts:1117`), and so is a failed batch whose ts was cut (`:1260-1261`).
