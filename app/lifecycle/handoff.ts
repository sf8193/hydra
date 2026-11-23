import { existsSync, mkdirSync, realpathSync } from 'fs'
import { join, resolve as resolvePath } from 'path'
import { gateway, STATE_DIR } from '../../infra/config.js'
import { safeSend } from '../../infra/util.js'
import { withThreadLock } from '../../sessions/specialists.js'
import { registry, repointChildren, threadRegistry } from '../../sessions/registry.js'
import type { SessionInfo, SpawnOpts, SpawnResult } from '../../sessions/registry.js'
import type { SessionEnd } from '../parent-notice.js'
import { transport } from '../../sessions/bridge-transport.js'
import { engineProfile } from '../../shared/engines/index.js'
import type { ProviderId } from '../../engines/engine-adapter.js'
import { readHandoffTemplate } from '../handoff-templates.js'
import { carryOver, predecessorOf, READ_ONLY_DISALLOWED_TOOLS } from './channel.js'
import { sessionDir } from './hooks.js'
import { killSession, restoreIfNotStarted } from './kill.js'
import { doSpawnSession } from './spawn.js'

/** Same file, however each side spelled it (/var vs /private/var). */
function sameLetter(a: string, b: string): boolean {
  const canon = (p: string) => { try { return realpathSync(p) } catch { return resolvePath(p) } }
  return a === b || canon(a) === canon(b)
}

/** What happens to `handoff: <note>`'s note for this letter, with the data each outcome needs. */
export type HandoffNoteFate =
  | { kind: 'none' }
  | { kind: 'carried'; text: string }        // the successor of this letter gets the note
  | { kind: 'dropped'; requested: string }   // the session wrote another letter than the one the request named

export function handoffNoteFate(info: SessionInfo, artifact: string): HandoffNoteFate {
  const note = info.handoffNote
  if (!note) return { kind: 'none' }
  return sameLetter(note.artifact, artifact) ? { kind: 'carried', text: note.text } : { kind: 'dropped', requested: note.artifact }
}


function withoutReadOnly(tools: string[] | undefined): string[] | undefined {
  const rest = tools?.filter(t => !READ_ONLY_DISALLOWED_TOOLS.includes(t))
  return rest?.length ? rest : undefined
}

/** Spawn opts for the successor: same thread/label/worktree and carried deliverables; model+engine from `handoff <model>` if given. */
export function handoffSpawnOpts(info: SessionInfo, artifact: string): SpawnOpts {
  const sel = info.handoffSelection
  const predecessor = predecessorOf(info)
  const fate = handoffNoteFate(info, artifact)
  const reuseWorktree = info.worktree
  return {
    existingThreadId: info.threadId,
    sessionType: info.sessionType,
    handedOffFrom: info.tmuxName,
    handoffFromClaudeSessionId: engineProfile(info.engine).recordsClaudeSessionId ? info.claudeSessionId : undefined,
    ...(predecessor && { predecessor }),
    artifact,
    // Only for the letter that request asked for: an abandoned request's note must not reach a later handoff.
    ...(fate.kind === 'carried' && { handoffNote: fate.text }),
    model: sel?.model ?? info.sessionMetadata?.model,
    engine: sel?.engine ?? info.engine,
    inheritedLabel: info.label,
    // killSession deletes the record, so the spawn can't snapshot these itself (same as recovery.ts)
    // The successor is the same session continuing, so it answers to the same parent.
    // A resume keeps read_only; a handoff successor starts without it (the documented contract). Other blocked tools stay.
    // Its predecessor is the session it replaces (`predecessorOf`, above), never that session's own predecessor.
    carryOver: { ...carryOver(info), predecessor: undefined, disallowedTools: withoutReadOnly(info.disallowedTools) },
    ...(reuseWorktree && { preserveWorktree: true, reuseWorktree }),
    // The successor starts where its predecessor launched (a specialist's workdir, a fork's source dir), while
    // that folder is still there; a kept worktree wins.
    ...(info.launchCwd && existsSync(info.launchCwd) && { cwd: info.launchCwd }),
  }
}

// Injectable for tests (like recoveryDeps): the real ones kill tmux and spawn sessions.
export const handoffIO = { killSession: (i: SessionInfo, r: string, o: { skipWorktreeDestroy: boolean; keepWatches: boolean; ended: SessionEnd }) => killSession(i, r, o), doSpawnSession: (t: string, c?: string, m?: string, o?: SpawnOpts) => doSpawnSession(t, c, m, o) }

/**
 * Replace a live session with a fresh one in the same thread, seeded from a
 * handoff file the old session wrote. The kill reason 'handed off' is not a
 * human Kill, so the on-kill retro skips it. PR watches move to the successor.
 * Holds the thread's target lock from kill to spawn, so no revive slips into the gap.
 */
export async function handOff(info: SessionInfo, artifact: string): Promise<SpawnResult> {
  return withThreadLock(info.threadId, async () => {
    // A second handoff of the same session waited behind the first, which has since replaced it.
    if (registry.get(info.sessionId) !== info) throw new Error(`${info.tmuxName} is already handing off (or gone)`)
    const opts = handoffSpawnOpts(info, artifact)
    await handoffIO.killSession(info, 'handed off', { skipWorktreeDestroy: true, keepWatches: true, ended: 'handed off' })
    const r = await restoreIfNotStarted(info, () => handoffIO.doSpawnSession(info.topic, undefined, undefined, opts), 'handoff')
    repointChildren(info, r.sessionId)  // its children now answer to the successor
    return r
  })
}

