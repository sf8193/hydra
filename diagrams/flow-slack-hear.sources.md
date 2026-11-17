# flow-slack-hear: where each box comes from

Checked against code at 42721c5. Bold names are README's core abstractions or the routing names in diagrams/README.md.

| Box or edge | Source | What the line shows |
|---|---|---|
| each App hydra.toml declares | `connectors/slack/connections.ts:101-114` | one listener per `h.slackApps` entry not already running; runs again on every hydra.toml load (`:84`) |
| 1. both tokens set? | `connectors/slack/connections.ts:32-37`, `:105` | `missingTokens`: the bot token, `socket_token_env` set, and the socket token |
| no → skipped, and said once | `connectors/slack/connections.ts:106-109` | logged on each pass; alerted only when the reason changed (`skipped` map) |
| connect: who the bot is, channel names, whose each DM is; then hold the cursors | `connectors/slack/listener.ts:492`, `:500`, `:503`, `:506-507` | `authTest`, `refreshDirectory`, both DM lists, `beginCatchUp`, all before `app.start()` (`:508`) |
| held: every named channel and known DM | `connectors/slack/listener.ts:507` | `routedChannels(view)`, plus `dmChannels()` when `hearsDms` |
| DM lists: only with the operator's token | `connectors/slack/listener.ts:503`, `:573` | `hasOperatorToken()` gates both reads |
| once up: scopes checked, if Slack lists them | `connectors/slack/listener.ts:510-520` | after `app.start()`, only `if (auth.scopes)`; missing ones alerted through `alertMissingScopes` |
| 2. socket up within 30 s? | `connectors/slack/listener.ts:406-412`, `:438-442`; `shared/socket-supervisor.ts:26` | `boundedConnect` races `connect()` against `START_TIMEOUT_MS = 30_000` |
| no → retry: 10 s, doubling to 5 min | `connectors/slack/listener.ts:448-459`; `shared/socket-supervisor.ts:23-24`, `:287` | first connect: `(firstRetryBaseMs ?? 10_000) * 2 ** n`, capped `5 * 60_000`; a later drop: the supervisor's same base and cap |
| yes → a boot Catch-up pass | `connectors/slack/listener.ts:419`, `:456` | `runCatchUp(true, 'boot')` once the socket is up |
| a live message, through this app's socket | `connectors/slack/listener.ts:479`, `:532` | `app.onMessage` → `onMessage`; a stale connection's events are dropped (`gen`) |
| 3. must it wait? | `connectors/slack/listener.ts:541-542` | handled at once unless its channel has a queue, the DM is unknown, or a channel's apps are unsettled (a DM or group DM skips that) |
| note: whose DM it is not yet known | `connectors/slack/listener.ts:576-578`, `:587-591` | `unknownDm` (operator's token only); `learnDm` reads the bot's, then the operator's, DM list |
| note: one ahead of it in its channel waits | `connectors/slack/listener.ts:543-551` | a per-channel promise chain |
| note: learning the apps: at most 5 s | `connectors/slack/listener.ts:87`, `:626-632` | `MEMBERSHIP_WAIT_MS = 5_000`, raced in `knowMembers` |
| 4. an app still joining, in a named channel? | `connectors/slack/listener.ts:563-564` | `apps.isJoining() && routedChannels(view).includes(channel)`; asked only on the waiting path (`:547`) |
| yes → not handled now; its Cursor held, so catch-up reads it | `connectors/slack/listener.ts:565-567` | `beginCatchUp([channel])`, then `runCatchUp(false, 'apps joined')` after `allJoined()` |
| no → to the connector | `connectors/slack/listener.ts:542`, `:569`, `:611-619` | `ingest` → `toEvent` → `this.w.handle(ev)` |

Not drawn: a reconnect after the first connection also runs a deep pass (`listener.ts:489`), drawn in flow-slack-catchup's triggers.
