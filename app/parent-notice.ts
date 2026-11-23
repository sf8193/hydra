import { safeSend } from '../infra/util.js'
import { emojiOf } from '../sessions/anchor-state.js'
import { parentSessionOf, type SessionInfo } from '../sessions/registry.js'

/** The verb in the parent's notice: who ended the session, and how. `died` alone is what an end nobody classified yet says. */
export type SessionEnd = 'killed' | 'killed & destroyed' | 'killed by hydra' | 'died from crash' | 'finished' | 'handed off'

/**
 * Notify a session's parent thread when the child ends (kill, finish, handoff, or crash).
 * Gated on authority (`parentSessionOf`), never on `originFrom` — plain-spawned children
 * have `parentId` without `originFrom` (#736). Guests and same-thread children are skipped
 * because their end is already reported in that thread.
 */
export function notifyParentOfEnd(info: SessionInfo, ended: SessionEnd | undefined, reason: string): void {
  if (info.sessionType === 'thread_guest') return
  const parent = parentSessionOf(info)
  if (!parent || parent.threadId === info.threadId) return
  const msgs = info.messageCount ?? 0
  const emoji = emojiOf(info)
  void safeSend(
    parent.threadId,
    `${emoji} \`${info.tmuxName}\` ${ended ?? 'died'}${ended === 'handed off' ? '' : ` — _${reason}_`} (${msgs} msgs)`,
  )
}
