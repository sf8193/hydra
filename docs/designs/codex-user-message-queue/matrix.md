# Codex user-message delivery case matrix

Scope: user-authored Discord/Slack messages delivered from `daemon/router.ts` to a
Codex-backed Hydra session. Automated/protocol notifications are unchanged.

## Cases from the current code

| ID | Situation | Current path and behavior | Required behavior |
|---|---|---|---|
| C1 | Codex is idle and connected | `deliverToSession` → `sendOrQueue` → adapter default → `steer`; `steer()` moves the text into `steerQueue`, then starts a turn (`router.ts:206-240`, `bridge-transport.ts:156-196`, `codex-engine-adapter.ts:97-128`, `codex-engine.ts:177-200`). Usually works. | Start one acknowledged next turn. |
| C2 | Codex has an active turn | Adapter calls fire-and-forget `turn/steer` (`codex-engine.ts:200,439-443`) and immediately reports accepted. It can be lost or applied too late. | Append to the ordered next-turn queue. Never steer. |
| C3 | Visible answer finished, `turn/completed` not processed | `currentTurnId` remains non-null, so the message follows C2 even though peek looks idle. | Queue; `turn/completed` drains it afterward. |
| C4 | A turn start is pending (`turnPending=true`) | Default steer is held in `steerQueue` and injected into the just-started turn (`codex-engine.ts:184-197,518-522`). | Queue as a distinct later turn. |
| C5 | Two or more user messages arrive quickly | Default behavior may steer both into the active turn. Next-turn queue preserves array order, but silently drops the oldest at 50 (`codex-engine.ts:204-211`). | Preserve FIFO and never silently drop user messages. |
| C6 | `! message` arrives during work | Router asks adapter to interrupt without awaiting it, sleeps 50 ms, then uses ordinary delivery (`router.ts:897-914`). Delivery can race the interrupt and steer into the old turn. | Await interruption, then enqueue the stripped message as the next turn. |
| C7 | `! message` arrives while idle | Interrupt is effectively a no-op; delivery follows ordinary path. | Enqueue/start immediately as a next turn. |
| C8 | Codex connection is absent at delivery | Adapter polls 15 s, then calls `queueTurn`; `queueTurn` returns when there is no connection, so the message is actually dropped while reported accepted (`codex-engine-adapter.ts:101-111`, `codex-engine.ts:204-206`). | Queue in session scheduling even without a connection; drain after resume. |
| C9 | Socket disconnects with queued future turns | `scheduling` survives an in-process reconnect, but is memory-only (`codex-engine.ts:69,124-133`). | Preserve across a transient socket reconnect in-process. Durable daemon-restart storage is a follow-up. |
| C10 | `turn/start` is explicitly rejected | Deferred start retries twice, then requeues and emits `turnStalled` (`codex-engine.ts:214-242`). | Same, without losing FIFO ordering. |
| C11 | `turn/start` times out with unknown outcome | Code emits `turnDeliveryUnknown` and does not replay, avoiding duplicates (`codex-engine.ts:218-221`). | Same; surface uncertainty, do not blindly duplicate. |
| C12 | Session is retiring/fenced | `queueTurn` refuses new work and retirement clears queues (`codex-engine.ts:206,260-270`). | Same. Session lifecycle owns rejection/escalation. |
| C13 | Attachments accompany a message | Adapter appends downloaded paths before choosing delivery (`codex-engine-adapter.ts:117-125`). | Preserve enrichment in queued text. |
| C14 | Claude-backed session | `BridgeTransport` uses the bridge socket path, not Codex adapter scheduling (`bridge-transport.ts:199+`). | No change. |
| C15 | Automated protocol notification | Callers explicitly use `deferUntilTurnComplete` when needed (`protocol-runner.ts:1176-1212`). | No change. |

## Branch-by-branch coverage

### `deliverToSession` (`router.ts:206-240`)

- Session exists / missing: C1-C13 / main-session fallback.
- Context links absent / present: delivery semantics unchanged.
- Payload construction and reply guard: all user-message cases.
- Delivery mode currently omitted: C1-C5 and C8; design changes this branch.

### `!` intercept (`router.ts:897-914`)

- Empty stripped text: unchanged, falls through.
- Nonempty text, interrupt success: C6/C7.
- Interrupt failure: C6; message must still be queued and failure logged.

### `CodexEngineAdapter.deliver` (`codex-engine-adapter.ts:97-128`)

- Disconnected then reconnects during polling: C8.
- Still disconnected after polling: C8 (currently incorrect acceptance).
- Keepalive: out of scope.
- Attachments: C13.
- `next-turn`: C1-C8.
- default steer: retained only for explicit internal callers, not normal user messages.

### `CodexEngine.queueTurn` / completion (`codex-engine.ts:203-242,549+`)

- no connection / no thread: C8 (currently uncovered/incorrect).
- fenced: C12.
- at capacity: C5 (currently incorrect silent deletion).
- active or pending: C2-C4.
- idle: C1/C7.
- rejected start / retry / exhausted: C10.
- unknown start outcome: C11.
- completion with queue: C2-C5.
- completion without queue: unchanged `turnCompleted` event.

