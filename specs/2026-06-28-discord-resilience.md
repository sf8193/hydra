# Discord Gateway Resilience — Operational Envelope

**Status:** spec → implementation (PR 1 of 2)
**Scope:** ~300–400L. DiscordGateway gains the same operational guarantees SlackGateway has, **shaped to discord.js's native lifecycle** rather than ported from Slack's poll loop.

## Why this is not a Slack port

`SlackGateway` hand-rolls a staleness poll → `checkNetwork()` → backoff → re-`start()` → `exit(1)` loop **because Bolt offers no connection lifecycle**. discord.js is the opposite: it owns reconnect/RESUME internally and emits a precise shard lifecycle — *and replays missed events on RESUME*. The correct Discord design **translates that native lifecycle onto the `ChatGateway` resilience contract the daemon already consumes** (`forceReconnect`, `onReconnectAfterOutage`, heartbeat). The result is smaller than Slack's machinery and strictly more correct.

A faithful port would be wrong, not merely redundant:
- Slack's `reconnect()` re-runs `start()`. On Discord that **re-binds every `client.on(...)` handler** (handlers are registered inside `start()`), double-delivering every message.
- Slack writes its heartbeat on message events, so a *silent* channel looks stale. Discord can prove liveness from shard readiness with zero traffic.

## The latent bug this fixes

`infra/config.ts` currently writes the Discord `daemon.alive` heartbeat on a **blind 30s `setInterval`, decoupled from connectivity**. The watchdog (heartbeat freshness < 300s) therefore reports Discord healthy whenever the *process* is alive — even with a dead WebSocket. Slack's heartbeat is connection-driven and goes stale on a real outage, triggering a watchdog restart. Discord's heartbeat lies. This work makes the Discord heartbeat **connectivity-aware**.

## Design

### 1. `infra/gateway-health.ts` — `GatewayHealth` (new, shared-ready)

Owns the recovery semantics that are currently duplicated inside each gateway: heartbeat writing (throttled), gap computation, the outage threshold, and the recovery-report trigger. Clock- and fs-injectable so the semantics are unit-testable in isolation (Slack's inline version is not). Designed for Slack to adopt in PR 2; **Slack is untouched here.**

| Method | Meaning |
|---|---|
| `markAlive()` | Connection proved alive (inbound event / shard ready / periodic readiness tick). Writes heartbeat, throttled. |
| `markDisconnected()` | Transport dropped; records when, for gap computation. |
| `markReconnected({ resumed })` | `resumed=true` → discord.js RESUMEd and replayed missed events → **no report**. `resumed=false` → fresh identify, events lost → fire `onOutageRecovered(gap)` if gap > threshold. |

### 2. `discord-gateway.ts` — lifecycle translation

| discord.js event | Action |
|---|---|
| `ShardDisconnect` | `health.markDisconnected()` + log |
| `ShardReconnecting` | log (discord.js owns the retry; don't fight it) |
| `ShardResume` | `health.markReconnected({ resumed: true })` + log — silent, nothing lost |
| `ShardReady` | `health.markReconnected({ resumed: false })` + log — first ready has null disconnect → gap 0 → no report |
| `Invalidated` | log + `process.exit(1)` — discord.js gave up; the real give-up boundary, watchdog cold-restarts |

Plus:
- **Connectivity-aware heartbeat tick:** a 30s interval that calls `markAlive()` **only if `client.ws.status === Status.Ready`**. Replaces the blind `config.ts` timer.
- `markAlive()` on `messageCreate`.
- **`forceReconnect()`** = `client.destroy()` + `client.login(token)`. Listeners persist across `destroy()`, so re-login reuses them (no double-bind). Wires the existing `reconnect` command (🔌) — today Slack-only.
- `onReconnectAfterOutage` field (interface contract); `GatewayHealth.onOutageRecovered` delegates to it. `daemon.ts:55` already assigns `sendRecoveryReport` to it.

### 3. `infra/config.ts`

- `new DiscordGateway({ heartbeatPath })` so the gateway owns its heartbeat.
- Remove the blind `setInterval(touchHeartbeat, 30_000)` for non-Slack. (Startup write at `daemon.ts:122` still seeds it; first `ShardReady` writes within seconds.)

### 4. Tests — `gateway-health.test.ts`

Pure unit tests with injected clock + fs: heartbeat throttling; resume → no report; identify with gap > threshold → report; identify with gap < threshold → no report; first-ready (null disconnect) → no report.

## Platform-abstraction compliance

`daemon.ts` gains no platform-specific code: it already consumes `forceReconnect?` / `onReconnectAfterOutage?` via the interface. All Discord specifics stay inside `discord-gateway.ts`; `GatewayHealth` is platform-agnostic.

## Out of scope (PR 2, optional)

Migrate `SlackGateway` onto `GatewayHealth` — pure refactor, zero behavior change.
