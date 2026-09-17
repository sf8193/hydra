// daemon/spawn-verification.ts
//
// Birth-time verification: a spawned session must be reachable before the spawn
// path is done with it.

import { registry, threadRegistry } from './sessions.js'
import { debugLogSize } from './engines/claude-engine.js'
import type { EngineAdapter, LaunchInput, LaunchResult } from './engines/engine-adapter.js'

/**
 * Make sure a freshly spawned session has a channel back to the daemon.
 *
 * Claude Code intermittently resolves a session's MCP config without the bridge
 * in it — the plugin loads, its skills appear, and the bridge is never started,
 * skipped or errored. Nothing in the session can report this, because reporting
 * is the thing it lost. The process stays bridgeless for life: stdio MCP servers
 * are never auto-reconnected.
 *
 * A session in that state is not a degraded session, it is a failed spawn — it
 * cannot receive, reply, or be steered. So the spawn path retries it once, the
 * way it would any other transient launch failure, rather than registering it as
 * live and leaving the liveness monitor to discover minutes later that it never
 * had a channel to begin with.
 *
 * Called after the session is in the registry: a bridge that connects before
 * that lands on `thread_owner` defaults for its tool surface, which is wrong for
 * join and guest sessions.
 */
export async function ensureBridgeAttached(args: {
  adapter: EngineAdapter
  launchInput: LaunchInput
  launched: LaunchResult
  sessionId: string
  tmuxName: string
}): Promise<void> {
  const { adapter, launchInput, launched, sessionId, tmuxName } = args
  if (!adapter.awaitBridge) return

  const first = await adapter.awaitBridge({ sessionId, launched, debugLogFrom: 0 })
  if (first.attached) return

  process.stderr.write(`daemon: spawn ${tmuxName}: no bridge (${first.reason}) — respawning once\n`)

  // Read the mark before the retry writes past it: both attempts append to the
  // same debug log, whose name is keyed on the hydra session and tmux name, and
  // neither changes across a retry.
  const debugLogFrom = debugLogSize(launched.debugLogPath)

  const info = registry.get(sessionId)
  if (info) {
    try { await adapter.stop(info) } catch (err) {
      process.stderr.write(`daemon: spawn ${tmuxName}: stop before respawn failed: ${err}\n`)
    }
  }

  let relaunched: LaunchResult
  try {
    relaunched = await adapter.launch(launchInput)
  } catch (err) {
    process.stderr.write(`daemon: spawn ${tmuxName}: respawn failed: ${err}\n`)
    return
  }

  adoptRelaunch(sessionId, relaunched)

  const second = await adapter.awaitBridge({ sessionId, launched: relaunched, debugLogFrom })
  if (second.attached) {
    process.stderr.write(`daemon: spawn ${tmuxName}: bridge attached on respawn\n`)
    return
  }

  // Twice is where this stops. A third attempt buys little against a fault this
  // rare and risks a spawn loop; the orphan alert is the right terminal state.
  process.stderr.write(`daemon: spawn ${tmuxName}: still no bridge after respawn (${second.reason}) — leaving it to orphan detection\n`)
}

/**
 * Point the session record at the process that replaced it.
 *
 * Only the engine's session id moves: the log paths are derived from the hydra
 * session id and tmux name, which the retry reuses.
 */
function adoptRelaunch(sessionId: string, relaunched: LaunchResult): void {
  const info = registry.get(sessionId)
  if (!info || !relaunched.claudeSessionId) return

  info.claudeSessionId = relaunched.claudeSessionId
  registry.persist()

  const thread = threadRegistry.get(info.threadId)
  if (!thread) return
  const open = thread.sessionHistory.find(h => h.sessionId === sessionId && !h.endedAt)
  if (open) {
    open.claudeSessionId = relaunched.claudeSessionId
    threadRegistry.persist()
  }
}
