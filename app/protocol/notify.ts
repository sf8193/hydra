import { registry } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import { safeSend } from '../../infra/util.js'
import { emojiOfName, formatRoundBadge, formatStateLine } from '../../sessions/anchor-state.js'
import { formatAdvanceUsagePattern, halfForPhase, WARNING_BEFORE_TIMEOUT_MS, type ProtocolRun } from './state.js'

export async function postStatusLine(run: ProtocolRun): Promise<void> {
  const half = halfForPhase(run)
  const actor = run.protocol.phases[run.phase]?.actor
  const actorSid = actor ? run.participants.get(actor) : undefined
  const name = actorSid ? registry.get(actorSid)?.tmuxName : undefined
  const roleLabel = actor ? run.protocol.roles[actor] : 'unknown'

  const action = name
    ? `${emojiOfName(name)} ${name} (${roleLabel}) is working...`
    : `${roleLabel} is working...`

  const text = formatStateLine(run.protocol.emoji, run.protocol.name, formatRoundBadge('', half, run.currentRound, run.rounds), action)
  run.statusHistory.push(text)
  const ids = await safeSend(run.threadId, text)
  run.messageIds.push(...ids)
}

export function notifyNextActor(run: ProtocolRun, prevContent: string): void {
  const actor = run.protocol.phases[run.phase]?.actor
  if (!actor) return
  const sid = run.participants.get(actor)
  if (!sid) return

  const actorName = registry.get(sid)?.tmuxName
  const actorLabel = actorName ? `**${actorName}**` : 'You'
  const advancePattern = formatAdvanceUsagePattern(run.protocol, run.phase)

  const windowMs = run.protocol.windowMs(run.phase)
  const windowMin = windowMs ? Math.round(windowMs / 60_000) : undefined
  const warningMin = windowMs && windowMs > WARNING_BEFORE_TIMEOUT_MS ? 2 : undefined
  const timeLine = windowMin
    ? ` You have ${windowMin} minutes${warningMin ? ` (warned at ${windowMin - warningMin})` : ''}. Use \`extend_phase()\` if you need more time.`
    : ''

  const notification = run.protocol.notifications.onTurn
    ? run.protocol.notifications.onTurn(run, prevContent)
    : [
        `[${run.protocol.display} — Round ${run.currentRound}/${run.rounds}]`,
        ``,
        prevContent,
        ``,
        `---`,
        `${actorLabel}, your turn. Use \`${advancePattern}\` to post your response. Use \`reply()\` for conversation only — it does not advance the protocol.${timeLine}`,
      ].join('\n')
  transport.sendOrQueue(sid, {
    type: 'notification',
    content: notification,
    handoff: true,
    meta: { chat_id: run.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
}

// Tell the actor its window is up, whatever happens next. Worth sending even
// when the next thing is retiring that session: a timed-out participant that
// reads its queue before it goes learns why, and the alternative — the actor
// hearing nothing on the fallback path but something on the cancel path — makes
// the two outcomes differ in a way that has nothing to do with the outcome.
export function notifyActorOfTimeout(run: ProtocolRun, actorSessionId: string | undefined, phase: string): void {
  if (!actorSessionId) return
  const actorInfo = registry.get(actorSessionId)
  const actorName = actorInfo?.tmuxName
  const namePrefix = actorName ? `**${actorName}**, phase` : `Phase`
  transport.sendOrQueue(actorSessionId, {
    type: 'notification',
    content: `[system] ⏰ ${namePrefix} "${phase}" timed out. The protocol is advancing.`,
    handoff: true,
    meta: { chat_id: run.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
}

export function notifyParticipant(run: ProtocolRun, sessionId: string, content: string): void {
  // A handoff: engines where every delivery is a priced turn (Codex) queue it
  // for the next turn rather than steering the current one.
  transport.sendOrQueue(sessionId, {
    type: 'notification',
    content,
    handoff: true,
    meta: { chat_id: run.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
}

export function notifyKickoff(run: ProtocolRun): void {
  const activeActor = run.protocol.phases[run.phase]?.actor
  const activeRole = activeActor ? run.protocol.roles[activeActor] : undefined
  const activeSid = activeActor ? run.participants.get(activeActor) : undefined
  const activeName = activeSid ? registry.get(activeSid)?.tmuxName : undefined
  const kickoffHooks = run.protocol.notifications.onKickoff

  for (const [role, sid] of run.participants) {
    const hook = kickoffHooks?.[role]
    if (hook) {
      const content = hook(run)
      if (content) notifyParticipant(run, sid, content)
      continue
    }
    if (role === activeActor) continue

    const ownerName = registry.get(run.ownerSessionId)?.tmuxName
    const ownerRole = run.protocol.ownerRole
    const ownerRoleLabel = ownerRole ? run.protocol.roles[ownerRole] : undefined
    const topic = run.params.topic as string | undefined

    const lines: string[] = [
      `[system] **${run.protocol.display}** — ${run.rounds} round${run.rounds > 1 ? 's' : ''}`,
    ]

    if (sid === run.ownerSessionId) {
      lines.push(``, `You are ${ownerRoleLabel ? `**${ownerRoleLabel}**` : 'the owner'}${ownerName ? ` (**${ownerName}**)` : ''}.`)
      if (activeName && activeRole) {
        lines.push(`**${activeName}** was spawned as ${activeRole} and is reading the thread to orient.`)
        if (topic) {
          lines.push(`${activeRole} was given the following prompt: '${topic}'`)
        }
      }
      lines.push(``, `When their response is ready, you'll be notified with the full post and instructions on how to respond.`)
    } else {
      lines.push(``, `${activeRole ?? 'The first actor'} is reading the thread to orient. You'll be notified when it's your turn.`)
    }

    notifyParticipant(run, sid, lines.join('\n'))
  }
}

export function notifyPhaseChange(run: ProtocolRun, from: string, to: string): void {
  const activeActor = run.protocol.phases[to]?.actor
  const activeSid = activeActor ? run.participants.get(activeActor) : undefined
  const activeName = activeSid ? registry.get(activeSid)?.tmuxName : undefined
  const roleLabel = activeActor ? run.protocol.roles[activeActor] : undefined

  const actorDesc = activeName && roleLabel
    ? `${activeName} (${roleLabel})`
    : roleLabel ?? `Phase: ${to}`

  const content = run.protocol.notifications.onPhaseChange?.(run, from, to)
    ?? `[${run.protocol.display} — Round ${run.currentRound}/${run.rounds}] ${actorDesc} is working.`
  for (const [role, sid] of run.participants) {
    if (role === activeActor) continue
    notifyParticipant(run, sid, content)
  }
}

export function notifyDisconnect(run: ProtocolRun, lostRole: string, reason: string): void {
  const content = run.protocol.notifications.onDisconnect?.(run, lostRole, reason)
    ?? `[system] ${run.protocol.roles[lostRole] ?? lostRole} disconnected: ${reason}`
  notifyParticipant(run, run.ownerSessionId, content)
}

export function notifyExit(run: ProtocolRun, outcome: 'complete' | 'cancelled', reason?: string): void {
  const content = run.protocol.notifications.onExit?.(run, outcome, reason)
    ?? (outcome === 'complete'
      ? `[system] ${run.protocol.display} complete — ${run.currentRound} round${run.currentRound > 1 ? 's' : ''}.`
      : `[system] ${run.protocol.display} cancelled: ${reason}`)
  for (const [, sid] of run.participants) {
    notifyParticipant(run, sid, content)
  }
}
