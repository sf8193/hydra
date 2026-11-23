// Session lifecycle public facade — split by verb under app/lifecycle/ (#893).
// Re-exports all public primitives so existing callers keep a single import path.

export {
  backfillAnchorChannelIds,
  buildWorktreePromptAppend,
  carryOver,
  claudeLaunchCwd,
  handoffArrival,
  nextResumeCount,
  predecessorOf,
  READ_ONLY_DISALLOWED_TOOLS,
  resolveForkSpawnCwd,
  resolveListenState,
  resolveListenStatePure,
  resolveSpawnChannel,
  spawnToolNames,
} from './lifecycle/channel.js'

export {
  KILL_HOOK_PATH,
  PRE_HANDOFF_HOOK_PATH,
  runKillHook,
  runPreHandoffHook,
  sessionDir,
  type HookSubject,
  type PreHandoffVerdict,
} from './lifecycle/hooks.js'

export {
  emitSessionDeath,
  killSession,
  killsInProgress,
  killTiming,
  restoreIfNotStarted,
  scratchSessionIds,
  splitOwnFromHistory,
} from './lifecycle/kill.js'

export {
  _refusalsKept,
  _resetRefusalNotices,
  _resetVerifyBackoff,
  refusedLaunches,
} from './lifecycle/spawn-stages.js'

export { doSpawnSession } from './lifecycle/spawn.js'

export {
  endForFreshStart,
  handOff,
  handoffIO,
  handoffNoteFate,
  handoffRequest,
  handoffSpawnOpts,
  requestHandoff,
  type HandoffNoteFate,
} from './lifecycle/handoff.js'

export {
  HEALTH_TIMEOUT_MS,
  RECOVERY_REVERIFY_GUARD,
  tryRespawn,
  tryResume,
  waitForBridge,
} from './lifecycle/revive.js'

// Claude session ID discovery lives in the Claude engine; re-exported for existing importers.
export { discoverClaudeSessionId } from '../engines/claude-engine.js'
