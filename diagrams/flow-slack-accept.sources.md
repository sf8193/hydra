# flow-slack-accept: where each box comes from

Checked against code at 42721c5. Bold names are README's core abstractions or the routing names in diagrams/README.md.

| Box or edge | Source | What the line shows |
|---|---|---|
| a Slack message, live or caught up, through the App that heard it | `connectors/slack/watch.ts:734`, `:1305` | `handle(ev)`; each app's `AppWatch` stamps its own `app` |
| 1. the app connected, and the ts valid? | `connectors/slack/watch.ts:735-737` | `config(app)` is null until that app has connected; a bad `ts` or `threadTs` → `ignored` |
| its Cursor moves, whatever follows | `connectors/slack/watch.ts:738-742` | after `classify`, whatever it returned |
| in a channel a rule names, now | `connectors/slack/watch.ts:741`, `:232-235` | `routedChannels(cfg).includes(channel)` |
| in the bot's DM, once owed | `connectors/slack/watch.ts:741`, `:868-870` | `outcome === 'dm'` (returned only after `enqueue`) and the place is `slack:app-dm:<app>` |
| never while catch-up holds it | `connectors/slack/watch.ts:742`, `:698` | `!this.held.has(…)` |
| 2. a message to take up? / an edit, a delete, a join | `connectors/slack/watch.ts:393`, `:757` | only no subtype, `thread_broadcast`, `file_share`, `bot_message` |
| a hydra app's own bot, elsewhere | `connectors/slack/watch.ts:764-766` | another hydra app's bot (`sibling`) is ignored, `bots = true` or not |
| another bot, unless the place has bots = true | `connectors/slack/watch.ts:767-768` | `otherBot && !placeOptions(…)?.bots` |
| one already in flight | `connectors/slack/watch.ts:788` | its ts is in `inflight` for the conversation |
| its Place names | `connectors/slack/watch.ts:201-211`, `:782` | `placesOf` |
| a channel: slack:id, slack:#name; an app's bot DM: slack:app-dm:app; a DM with a person: slack:person-dm:person; a group DM: slack:id, slack:group-dm:id | `connectors/slack/watch.ts:193-199`, `:204-210` | a DM with someone not in `[people]`, or not yet known: `[]` |
| 3. the place named, or the Conversation open? | `connectors/slack/watch.ts:796` | `!existing && !at.some(isDmPlace) && !namedPlace && (inNoBotDm \|\| (!tagged && operatorTokenEnv))` → `ignored` |
| named: slack:app-dm:app, a [places] entry, or a rule's place for a target this app serves | `connectors/slack/watch.ts:252-255`; `routing/route.ts:146-152` | `namedPlace`, over `reachableBy(app)` rules |
| no, and a DM with a person or a group DM | `connectors/slack/watch.ts:770`, `:784` | `dm` includes group DMs; `inNoBotDm = dm && !at.some(isDmPlace)` |
| or untagged, and the app has the operator's token | `connectors/slack/watch.ts:796` | `!tagged && cfg.hydra.slackApps[app]?.operatorTokenEnv` |
| 4. the bot's own? | `connectors/slack/watch.ts:761`, `:798` | `own` = the bot's user id or bot id |
| yes: a top-level post → opens a Conversation for whoever a rule sends this place to; nothing owed | `connectors/slack/watch.ts:803-812`, `:301-305` | `listenerOf` routes as the operator, addressed; `watch(…)`; its ts put in `delivered`; `subscribed` |
| no room → dropped: table-full | `connectors/slack/watch.ts:806-808`, `:558-559` | `watch` returns undefined at `maxWatches` |
| yes: a reply, in a DM, seen before, or no rule here → ignored | `connectors/slack/watch.ts:789`, `:800`, `:802`, `:804` | own in a DM; own reply; already in `delivered`; `listenerOf` finds no one |
| 5. delivered before? | `connectors/slack/watch.ts:817` | `existing.delivered` holds the ts |
| note on 6, just before: a tag in a thread a session listens in hands it to whoever a rule sends it to | `connectors/slack/watch.ts:819-827` | `route(…, addressed: true)`; on `deliver` the binding moves to `fresh.to`, and the session is alerted |
| 6. this app the Owner? | `connectors/slack/watch.ts:831-833` | `owningApp` via `decideOwner`; flow-route-owner |
| yes, or a DM → routed | `connectors/slack/watch.ts:832`, `:834` | a DM is this app's (`dm ? app`); then `route(…)` |
| no → ignored | `connectors/slack/watch.ts:833` | `owner !== app` |

Not drawn: the bot's own message in a DM is ignored at `watch.ts:789`, before gate 3 (`:796`); the diagram shows it under gate 4, with the same outcome.
