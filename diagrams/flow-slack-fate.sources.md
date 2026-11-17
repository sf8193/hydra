# flow-slack-fate: where each box comes from

Checked against code at 42721c5. Bold names are README's core abstractions or the routing names in diagrams/README.md.

| Box or edge | Source | What the line shows |
|---|---|---|
| the Fate routing returns | `connectors/slack/watch.ts:834` | `route(cfg.hydra, { from, at, addressed, app, bound })` |
| 1. which Fate? / ignored | `connectors/slack/watch.ts:835` | `d.fate === 'ignored'` → `ignored` |
| refused or unrouted → 2 | `connectors/slack/watch.ts:838` | handled before anything is counted, watched or owed |
| 2. Owed from before? / yes → dropped: refused or unrouted, settled, alerted | `connectors/slack/watch.ts:841-845` | a replay already owed: `drop(d.fate, …)` (alerted by default, `:979`), then `settle` |
| 3. a 🚫 for it? | `connectors/slack/watch.ts:847` | `react = !inNoBotDm && (refused ? dm \|\| tagged : tagged && !dm)` |
| 🚫: a refused DM with the bot, a tag in a channel, refused or unrouted | `connectors/slack/watch.ts:846-847` | as the predicate reads |
| no 🚫: an unrouted DM, untagged chatter, a DM with a person, a group DM | `connectors/slack/watch.ts:784`, `:847` | `inNoBotDm` covers a DM with a person and a group DM |
| no 🚫: a sender past 10 in 10 min | `connectors/slack/watch.ts:961-967`, `:333`, `:103` | per sender, `maxMentionsPer10Min = 10` within `MENTION_WINDOW_MS = 10 min` |
| no 🚫: a replay | `connectors/slack/watch.ts:955` | `firstTime` fails: returns before logging, counting or reacting |
| no 🚫: the app's Slack actions not connected | `connectors/slack/watch.ts:969-970` | `react && slack` |
| 🚫, logged, counted / logged, counted | `connectors/slack/watch.ts:957-959`, `:970-974` | counts `unrouted`, or `refused` + `refusedBy`; logs; reacts `no_entry_sign` (`:182`) |
| deliver → 4 | `connectors/slack/watch.ts:852` | the deliver path |
| 4. a tag opening a conversation: its sender under 10 in 10 min? / over → dropped: tag-cap | `connectors/slack/watch.ts:852`, `:908-920` | `!existing && tagged` → `allowMention`; `recent.length >= 10` → `drop('tag-cap')`; no user passes |
| 5. room in the conversation table? | `connectors/slack/watch.ts:854-863` | ambient cap, then `watch`'s cap |
| at most 50, shared by every app | `connectors/slack/watch.ts:103`, `:532`, `:558-559` | `maxWatches: 50` over `list()`, every app's entries |
| at most 25 opened by untagged chatter | `connectors/slack/watch.ts:854-855` | `!existing && !tagged && !dm`: `floor(50 / 2)` |
| an open one, or one-off chatter: no slot needed | `connectors/slack/watch.ts:552-556`, `:330`, `:559` | an existing entry skips the cap; `oneOff` is not counted |
| no → dropped: table-full | `connectors/slack/watch.ts:856`, `:861` | `drop('table-full', …)` |
| Binding set, if new, renamed or gone | `connectors/slack/watch.ts:859`, `:866`; `routing/route.ts:224-232` | a new entry is bound to `d.to`; `(d.bind \|\| via binding) && specialist !== d.to` rebinds |
| the message Owed, saved | `connectors/slack/watch.ts:923-927` | `insertTs(owed, ts, OWED_KEEP)`, persisted before anything is sent |
| over 200 owed here → an older owed message cut: dropped: owed-full | `connectors/slack/watch.ts:331`, `:937-940` | `OWED_KEEP = 200`; a cut ts not in the window or in flight → `drop('owed-full')` |
| queued; flushed after 4 s | `connectors/slack/watch.ts:929-936`, `:103` | `setTimeout(flushKey, coalesceMs = 4000)`, or it joins the pending batch |

Not drawn: the conversation is touched (`lastEventAt`, `watch.ts:867`) and the outcome is `dm`, `mention` or `follow-up` (`:868-870`).
