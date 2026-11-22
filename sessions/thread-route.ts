// Where a post to a session's thread really goes. A thread id the gateway cannot address (a record that stored a session
// id or a name as its thread) would fail every post forever; a session that has no thread of its own is reached through
// the thread it reports to. One home for that rule: spawn, posts, visuals and relay links all ask here.
import { gateway } from '../infra/config.js'
import { parentSessionOf, registry } from './registry.js'
import type { SessionInfo } from './registry.js'
import { tellOnce } from '../infra/util.js'

const MAX_HOPS = 8

/** The thread `info` is posted to and linked through: its own when the gateway can address it, else its parent's, up the chain. */
export function routeThreadId(info: Pick<SessionInfo, 'sessionId' | 'threadId' | 'parentId' | 'tmuxName' | 'createdAt'>): string | undefined {
  const seen = new Set<string>()
  let s: Pick<SessionInfo, 'sessionId' | 'threadId' | 'parentId' | 'tmuxName' | 'createdAt'> | undefined = info
  while (s && !seen.has(s.sessionId) && seen.size < MAX_HOPS) {
    if (gateway.isThreadId(s.threadId)) return s.threadId
    seen.add(s.sessionId)
    s = parentSessionOf(s as SessionInfo)
  }
  return undefined
}

/** Boot: every record whose threadId the gateway cannot address is named once, with where its posts go instead. */
export function reportUnaddressableThreads(): number {
  let n = 0
  for (const s of registry.values()) {
    if (!s.threadId || gateway.isThreadId(s.threadId)) continue
    n++
    const via = routeThreadId(s)
    tellOnce(`record:${s.sessionId}`, `session ${s.tmuxName} stores "${s.threadId}" as its thread, which ${gateway.platform} cannot address; ${via ? `its posts go to the thread it reports to (${via})` : 'it reports to no thread, so its posts are dropped'}`)
  }
  return n
}
