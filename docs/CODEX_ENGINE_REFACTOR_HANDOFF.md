# Handoff: Provider-Oriented Session Runtime Refactor

## Objective

Refactor Hydra so thread and protocol orchestration call a provider-neutral session runtime, with Claude and Codex implementing the same semantic operations behind adapters.

Target call flow:

```text
thread/protocol command
        ↓
SessionRuntime
        ↓
EngineAdapter
        ├── ClaudeAdapter
        └── CodexAdapter
```

Prefer interfaces plus composition over a deep class hierarchy. Do not force false parity: provider-specific capabilities and result types should remain explicit.

## Starting Point

- Repository: `/Users/sam/trading/hydra`
- Current base branch/PR: `sf/codex-command-parity`, [PR #331](https://github.com/sf8193/hydra/pull/331), stacked on [PR #329](https://github.com/sf8193/hydra/pull/329)
- Current baseline: `1bbc2ad`; includes command/model parity and recovery/reconnect fixes beyond the original handoff.
- Read the [Claude functionality/test matrix](CLAUDE_FUNCTIONALITY_AUDIT.md) and [exact test catalogue](CLAUDE_TEST_CATALOGUE.md) before extraction. They distinguish shared contracts, provider mechanics, weak tests, and missing coverage.
- Latest commits at handoff:
  - `55f6a71` — block Codex model keepalives
  - `b3eaf03` — isolate Codex control bridges
  - `19368b7` — harden Codex lifecycle retirement
- Start this refactor on a new branch based on `sf/codex-command-parity`; keep the refactor separate from the correctness/parity PRs.
- Preserve these unrelated local edits; they are user-owned and intentionally excluded from PR #329:
  - `daemon/prompts/review-critic.ts`
  - `protocols/review.ts`

Before editing, read:

- `AGENTS.md`
- `daemon/session-provider.ts`
- `daemon/session-lifecycle.ts`
- `daemon/codex-engine.ts`
- `daemon/codex-process.ts`
- `daemon/bridge-transport.ts`
- `daemon/protocol-runner.ts`
- `daemon/recovery.ts`
- `daemon/session-health.ts`
- `daemon/retirement-journal.ts`

## Why Refactor

Provider behavior is currently split among conditionals and callbacks across lifecycle, protocol, transport, health, and command modules. `session-provider.ts` is a useful first boundary, but it mostly wraps recovery/UI operations. Callers still know too much about tmux, Codex sockets, persistent homes, turn queues, and interruption mechanics.

The refactor should make orchestration express intent instead of mechanism:

```ts
await runtime.deliver(session, message, { mode: 'next-turn' })
await runtime.retire(session, { reason })
await runtime.resume(identity)
await runtime.fork(identity)
await runtime.ensureInteractiveSurface(session)
await runtime.health(session)
runtime.contextUsage(session)
```

## Proposed Types

Names are suggestions; preserve the semantic separation even if names change.

```ts
type DeliveryMode = 'steer-active' | 'next-turn'

type DeliveryResult =
  | { status: 'accepted'; deliveryId: string }
  | { status: 'rejected'; retryable: boolean; reason: string }
  | { status: 'unknown'; deliveryId: string; reason: string }

type RetirementResult =
  | { status: 'terminal' }
  | { status: 'pending'; journaled: true }
  | { status: 'failed'; journaled: boolean; reason: string }

interface EngineAdapter {
  readonly id: 'claude' | 'codex'
  readonly capabilities: ProviderCapabilities

  spawn(input: SpawnInput): Promise<SpawnedSession>
  resume(input: ResumeInput): Promise<SpawnedSession | null>
  fork(input: ForkInput): Promise<SpawnedSession | null>
  deliver(session: SessionIdentity, text: string, mode: DeliveryMode): Promise<DeliveryResult>
  retire(session: ExecutionIdentity, reason: string): Promise<RetirementResult>
  health(session: SessionIdentity): Promise<ProviderHealth>
  ensureInteractiveSurface(session: SessionIdentity): Promise<boolean>
  contextUsage(session: SessionInfo): ContextUsage | null
}
```

`SessionRuntime` should own cross-provider orchestration: registry transactions, ownership generations, artifact carry-over, thread membership, recovery tier selection, and terminal cleanup. Adapters should own provider mechanics.

## Ownership Boundaries

### SessionRuntime owns

- lifecycle transaction and rollback
- registry and thread-registry mutations
- immutable ownership generation
- pending-retirement journal coordination
- provider capability checks
- common spawn/recovery result handling
- user-visible state transitions and announcements

### ClaudeAdapter owns

- Claude CLI arguments and session IDs
- tmux process lifecycle
- bridge liveness and delivery
- Claude-native resume/fork behavior
- pane-derived context/status where still required

### CodexAdapter owns

- detached app-server process and Unix socket
- CODEX_HOME and persistent thread identity
- WebSocket connection generations
- turn scheduler, delivery outcomes, and retirement fencing
- Codex-native resume/fork behavior
- disposable tmux TUI attachment/repair
- structured token/context telemetry

### Transport owns

- routing only
- persistent Claude session bridges
- Codex MCP control bridges
- queue persistence appropriate to the provider

Transport must not choose provider lifecycle policy.

## Non-Negotiable Invariants

These came from real failures during PR #329.

1. **One authoritative runtime per agent.** Claude owns its process/session; Codex owns one detached app-server plus one persistent thread. Codex tmux is presentation only.
2. **No synthetic Codex model keepalives.** `[system] keepalive` must be rejected both where protocols schedule it and at the Codex transport boundary. Liveness uses process/socket health checks.
3. **Control connections never replace session connections.** Codex MCP sidecars use `connectionRole: 'control'`; their connect/disconnect lifecycle cannot trigger session death or protocol fallback.
4. **Retirement fences before interrupting.** No queued, retrying, or late-accepted protocol turn may start after retirement begins.
5. **Interrupt writes are not success.** Require acknowledged interrupt or verified terminal state. Timeout/connection loss is `unknown`, not success.
6. **At most one unresolved start attempt per logical delivery.** Definite RPC rejection may retry. Lost response/timeout must not be blindly replayed.
7. **Execution identity is durable.** The retained participant reference must be refreshed after Codex assigns its real thread ID.
8. **Ownership is generational.** Stale retirement work must not interrupt a successor that legitimately acquired the same human-readable name.
9. **Home ownership precedes mutation.** Reserve name/home synchronously before the first asynchronous gap and before rollout deletion, copy, process stop, or launch.
10. **Reconnect callbacks are generation-bound.** Old socket events, timers, and request continuations cannot remove or advance a replacement connection.
11. **Restart cannot forget cleanup.** Pending retirement is persisted before bounded shutdown and replayed before orphan identity is pruned.
12. **Shared-server isolation remains intact.** Retiring one legacy Codex thread must not stop or interrupt sibling threads.

## Migration Plan

Keep the refactor behavior-preserving and commit it in reviewable slices.

### 1. Define semantic interfaces

- Introduce provider-neutral identity, delivery, health, and retirement result types.
- Convert `SessionProvider` into or replace it with `EngineAdapter`.
- Keep adapter construction/dependency injection testable; avoid a global callback bag.
- Add compile-time exhaustiveness for provider IDs and delivery/retirement results.

### 2. Extract Codex adapter

- Move Codex-specific spawn logic out of `session-lifecycle.ts`.
- Compose `CodexEngine`, `codex-process`, TUI repair, and CODEX_HOME seeding behind the adapter.
- Keep scheduler state session-owned rather than socket-owned.
- Preserve the explicit `accepted/rejected/unknown` delivery contract.

### 3. Extract Claude adapter

- Move Claude command construction, tmux process management, bridge delivery, and native resume/fork behind the adapter.
- Do not give Claude fake Codex concepts such as sockets or turn IDs.

### 4. Build SessionRuntime

- Move shared spawn/kill/resume/fork orchestration out of `session-lifecycle.ts`.
- Model spawn as a transaction: acquire identity, publish required provisional capabilities, call adapter, commit final identity, or roll back.
- Centralize retirement journal and ownership-generation rules.

### 5. Migrate callers

In this order:

1. protocol delivery and retirement
2. health and interactive-surface repair
3. recovery/resume/fork
4. thread commands (`peek`, `keys`, `enter`, `resume`, `fork`, `kill`)
5. startup/shutdown orchestration

Remove provider conditionals from callers as each path moves. Do not leave two authoritative implementations.

### 6. Delete compatibility plumbing

- Remove `configureSessionProviders` callback wiring once adapters receive explicit dependencies.
- Remove direct Codex engine/process imports from provider-neutral callers.
- Rename modules to match final ownership only after behavior is migrated.

## Required Tests

Preserve all PR #329 regressions and add adapter contract tests that run against both implementations where semantics genuinely match.

### Shared contract

- spawn commits identity only after provider success
- failed spawn rolls back registry, thread membership, and reservations
- resume/fork preserve provider identity and artifacts
- retirement is idempotent under concurrent calls
- provider capability mismatches return explicit errors
- interactive surface failure does not imply engine death

### Codex-specific

- no keepalive reaches `steer` or `queueTurn`
- MCP control connect/disconnect cannot replace or disconnect the session
- queued next-turn delivery survives socket replacement exactly once locally
- definite rejection retries; unknown outcome does not replay
- late start acknowledgement after retirement is interrupted
- stale completion and stale socket-close events are ignored
- persisted orphan retirement converges across two restarts
- stale ownership generation cannot interrupt a successor
- concurrent home acquisition has one winner; loser performs zero filesystem/process mutations
- fork destination is checked/reserved before rollout replacement
- sibling thread survives retirement on a legacy shared app-server

### Claude-specific

- existing bridge, tmux, resume/fork, and pane behavior remains unchanged
- Claude keepalive behavior remains unchanged unless deliberately redesigned separately

### Integration gates

- full tests with isolated state:

  ```bash
  task_state_dir=$(mktemp -d)
  export HYDRA_STATE_DIR="$task_state_dir" DISCORD_STATE_DIR="$task_state_dir"
  bun test
  ```

- daemon entry-point bundle check:

  ```bash
  bun build daemon.ts --target=bun --outfile=/tmp/hydra-daemon-check.js
  ```

- `bun cli/hydra.ts restart discord` module validation
- disposable three-round Codex review
- cancel during active critic turn
- restart during owner/critic handoff
- verify a Codex MCP `reply` logs `control bridge registered` and never `replacing bridge`
- verify no `[system] keepalive` appears in a Codex rollout during a waiting phase

## Current Verification Baseline

At handoff:

- 1,223 tests pass with isolated state (69 files, 3,069 assertions), rechecked during the functionality audit
- daemon, CLI and bridge bundle checks pass; earlier #331 module validation passed
- Flint and Drift survive daemon restart and reconnect
- a live Codex MCP reply completes in under one second
- control registration no longer replaces/disconnects Flint
- Codex keepalive prevention exists at protocol and transport layers
- #331's disposable recovery harness covers limited live recovery/queue/UI cases with a stubbed gateway. Full Discord three-round review, restart during handoff and active-turn cancellation soak are still required; unit counts and that harness do not prove those gates.

## Pitfalls

- Never run the test suite against the production Discord state directory. Export an isolated `HYDRA_STATE_DIR` and `DISCORD_STATE_DIR` for the entire command sequence.
- Do not treat tmux as Codex liveness.
- Do not use a boolean for delivery or retirement outcomes; `unknown` is materially different from `false` or retryable rejection.
- Do not persist only human-readable names as authority.
- Do not move live-socket checks after rollout mutation.
- Do not let a failed cleanup disappear merely because the protocol run object is removed.
- Do not make `EngineAdapter` a giant dump of every provider-specific primitive. Its methods should express orchestration semantics.
- Do not mechanically unify Claude and Codex queues; their transport and turn semantics differ.

## Definition of Done

- Thread, protocol, recovery, health, and command callers invoke provider-neutral runtime operations.
- Claude/Codex mechanics are confined to their adapters and owned collaborators.
- `session-lifecycle.ts` is reduced to a compatibility facade or removed.
- All invariants and tests above pass.
- A fresh Codex review completes three rounds, cancellation cleans up the exact critic, restart preserves delivery/retirement state, and waiting consumes no synthetic model turns.
- The new PR is based on PR #331 (or its landed successor) and contains only the refactor plus its tests.

## Implementation progress — native launch extraction

Branch: `sf/session-runtime-refactor`, based on `sf/codex-command-parity`.
The audit/handoff and generator were preserved in commit `761947e`.

- `daemon/engines/engine-adapter.ts` defines typed native identity and fresh/resume/fork launch inputs.
- `ClaudeAdapter.spawn` owns native command/environment construction, tmux launch, exit markers, and pane capture.
- `CodexAdapter.spawn` owns home seeding, MCP configuration, detached process launch, and socket startup retries. Its engine and native I/O are injected.
- `session-lifecycle.ts` calls those adapters; registry publication and orchestration remain there for the next slice.
- `engine-launch.test.ts` characterizes matrix L06/L07/L08/L10/L13/L14/L16 and the native startup subset of L25. These use fake native I/O, not live providers or full registry rollback.
- Preserved existing fresh-only Claude tool restrictions, immediate-exit observational behavior, Codex provisional capabilities, and final persistent identity refresh.

This is **not completion**: expand the interface with delivery/retirement/health/recovery, consolidate `SessionProvider`, implement runtime transactions and rollback, migrate callers, add actual router/bridge integration tests, and run every live gate above. Do not infer full lifecycle coverage from native launch tests.

### Runtime and provider consolidation

`SessionRuntime` now contains spawn/kill/resume/respawn orchestration and accepts
its adapters through the constructor. `session-lifecycle.ts` is a compatibility
export facade. The two `SessionProvider` implementations and global
`configureSessionProviders` registration have been removed: native adapters also
own capabilities, UI repair, context, execution references and disconnect.
Recovery/thread-command native resume/fork paths call the runtime.

`session-runtime.test.ts` exercises actual runtime publication timing, failed
native launch, resolved models/native resume intent, and artifact carry-over with
fake adapters. This is headless Claude characterization, not yet the full
failure-boundary/ownership suite. Verified 1,240 tests (71 files) and all three
bundles after consolidation. Shared transactional rollback, semantic delivery and
retirement, remaining caller migration and all live gates remain outstanding.

### Spawn ownership and failure boundaries

`SpawnOwnership` synchronously reserves every provider's session name and Codex's
home before asynchronous preparation. Runtime rollback now removes provisional
registry/routing entries even when `beforeInitialTurn` fails, stops a successfully
launched native process if a later operation fails, and retains the owner plus a
durable retirement record if shutdown remains uncertain. Codex headless launches
skip synthetic chat routing and carry-over now applies to Codex records too.

Native `stop` and `isAlive` operations belong to adapters. Codex stop waits for the
socket to stop accepting connections before returning; Claude distinguishes a
missing session from failed termination of a live session. Concurrent runtime
kills await the same operation, and stale kills cannot target a successor's name.
The old delayed, name-based tmux kill has been removed.

Added tests exercise pre-launch callback failure for owner/guest routing,
post-launch failure, uncertain shutdown retention, concurrent kill completion,
stale kills and native stop verification. This still does **not** prove full
transaction rollback: worktree preparation failure/cleanup, observational history
rollback, native partial-start failure and all required live gates need coverage.
Semantic retirement/journal replay still lives in protocol-runner, and delivery
still routes through BridgeTransport/CodexEngine; migrate these next. The older
memory file's tmux-owned Codex process description is obsolete.
