import { PLATFORM, STATE_DIR } from './config.js'
import { byteTmuxName } from '../shared/constants.js'
import { readMainRecord } from '../shared/main-record.js'
import { tmuxSync } from './tmux.js'
import { claudeEngine } from './engines/instances.js'
import type { InboundMessage } from '../gateway.js'

// Main (the byte) is launched by `hydra up`, not spawned by the daemon, so it has no registry record,
// and a registered one would run every registry loop's thread/lifecycle logic on it. These are the few
// questions the features that opt in (usage, peek, alerts, handoff) ask about it, answered from its
// tmux pane and the record `hydra up` wrote when it launched main (shared/main-record.ts). Main is always
// Claude, so it is asked through ClaudeSubject: no forged SessionInfo. The recorded model lets usage() read
// main's transcript on the same scale as every other session's; with none, it falls back to the pane footer.
export const mainTmux = (): string => byteTmuxName(PLATFORM)
export const mainSubject = () => {
  const model = readMainRecord(STATE_DIR)?.model
  return { tmuxName: mainTmux(), ...(model ? { sessionMetadata: { model } } : {}) }
}
export const mainAlive = (): boolean => claudeEngine.isAlive(mainSubject())

/** Context used, as "N%", or null when neither the transcript nor the pane says. */
export function mainContext(): string | null {
  const u = claudeEngine.usage(mainSubject())
  return u ? `${u.percent}%` : null
}

/** When the byte's tmux session started, in ms; now if tmux won't say. */
export function mainStartedAt(): number {
  try {
    const sec = Number(tmuxSync(['display-message', '-p', '-t', mainTmux(), '#{session_created}']))
    if (sec > 0) return sec * 1000
  } catch {}
  return Date.now()
}

/**
 * Whether usage/peek/handoff typed here are about main: any message outside a thread, which the router
 * sends to main. Narrower than the router on purpose: a message in a thread whose session died is routed
 * to main too, but there `usage` says ❌ (the thread has no session) rather than answering about main.
 */
export const isForMain = (msg: Pick<InboundMessage, 'isThread'>): boolean => !msg.isThread

// Where main's own notices (context alert) go: the channel it was last messaged in.
// Empty until the first message after a daemon start; nothing is sent until then.
let lastChannel = ''
export const noteMainChannel = (channelId: string): void => { lastChannel = channelId }
export const mainChannel = (): string => lastChannel
