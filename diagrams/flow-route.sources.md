# flow-route: where each box comes from

Checked against code at 42721c5. Bold names are README's core abstractions or the routing names in diagrams/README.md.

| Box or edge | Source | What the line shows |
|---|---|---|
| a message this app owns | `routing/route.ts:211-218` | `route()` asks `owningApp` first; drawn in flow-route-owner |
| Person, roles | `routing/route.ts:71-79` `identify` | roles = theirs + `people` + `anyone`; a stranger holds only `anyone` |
| 1. Binding? | `routing/route.ts:224-232` | `msg.bound`, after `renamed_from` renames (`currentId`, `:107`) |
| bound, and it holds → 5 | `routing/route.ts:228-230` | live: declared and served → `decide(to, 'binding', false)` (no new bind) |
| none, or this app no longer serves it → 2 | `routing/route.ts:227`, `:223` | `apart`: `addressed` stays as the message has it |
| bound, but hydra.toml no longer declares it → 3 | `routing/route.ts:226`, `:231` | `gone` sets `addressed = true`, so 2 always passes |
| 2. addressed, or a place here has messages = all? | `routing/route.ts:234`, `:113` | `!addressed && !messagesAll` → ignored |
| addressed: a DM or group DM, a tag, or an open conversation with no target yet | `connectors/slack/watch.ts:770`, `:816` | `dm` includes group DMs; `addressed = dm \|\| tagged \|\| (existing && !existing.specialist)` |
| no → ignored | `routing/route.ts:235-236` | fate `ignored` |
| 3. the first Rule that matches? | `routing/route.ts:240-249` | `[[rules]]` in file order; first match wins |
| a rule matches when each key it sets fits (place, app, person, serves) | `routing/route.ts:241-245`; `config/pins.ts:16` | `atOk`, `appOk`, `fromOk` (a role counts), then `notServedBy`; `main` is always served (`route.ts:125`) |
| 4. the Operator, in the bot's DM? | `routing/route.ts:251`; `config/types.ts:30` | `sender.operator && at.some(isDmPlace)`; `isDmPlace` is kind `app-dm` only (`slack:app-dm:<app>`, `discord:app-dm:*`) |
| yes → main | `routing/route.ts:253` | `winner = main` |
| no → unrouted | `routing/route.ts:256` | fate `unrouted` |
| 5. Reach | `routing/route.ts:86-98` `refusal` | judged on every winner (`decide`, `:206-208`) |
| Reach note: operator, main, a session's thread, a specialist | `routing/route.ts:89`, `:90`, `:92`, `:95` | in that order |
| yes → deliver; after 3 or 4, bind | `routing/route.ts:257`, `:230` | `bind: true` after a rule or the operator's DM, `false` on a binding |
| no → refused | `routing/route.ts:208` | fate `refused`, with `why` |
| A Fate is a decision; the connector may still drop a deliver | `connectors/slack/watch.ts:836-866` | 🚫, tag cap, table caps, bind: flow-slack-accept |

Not drawn: an old `listens` on a specialist is read at load as rules after the explicit ones (`config/load.ts:607-608`), so `route()` only ever sees `[[rules]]`.
