# flow-route-owning-app: where each box comes from

Checked against code at 42721c5. Bold names are README's core abstractions or the routing names in diagrams/README.md.

| Box or edge | Source | What the line shows |
|---|---|---|
| a message, and every App that heard it | `routing/route.ts:131` `heardApps` | the app that delivered it, plus `heardBy`, once each |
| heard by: the apps in the channel, the bound-through app, a tagged app even offline | `connectors/slack/watch.ts:781` | `heardBy = [app, ...channel members, ...through, ...unreachable]` |
| a DM is heard by one app | `connectors/slack/watch.ts:781`, `:832` | `dm ? [app]`; `owning = dm ? app` |
| 1. heard by more than one app? | `routing/route.ts:181`, `:213` | `contested = heard.length > 1`; `route()` asks only when contested |
| no → that app is the owning app | `routing/route.ts:183` | the only app that heard it |
| a. the app tagged first | `routing/route.ts:185-186` | first of `mentioned` that heard it |
| b. the app that opened the Conversation | `routing/route.ts:187` | `boundApp`, if it heard it |
| c. the Place's default_app | `routing/route.ts:188-191` | `places[p].defaultApp`, if it heard it, even if it reaches no one |
| d. the app named default | `routing/route.ts:195` | `DEFAULT_SLACK_APP`, if in the pool |
| e. the first app hydra.toml declares | `routing/route.ts:196` | first of `slackApps` in the pool (else the pool's first) |
| d and e: among the apps that deliver to someone here, if any do (a catch-all rule to main does not count) | `routing/route.ts:200-201`, `:171-175` | `serving = heard.filter(reachesAnyone)`; pool = serving, else all that heard it; `reachesAnyone` passes over `isCatchAll` rules (`:168`) |
| 2. is this app the owning app? → no → ignored | `routing/route.ts:215-217`; `connectors/slack/watch.ts:833` | `if (!mine) return … 'ignored'` |
| yes → this app routes it | `routing/route.ts:220` onward | routing goes on: flow-route |
| the owning app decided once per message | `connectors/slack/watch.ts:829-832` | `decideOwningApp(channel, ts, decide)`: whichever connection decides first |
