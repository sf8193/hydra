/** Compatibility facade during caller migration. No lifecycle implementation lives here. */
export {
  sessionRuntime, SessionRuntime,
  doSpawnSession, killSession, tryResume, tryRespawn,
  waitForBridge, HEALTH_TIMEOUT_MS, RECOVERY_REVERIFY_GUARD,
  killsInProgress, discoverClaudeSessionId,
  resolveSpawnChannel, backfillAnchorChannelIds,
  resolveListenState, resolveListenStatePure,
  resolveForkSpawnCwd, buildWorktreePromptAppend,
} from './session-runtime.js'
