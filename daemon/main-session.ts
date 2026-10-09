import { execFileSync } from 'child_process'
import { DEFAULT_SESSION_CHANNEL, PLATFORM } from './config.js'
import { byteTmuxName } from '../shared/constants.js'
import { engines } from './engines/instances.js'
import { tmuxHasSession } from './util.js'
import type { SessionInfo } from './sessions.js'
import type { InboundMessage } from '../gateway.js'

// Main (the byte) is launched by `hydra up`, not spawned by the daemon, so it has no registry
// record, and a registered one would run every registry loop's thread/lifecycle logic on it. This builds
// the record on demand for the few features that opt in (usage, peek) and never stores it.
// The model is a placeholder (contextWindowOf → null): the byte's real model isn't known here, so
// context % comes from the pane's own `ctx:` footer, not a guessed window.
export function mainSession(): SessionInfo | undefined {
  const tmuxName = byteTmuxName(PLATFORM)
  if (!DEFAULT_SESSION_CHANNEL || !tmuxHasSession(tmuxName)) return undefined
  let createdAt = Date.now()
  try {
    const sec = Number(execFileSync('tmux', ['display-message', '-p', '-t', tmuxName, '#{session_created}'], { stdio: 'pipe', timeout: 2000 }).toString())
    if (sec > 0) createdAt = sec * 1000
  } catch {}
  return {
    sessionId: 'main', topic: 'main', description: 'main hydra session', threadId: DEFAULT_SESSION_CHANNEL,
    createdAt, lastActive: Date.now(), tmuxName, listening: true,
    sessionMetadata: { role: 'main', tools: [], model: 'claude', cwd: '', platform: PLATFORM },
    engine: 'claude', sessionType: 'thread_owner', adapter: engines.claude,
  }
}

/** True for a plain (non-thread) message in the main channel. */
export const inMainChannel = (msg: Pick<InboundMessage, 'channelId' | 'isThread'>): boolean =>
  !msg.isThread && !!DEFAULT_SESSION_CHANNEL && msg.channelId === DEFAULT_SESSION_CHANNEL
