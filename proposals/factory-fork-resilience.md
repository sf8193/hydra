# Factory Fork Resilience

> Fixes for three bugs surfaced during the 2026-08-08 factory_done live test.
> Stacks on PR #197 (factory_done tool).

## Bugs

### 1. Builder state leaks to PM on failed fork

**What happens:** When `factory_build` forks tide → vale, the daemon stamps `isFactoryBuilder = true` on the registry entry. If the fork fails (CC dies, MCP disconnect), the builder state stays on the PM session. The recursion guard (`isFactoryBuilder` check in `bridge-dispatch.ts:309`) then blocks the PM from calling `factory_build` again.

**Root cause:** `factory.ts` stamps builder fields on the registry entry returned by `doSpawnSession` — but if the forked session dies immediately, the factory never cleans up. `factorySessionDeath` handles builder death (clears `builderSessionToTicket`), but the registry's `isFactoryBuilder` flag persists.

**Fix:** In `factorySessionDeath`, clear `isFactoryBuilder` / `factoryTicket` / `factoryPhase` on the dead session's registry entry. Also: if the builder never connected (bridge timeout), auto-transition to `awaiting_pm` with an error notification instead of leaving the build in `building` phase forever.

### 2. Builder prompt leaks to parent on fork collapse

**What happens:** The factory fork sends builder instructions ("You are a BUILDER session...") as a CLI argument to `claude --resume <id> --fork-session <prompt>`. When the fork fails and CC routes the prompt back to the parent session (or the parent picks it up via bridge notification), the PM sees role-override instructions it shouldn't see.

**Root cause:** The `promptPrefix` travels as a CLI argument. CC's fork is supposed to create an independent session, but on failure the prompt can surface in the parent's context via `send_to_thread` notifications or bridge message routing.

**Fix:** Two layers:
- **Defensive:** Add a guard in `factoryBuild` — if `doSpawnSession` succeeds but `waitForBridge` fails, kill the zombie builder and notify PM with "fork failed, try again" instead of leaving it alive.
- **Prompt hardening:** The builder prompt already says the session name ("You are vale, forked from tide"). If the model reads its own session context and finds a mismatch, it rejects the instructions — which is correct behavior. The fix is ensuring the instructions never reach the wrong session, not making them more aggressive.

### 3. No timeout on bridgeless builders

**What happens:** A factory builder loses its MCP bridge immediately after spawn. It sits idle for 40+ minutes — can't call `factory_done`, can't reply, can't read files. The PM gets no notification that the build is stuck.

**Root cause:** The idle-builder nudge (just built) sends nudges via `transport.sendOrQueue` — but if the bridge is disconnected, the nudge queues and never delivers. There's no fallback for "builder has no bridge."

**Fix:** In `nudgeIdleBuilder`, check `transport.has(sessionId)`. If the bridge is disconnected AND the builder has been idle for >2 minutes, auto-abort the build: kill the builder, transition to `awaiting_pm`, notify PM that the builder failed to connect. This is the same pattern as `tryResume`'s orphan detection.

## Implementation Plan

All three fixes go into `daemon/factory.ts` + `daemon/pane-probe.ts`. One PR stacked on #197.

| Fix | File | Lines | Risk |
|-----|------|-------|------|
| Builder state cleanup on death | `factory.ts` (factorySessionDeath) | ~10 | Low — additive cleanup |
| Bridge-failure auto-abort | `factory.ts` (spawnBuilder) + `pane-probe.ts` (nudgeIdleBuilder) | ~20 | Medium — new abort path |
| PM notification on fork failure | `factory.ts` (spawnBuilder catch) | ~5 | Low — error reporting |

## Test Plan

- Factory builder dies immediately → PM can call `factory_build` again (recursion guard cleared)
- Factory builder loses bridge → auto-aborted within 2 minutes, PM notified
- Factory builder loses bridge then reconnects within 2 min → NOT aborted (grace period)
- Normal factory flow unaffected (builder connects, builds, calls `factory_done`)