/**
 * kill_and_respawn's departing step, in place of a letter: mark the session's conversation as never to be continued (on disk, before
 * anything ends it, so a daemon restart mid-swap cannot resume it), then end the session as a handoff ends one. False, with nothing
 * ended: there was no history entry to mark. Not deliberate: its
 * PR watches, the messages held for its specialist and its bound conversations stay with the thread for the fresh session. A fresh
 * start continues no worktree, so a clean one goes (one with work at risk is kept, as on any kill). The caller holds the thread's lock.
 */
export async function endForFreshStart(info: SessionInfo): Promise<boolean> {
  // Fail closed: with no entry to mark, a later revive could find an older, unmarked one; nothing is ended.
  if (!threadRegistry.markRestartedFresh(info.threadId, info.sessionId)) return false
  // The thread stops pointing at it first: a message arriving while the kill runs finds nobody home (and is held for the specialist),
  // instead of landing in a conversation that will never be continued. Put back if the kill throws with the thread still unclaimed.
  const mapped = registry.getByThread(info.threadId) === info.sessionId
  if (mapped) registry.deleteThread(info.threadId)
  try {
    await handoffIO.killSession(info, 'restarting fresh: handoff_protocol = "kill_and_respawn" starts a new session here from the kickoff, with no letter', { skipWorktreeDestroy: false, keepWatches: true, ended: 'handed off' })
  } catch (err) {
    if (mapped && registry.get(info.sessionId) === info && registry.getByThread(info.threadId) === undefined) registry.setThread(info.threadId, info.sessionId)
    throw err
  }
  return true
}

export function handoffRequest(artifact: string, requester: string | undefined, note?: string): string {
  return [
    requester ? `[system] ${requester} asked you to hand off this thread to a fresh session.` : `[system] hydra is handing this thread off to a fresh session automatically.`,
    ...(note ? [`Their note for the next session: "${note}". Carry it into Next action.`] : []),
    `Write ${artifact} with these sections: Goal; Non-goals (what is explicitly out of scope); State (branch, last commit, current step);`,
    `Decisions & constraints (including rejected ideas); Open questions for ${requester ?? 'the user'}; Next action.`,
    `Then call the handoff tool with path="${artifact}". Do nothing else after that.`,
  ].join(' ')
}

/**
 * Ask the live session to write its state and hand off; returns the path it is asked to write. `msgId` is the
 * command message to react and reply to; absent for a daemon-started handoff, which also has no `requester` and no
 * `options`: only the `handoff` command writes the model choice and note, so an automatic ask keeps a pending one. If the automatic letter is the one that lands, `handoffNoteFate` reports the note as not carried.
 */
export function requestHandoff(info: SessionInfo, { channelId, msgId, threadId, requester, options }: { channelId: string; msgId?: string; threadId: string; requester?: string; options?: { selection?: { model: string; engine: ProviderId }; note?: string } }): string {
  const { selection, note } = options ?? {}
  const artifact = join(STATE_DIR, 'handoffs', `${info.tmuxName}-${Date.now()}.md`)
  mkdirSync(join(STATE_DIR, 'handoffs'), { recursive: true })
  info.handoffArtifact = artifact
  if (options) {
    info.handoffSelection = selection
    info.handoffNote = note ? { text: note, artifact } : undefined
  }
  const vars = {
    artifact, session: info.tmuxName, requester: requester ?? 'hydra', model: selection?.model ?? '', note: note ?? '',
    cwd: sessionDir(info) ?? '', worktree: info.worktree?.path ?? '', branch: info.worktree?.branch ?? '', label: info.label ?? '',
  }
  transport.sendOrQueue(info.sessionId, {
    type: 'notification',
    content: readHandoffTemplate('departing', vars) ?? handoffRequest(artifact, requester, note),
    meta: { chat_id: threadId, message_id: msgId ?? '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
  })
  if (msgId) void gateway.react(channelId, msgId, '🤝').catch(() => {})
  // A kill mid-handoff loses whatever the session has not yet written down, so look before killing.
  const notice = readHandoffTemplate('notice', vars)
    ?? `_Asked \`${info.tmuxName}\` to write \`${artifact}\` and hand off. If nothing happens in a few minutes, \`peek\` it before you \`kill\` and \`respawn\`._`
  // Echoed under any notice, local or built-in, so a note that didn't parse can't look like one that did.
  // Whether it reached the successor is said when the handoff lands. Mentions are defused: an echo must not ping.
  const confirmed = note ? `${notice}\n> Note to pass on: ${note.replace(/@/g, '@\u200b').replace(/\n/g, '\n> ')}` : notice
  // safeSend: a local notice can run past the platform's length limit; chunk it and log failures.
  void safeSend(channelId, confirmed, msgId ? { replyTo: msgId } : undefined)
  return artifact
}
