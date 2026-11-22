import { registry } from '../sessions/registry.js'
import { transport } from '../sessions/bridge-transport.js'
import { safeSend } from '../infra/util.js'
import { confirmedStuckState, isBlockingKind, resolveStuckFromHome } from './pane-probe.js'
import { handleResumeIntercept } from './commands/thread.js'
import { refreshDashboardNow } from './dashboard.js'
import { daemonPastOrphanGrace } from '../sessions/session-reachability.js'
import { homeRecoverable } from '../infra/home-status.js'

const liveDeps = {
  session: (sessionId: string) => registry.get(sessionId),
  connected: (sessionId: string) => transport.has(sessionId),
  stuck: confirmedStuckState,
  daemonWarm: () => daemonPastOrphanGrace(),
  send: safeSend,
  resume: handleResumeIntercept,
  resolveStuck: resolveStuckFromHome,
  refresh: refreshDashboardNow,
}

export async function runHomeStatusAction(sessionId: string, shown: string, deps: typeof liveDeps = liveDeps): Promise<void> {
  try {
    const info = deps.session(sessionId)
    if (!info) return
    if (shown === 'disconnected') {
      if (deps.connected(sessionId) || !homeRecoverable(info.sessionType, deps.stuck(info.tmuxName), deps.daemonWarm())) return
      const [anchorId] = await deps.send(info.threadId, `> ⏯️ Recover requested for **${info.tmuxName}** from the Home tab.`)
      if (!anchorId) {
        process.stderr.write(`daemon: home recover ${info.tmuxName}: thread post failed, recover not started\n`)
        return
      }
      await deps.resume({ id: anchorId, channelId: info.threadId, isThread: true, effectiveThreadId: info.threadId })
    } else if (isBlockingKind(shown)) {
      await deps.resolveStuck(info.tmuxName, shown)
    }
  } finally {
    deps.refresh()
  }
}
