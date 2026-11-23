import type { SessionInfo } from '../../sessions/registry.js'

/** An adapter's reconnect attempts that all follow one verdict: true connects (resumed or on a new thread), false does not. */
export const reconnecting = (fn: (info: SessionInfo) => Promise<boolean>) => ({
  reachable: async () => true,
  resumeThread: async (info: SessionInfo) => (await fn(info)) ? 'connected' as const : 'lost' as const,
  connectNewThread: async (info: SessionInfo) => (await fn(info)) ? 'connected' as const : 'failed' as const,
})
