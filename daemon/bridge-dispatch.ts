import { existsSync, statSync } from 'fs'
import { execSync } from 'child_process'
import { gateway, INBOX_DIR } from './config.js'
import { isParentOf, registry, resolveSendTarget, threadRegistry, type Predecessor, type SessionInfo, type ThreadSessionEntry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { loadAccess, maxChunkLimit, MAX_ATTACHMENT_BYTES } from './access.js'
import { claudeLaunchCwd, doSpawnSession, handOff, killSession, predecessorOf } from './session-lifecycle.js'
import { fallbackDescription, formatDuration, chunk, assertSendable, isAlive, tmuxHasSession, parseDuration } from './util.js'
import { formatContextPercent } from './engines/engine-adapter.js'
import { resolveEngine } from './engines/instances.js'
import { dispatchAdvance, finishPrivateProtocolChildLaunch, isProtocolParticipant, markPrivateProtocolChildLaunching, protocolChildRequiresPrivate, protocolSpawnRequiresPrivate, registerProtocolChild, registerProtocolChildResult } from './protocol-registry.js'
import { watchPr, unwatchPr, listWatches, getWatchesBySession, formatWatchEntry, detectPrUrl, WATCH_ERRORS } from './pr-watch.js'
import { refreshSessionVisual } from './anchor-state.js'
import { refreshDashboard } from './dashboard.js'
import { extractArtifactLinks, mergeArtifacts, sanitizeArtifacts, cachePrTitle } from './artifacts.js'
import { fetchPrTitle, parsePrUrl } from './pr-watch.js'
import { factoryBuild, factoryRetry, factoryAccept, factoryAbandon, factoryStatus, factoryReview, onBuilderDone, suggestWorktreeFromCwd, VALID_DIFFICULTIES, type Difficulty, type FactoryDoneArgs } from './factory.js'
import { normalizeReviewRounds } from '../shared/constants.js'
import { isToolAllowed } from './tool-surface.js'

const SEND_RETRY_ATTEMPTS = 3
const SEND_RETRY_BASE_MS = 1_000
const RETRYABLE_PATTERNS = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EPIPE|socket hang up|not connected|network/i
const PRIVATE_HELPER_ALLOWED_TOOLS = new Set([
  'fetch_messages', 'list_sessions', 'peek_session', 'download_attachment',
  'set_description', 'send_to_thread',
])

function resolveProtocolSpawnMode(callerSessionId: string | undefined, requestedHeadless: boolean | undefined) {
  const privateSpawn = !!(callerSessionId && protocolSpawnRequiresPrivate(callerSessionId))
  return { privateSpawn, headless: privateSpawn || requestedHeadless === true, quiet: privateSpawn }
}

export const __test = process.env.NODE_ENV === 'test'
  ? { PRIVATE_HELPER_ALLOWED_TOOLS, resolveProtocolSpawnMode }
  : undefined

// read_only: blocks Claude's file-editing tools. Bash remains, so it is a guard, not a sandbox.
const READ_ONLY_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit']

/**
 * The session that ran under this name: the live record, else the latest dead record,
 * else the latest thread-history entry. Never its successor — that is a different conversation.
 */
function findSessionByName(name: string): { record: SessionInfo } | { history: ThreadSessionEntry } | undefined {
  const records = [...registry.values()].filter(s => s.tmuxName === name)
  const record = records.find(s => !s.deadAt) ?? records.sort((a, b) => (b.deadAt ?? 0) - (a.deadAt ?? 0))[0]
  if (record) return { record }
  let latest: ThreadSessionEntry | undefined
  for (const thread of threadRegistry.threads.values()) {
    for (const h of thread.sessionHistory) {
      if (h.tmuxName === name && (h.endedAt ?? h.startedAt) >= (latest ? latest.endedAt ?? latest.startedAt : -Infinity)) latest = h
    }
  }
  return latest && { history: latest }
}

/** A fork source rebuilt from a history entry, whose record is gone. History keeps no cwd: a Claude transcript names it. */
function forkSourceOfHistory(h: ThreadSessionEntry): Predecessor | undefined {
  const engine = h.engine ?? 'claude'
  const fork = resolveEngine(engine).recoveryPlan({ tmuxName: h.tmuxName, claudeSessionId: h.claudeSessionId, codexThreadId: h.codexThreadId, codexHomeName: h.codexHomeName }).fork
  if (!fork) return undefined
  // A Codex source is refused before launch, so its missing cwd never matters.
  const cwd = fork.claudeSessionId ? claudeLaunchCwd(fork.claudeSessionId) : process.env.SPAWN_CWD
  if (!cwd) throw new Error(`fork_from: no transcript found for ${h.tmuxName} — its conversation is gone; spawn fresh with read_thread instead`)
  return { engine, fork, cwd, ...(h.model ? { model: h.model } : {}) }
}

/**
 * spawn_session fork_from: a session name, or "predecessor" for the caller's own.
 *
 * Reads are universal, authority is the spawner's. Any session can fork any other by name:
 * every session runs as the same user and can already read any transcript on disk, so a
 * fork grants no new information access. Control of the fork (kill, peek, death notice)
 * belongs to the spawner — see isParentOf.
 */
function resolveForkSource(name: string, callerSessionId: string | undefined): Predecessor {
  let source: Predecessor | undefined
  if (name === 'predecessor') {
    const caller = callerSessionId ? registry.get(callerSessionId) : undefined
    source = caller?.predecessor
    if (!source) throw new Error(`fork_from="predecessor": ${caller?.tmuxName ?? 'this session'} has no predecessor — only a session that took over by handoff has one`)
  } else {
    const found = findSessionByName(name)
    if (!found) throw new Error(`fork_from: no session named "${name}" — call list_sessions for live names`)
    source = 'record' in found ? predecessorOf(found.record) : forkSourceOfHistory(found.history)
    if (!source) throw new Error(`fork_from: ${name} has no conversation id to fork — spawn fresh with read_thread instead`)
  }
  // A Codex fork launches its own app-server in a fresh CODEX_HOME, where the source's
  // rollout is not found; launching in the source's home would restart its app-server.
  if (source.engine === 'codex') throw new Error(`fork_from: ${source.fork.parentName} is a Codex session, and Codex sessions cannot be forked yet — spawn fresh with read_thread instead`)
  // Checked here, before doSpawnSession creates a thread; its own check is the backstop for resumes.
  if (!existsSync(source.cwd)) throw new Error(`cannot fork: the source's launch directory ${source.cwd} no longer exists`)
  return source
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return RETRYABLE_PATTERNS.test(msg)
}

async function retrySend<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < SEND_RETRY_ATTEMPTS; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === SEND_RETRY_ATTEMPTS - 1 || !isRetryable(err)) throw err
      const delay = SEND_RETRY_BASE_MS * Math.pow(2, i)
      process.stderr.write(`daemon: send failed (attempt ${i + 1}/${SEND_RETRY_ATTEMPTS}), retrying in ${delay}ms: ${err instanceof Error ? err.message : err}\n`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw new Error('unreachable')
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export type ToolResult = { content: Array<{type: string; text: string}>; isError?: boolean; sentIds?: string[] }

export async function executeTool(name: string, args: Record<string, unknown>, callerSessionId?: string): Promise<ToolResult> {
  try {
    // Bridge-server enforces this at the socket boundary. Keep the dispatcher
    // fail-closed too: Codex advertises phase-scoped tools statically, and tests
    // or future callers may invoke executeTool without crossing bridge-server.
    if (callerSessionId && !isToolAllowed(callerSessionId, name)) {
      throw new Error(`${name} is not available to this session`)
    }
    // A private protocol helper must not bypass send_to_thread's visibility
    // policy through another gateway-mutating tool. Keep this centralized so
    // every public write stays denied until the helper is fully retired.
    if (callerSessionId && protocolChildRequiresPrivate(callerSessionId) && !PRIVATE_HELPER_ALLOWED_TOOLS.has(name)) {
      throw new Error(`${name} is unavailable to a private protocol helper`)
    }
    switch (name) {
      case 'reply': {
        const chat_id = args.chat_id as string
        const text = args.text as string
        const reply_to = args.reply_to as string | undefined
        const files = (args.files as string[] | undefined) ?? []

        const ch = await gateway.fetchChannel(chat_id)
        const access = loadAccess()
        if (ch.isDM) {
          if (!access.allowFrom.includes(ch.recipientId)) {
            throw new Error(`channel ${chat_id} is not allowlisted (DM recipient ${ch.recipientId || 'unknown'})`)
          }
        } else {
          const key = ch.isThread ? ch.parentId ?? ch.id : ch.id
          if (!(key in access.groups)) {
            throw new Error(`channel ${chat_id} is not allowlisted`)
          }
        }

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
          }
        }
        if (files.length > 10) throw new Error('max 10 attachments per message')

        const limit = Math.max(1, Math.min(access.textChunkLimit ?? maxChunkLimit(), maxChunkLimit()))
        const mode = access.chunkMode ?? 'markdown'
        const replyMode = access.replyToMode ?? 'first'

        const chunks = chunk(text, limit, mode)
        const sentIds: string[] = []

        try {
          for (let i = 0; i < chunks.length; i++) {
            const shouldReplyTo =
              reply_to != null &&
              replyMode !== 'off' &&
              (replyMode === 'all' || i === 0)
            const sent = await retrySend(() => gateway.send(chat_id, chunks[i], {
              ...(i === 0 && files.length > 0 ? { files } : {}),
              ...(shouldReplyTo ? { replyTo: reply_to } : {}),
            }))
            sentIds.push(sent.id)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
        }

        if (callerSessionId && sentIds.length > 0) {
          const info = registry.get(callerSessionId)
          if (info) {
            info.lastReplyId = sentIds[sentIds.length - 1]
            // lastReplyId drives the session's dashboard/list link — refresh (debounced) so it tracks the latest reply.
            refreshDashboard()
            // A live reply means the session is working. If the factory sweep parked it as an
            // awaiting_pm builder (suppressAutoRecover + clearFactoryIdentity, left alive) and a
            // user then adopted it, clear the now-stale flag so a later reboot auto-recovers it.
            // Only live sessions reach here — dead branch-gone / mid-build-preserved records
            // (also suppressAutoRecover) never reply, so their suppression stays intact.
            if (info.suppressAutoRecover) delete info.suppressAutoRecover
            // Capture artifact links the session produced in its own thread, so
            // they surface under its Home item (chat_id === threadId scopes this
            // to the session's own workspace, not cross-posts to other channels;
            // verified: spawned/resurrect sessions reply with chat_id === threadId).
            if (chat_id === info.threadId) {
              // Sanitize existing entries too (same as the backfill path in daemon.ts),
              // so any legacy-malformed persisted URL self-heals rather than carrying forward.
              // Compare against the raw prior list so a sanitize-only cleanup (even when the
              // reply carries no new artifact URL) still persists and refreshes the dashboard.
              const before = info.artifacts ?? []
              const newLinks = extractArtifactLinks(text)
              const { next, changed } = mergeArtifacts(sanitizeArtifacts(before), newLinks)
              if (JSON.stringify(next) !== JSON.stringify(before)) {
                info.artifacts = next
                refreshDashboard()
              }
              if (changed) {
                for (const url of newLinks) {
                  if (!parsePrUrl(url)) continue
                  fetchPrTitle(url).then(title => {
                    if (title) { cachePrTitle(url, title); refreshDashboard() }
                  }).catch(() => {})
                }
              }
            }
            registry.debouncedPersist()
          }
        }

        const result =
          sentIds.length === 1
            ? `sent (id: ${sentIds[0]})`
            : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
        return { content: [{ type: 'text', text: result }], sentIds }
      }

      case 'fetch_messages': {
        const channelId = args.channel as string
        const limit = Math.min((args.limit as number) ?? 20, 100)
        const msgs = await gateway.fetchMessages(channelId, limit)
        const botId = gateway.botId
        const out =
          msgs.length === 0
            ? '(no messages)'
            : msgs
                .map(m => {
                  const who = m.authorId === botId ? 'me' : m.authorUsername
                  const atts = m.attachmentCount > 0 ? ` +${m.attachmentCount}att` : ''
                  const text = m.content.replace(/[\r\n]+/g, ' ⏎ ')
                  return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
                })
                .join('\n')
        return { content: [{ type: 'text', text: out }] }
      }

      case 'react': {
        if (gateway.platform === 'slack') return { content: [{ type: 'text', text: 'no-op on Slack (reactions disabled)' }] }
        await retrySend(() => gateway.react(args.chat_id as string, args.message_id as string, args.emoji as string))
        return { content: [{ type: 'text', text: 'reacted' }] }
      }

      case 'edit_message': {
        const edited = await retrySend(() => gateway.edit(args.chat_id as string, args.message_id as string, args.text as string))
        return { content: [{ type: 'text', text: `edited (id: ${edited})` }] }
      }

      case 'delete_message': {
        await gateway.delete(args.chat_id as string, args.message_id as string)
        return { content: [{ type: 'text', text: 'deleted' }] }
      }

      case 'create_thread': {
        const threadName = (args.name as string).slice(0, 100)
        const thread = await gateway.createThread(args.chat_id as string, threadName, {
          messageId: args.message_id as string | undefined,
          archiveDuration: (args.auto_archive_minutes as number | undefined) ?? 1440,
          text: args.text as string | undefined,
          files: (args.files as string[] | undefined),
        })
        return {
          content: [{
            type: 'text',
            text: `thread created (thread_id: ${thread.id})`,
          }],
        }
      }

      case 'download_attachment': {
        const results = await gateway.downloadAttachments(
          args.chat_id as string,
          args.message_id as string,
          INBOX_DIR,
        )
        if (results.length === 0) {
          return { content: [{ type: 'text', text: `message ${args.message_id} has no downloadable attachments` }] }
        }
        const lines = results.map(r => `  ${r.path}  (${r.name}, ${r.contentType}, ${r.sizeKB}KB)`)
        return {
          content: [{ type: 'text', text: `downloaded ${results.length} attachment(s):\n${lines.join('\n')}` }],
        }
      }

      case 'spawn_session': {
        // Capture this before the asynchronous spawn. If the protocol ends while
        // the child is launching, its capabilities are removed and registry
        // lookup returns not_protocol; it is still our responsibility to reap it.
        const protocolScopedSpawn = !!(callerSessionId && registry.get(callerSessionId)?.capabilities?.includes('protocol_spawn'))
        const spawnMode = resolveProtocolSpawnMode(callerSessionId, args.headless as boolean | undefined)
        const privateProtocolSpawn = spawnMode.privateSpawn
        const worktree = args.worktree as string | undefined
        const forkFromRaw = (args.fork_from as string | undefined)?.trim() || undefined
        if (forkFromRaw && worktree) throw new Error('fork_from cannot be combined with worktree — a fork runs where its source ran')
        const source = forkFromRaw ? resolveForkSource(forkFromRaw, callerSessionId) : undefined
        const readOnly = args.read_only === true
        const topic = worktree ? `worktree:${worktree} ${args.topic}` : args.topic as string
        const model = (args.model as string | undefined)?.trim() || source?.model
        if (model) process.stderr.write(`daemon: spawn_session model override: ${model}\n`)
        const budgetRaw = (args.phase_budget as string | undefined)?.trim() || undefined
        const phaseBudgetMs = budgetRaw ? parseDuration(budgetRaw) ?? undefined : undefined
        if (budgetRaw && !phaseBudgetMs) throw new Error(`invalid phase_budget "${budgetRaw}" — use e.g. "90s", "20m", "1h"`)
        const headless = spawnMode.headless
        const readThreadRaw = args.read_thread as boolean | number | undefined
        const spawnerName = callerSessionId ? registry.get(callerSessionId)?.tmuxName ?? 'main' : 'main'
        let readThreadPrefix = ''
        if (readThreadRaw) {
          const limit = typeof readThreadRaw === 'number' ? Math.min(100, Math.max(10, Math.round(readThreadRaw))) : 50
          const spawnerInfo = callerSessionId ? registry.get(callerSessionId) : undefined
          const parentThread = spawnerInfo?.threadId
          if (parentThread) {
            readThreadPrefix = `Read the history of your parent thread for context before starting work:\n  fetch_messages(channel="${parentThread}", limit=${limit})\n\n`
          } else {
            process.stderr.write(`daemon: spawn_session read_thread requested by ${spawnerName} but spawner has no thread — ignoring\n`)
          }
        }
        let preLaunchRegistration: ReturnType<typeof registerProtocolChild> | undefined
        let allocatedSessionId: string | undefined
        let result: Awaited<ReturnType<typeof doSpawnSession>>
        try {
          result = await doSpawnSession(topic, args.chat_id as string | undefined, args.message_id as string | undefined, {
          ...(model ? { model } : {}),
          // engine: always 'claude' while Codex sources are refused; it matters once Codex forks are supported.
          ...(source ? { forkFrom: source.fork, launchCwd: source.cwd, engine: source.engine } : {}),
          ...(readOnly ? { disallowedTools: READ_ONLY_DISALLOWED_TOOLS } : {}),
          ...(phaseBudgetMs ? { phaseBudgetMs } : {}),
          ...(headless ? { headless: true } : {}),
          ...(spawnMode.quiet ? { quiet: true } : {}),
          ...(readThreadPrefix ? { promptPrefix: readThreadPrefix } : {}),
          ...(privateProtocolSpawn ? { beforeInitialTurn: (sessionId: string) => {
            allocatedSessionId = sessionId
            markPrivateProtocolChildLaunching(callerSessionId!, sessionId)
            preLaunchRegistration = registerProtocolChild(callerSessionId!, sessionId, {
              headless: true,
              readThread: !!readThreadPrefix,
              phaseBudgetMs,
            })
            if (preLaunchRegistration !== 'registered') {
              finishPrivateProtocolChildLaunch(sessionId)
              throw new Error('protocol phase ended before spawned session could be registered')
            }
          } } : {}),
          trigger: 'spawn_session',
          initiator: spawnerName,
          ...(callerSessionId && registry.has(callerSessionId) ? { parentId: callerSessionId } : {}),
          })
        } catch (err) {
          if (allocatedSessionId) finishPrivateProtocolChildLaunch(allocatedSessionId)
          throw err
        }
        // Revalidate after launch even when registration succeeded before it.
        // The phase may have ended while the engine was starting.
        const childRegistration = callerSessionId
          ? registerProtocolChild(callerSessionId, result.sessionId, {
              headless: headless === true,
              readThread: !!readThreadPrefix,
              phaseBudgetMs,
            })
          : 'not_protocol'
        if (protocolScopedSpawn && childRegistration !== 'registered') {
          const child = registry.get(result.sessionId)
          if (child) await killSession(child, 'protocol phase ended during spawn').catch(() => {})
          if (allocatedSessionId) finishPrivateProtocolChildLaunch(allocatedSessionId)
          throw new Error('protocol phase ended before spawned session could be registered')
        }
        if (allocatedSessionId) finishPrivateProtocolChildLaunch(allocatedSessionId)
        return { content: [{ type: 'text', text: `session spawned (name: ${result.name}, session_id: ${result.sessionId}, thread_id: ${result.threadId}${result.url ? `, url: ${result.url}` : ''})` }] }
      }

      case 'list_sessions': {
        const sorted = [...registry.values()].filter(s => isAlive(s)).sort((a, b) => b.lastActive - a.lastActive)
        const list = sorted.map(s => {
          const desc = s.description ?? fallbackDescription(s.topic)
          return {
            name: s.tmuxName,
            description: desc,
            thread_id: s.threadId,
            // Link to the session's latest reply (like dashboard.ts / cli-handler.ts), falling back to the thread anchor.
            url: (s.lastReplyId ? gateway.getMessageUrl(s.threadId, s.lastReplyId) : '') || s.threadUrl || '',
            context: formatContextPercent(s.adapter, s),
            messages: s.messageCount ?? 0,
            running_for: formatDuration(Date.now() - s.createdAt),
            status: transport.has(s.sessionId) ? 'connected' : 'disconnected',
            origin_type: s.originType ?? 'spawn',
            origin_from: s.originFrom ?? null,
          }
        })
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
      }

      case 'handoff': {
        const path = args.path as string | undefined
        const info = callerSessionId ? registry.get(callerSessionId) : undefined
        if (!info) throw new Error('handoff: calling session not found')
        let size = 0
        try { size = path ? statSync(path).size : 0 } catch {}
        if (!path || size === 0) throw new Error(`handoff file missing or empty: ${path ?? '(no path)'} — write it first`)
        // Answer before acting: the kill inside handOff ends this very session.
        setTimeout(() => {
          handOff(info, path).then(
            r => gateway.send(info.threadId, `🤝 \`${info.tmuxName}\` handed off to \`${r.name}\` — fresh context from \`${path}\``),
            err => gateway.send(info.threadId, `⚠️ handoff from \`${info.tmuxName}\` failed: ${err instanceof Error ? err.message : err}\nRecover: type \`respawn\`, then tell it to read \`${path}\` and continue from its Next action.`),
          ).catch(() => {})
        }, 500)
        return { content: [{ type: 'text', text: `handing off — a fresh session will continue from ${path}` }] }
      }

      case 'set_description': {
        const sessionId = args.session_id as string | undefined
        const description = args.description as string | undefined
        if (!sessionId || !description) throw new Error('session_id and description are required')
        const info = registry.get(sessionId)
        if (!info) throw new Error('session not found')
        info.description = description.slice(0, 120)
        registry.persist()
        refreshSessionVisual(info.threadId)
        refreshDashboard()
        return { content: [{ type: 'text', text: `description set for ${info.tmuxName}` }] }
      }

      case 'kill_session': {
        const sessionId = args.session_id as string | undefined
        const threadId = args.thread_id as string | undefined

        let targetId: string | undefined
        if (sessionId) {
          targetId = sessionId
        } else if (threadId) {
          targetId = registry.getByThread(threadId)
        }

        if (!targetId || !registry.has(targetId)) {
          throw new Error('session not found')
        }

        const info = registry.get(targetId)!

        // Non-main sessions can only kill sessions they spawned
        let reason = 'session ended'
        if (callerSessionId && callerSessionId !== 'main') {
          const caller = registry.get(callerSessionId)
          // Distinct from a human's 'session ended' so the on-kill hook can tell them apart
          reason = `session ended by ${caller?.tmuxName ?? 'agent'}`
          if (!caller || !isParentOf(caller, info)) {
            throw new Error(`cannot kill ${info.tmuxName} — you can only kill sessions you spawned`)
          }
          // A protocol-managed participant (e.g. the review Critic) belongs to the
          // protocol, not to whoever happened to spawn it.
          if (isProtocolParticipant(targetId)) {
            throw new Error(`cannot kill ${info.tmuxName} — it is a protocol participant`)
          }
        }

        await killSession(info, reason)
        return { content: [{ type: 'text', text: `killed session ${targetId}` }] }
      }

      case 'factory_build': {
        const difficulty = str(args.difficulty)
        if (difficulty && !(VALID_DIFFICULTIES as readonly string[]).includes(difficulty)) {
          throw new Error(`invalid difficulty "${difficulty}" — must be one of: ${VALID_DIFFICULTIES.join(', ')}`)
        }

        if (!callerSessionId) throw new Error('factory_build requires a session context')
        const callerInfo = registry.get(callerSessionId)
        if (!callerInfo) throw new Error('session not found')
        if (callerInfo.sessionType === 'factory_builder') throw new Error('factory builders cannot call factory_build (recursion guard)')

        const fresh = args.fresh === true

        const worktreeRaw = args.worktree
        let worktreeResolved: string | undefined
        if (worktreeRaw === true) {
          const spawnCwd = process.env.SPAWN_CWD
          const pmCwd = callerInfo?.sessionMetadata?.cwd
          if (!spawnCwd) throw new Error('worktree: true requires SPAWN_CWD to be set')
          if (!pmCwd) throw new Error('worktree: true could not read your CWD (bridge may not have connected yet). Pass an explicit path relative to SPAWN_CWD instead, e.g. worktree="Documents/hydra".')
          worktreeResolved = suggestWorktreeFromCwd(pmCwd, spawnCwd)
          if (!worktreeResolved) throw new Error(`worktree: true but your CWD (${pmCwd}) is not inside a git repo nested under SPAWN_CWD (${spawnCwd}) — the root repo itself cannot be isolated. Call factory_status to list valid repos, or pass an explicit path like worktree="Documents/hydra".`)
        } else {
          // worktreeRaw is a string path, false (explicit "no isolation"), or undefined
          worktreeResolved = str(worktreeRaw)
        }

        const result = factoryBuild({
          pmThreadId: callerInfo.threadId,
          pmSessionId: callerSessionId,
          spec: args.spec as string,
          builderModel: str(args.builder_model),
          reviewerModel: str(args.reviewer_model),
          reviewRounds: num(args.review_rounds),
          difficulty: difficulty as Difficulty | undefined,
          worktree: worktreeResolved,
          fresh,
        })

        if ('error' in result) {
          return { content: [{ type: 'text', text: `Factory build failed: ${result.error}` }], isError: true }
        }

        const warningNote = result.warning ? ` Note: ${result.warning}` : ''
        return {
          content: [{ type: 'text', text: `Build started. Ticket: ${result.ticket}.${warningNote}` }],
        }
      }

      case 'factory_retry': {
        if (!args.ticket || typeof args.ticket !== 'string') throw new Error('ticket is required')
        if (!args.instructions || typeof args.instructions !== 'string') throw new Error('instructions is required')
        const ticket = args.ticket
        const instructions = args.instructions
        if (!callerSessionId) throw new Error('factory_retry requires a session context')

        const result = factoryRetry(ticket, instructions, callerSessionId)
        if ('error' in result) {
          return { content: [{ type: 'text', text: `Factory retry failed: ${result.error}` }], isError: true }
        }
        return { content: [{ type: 'text', text: `Retry instructions sent to builder. Ticket: ${ticket}. Waiting for factory_done.` }] }
      }

      case 'factory_accept': {
        if (!args.ticket || typeof args.ticket !== 'string') throw new Error('ticket is required')
        const ticket = args.ticket
        const allowUnreviewed = args.allow_unreviewed === true
        if (!callerSessionId) throw new Error('factory_accept requires a session context')

        const result = factoryAccept(ticket, callerSessionId, allowUnreviewed)
        if ('error' in result) {
          return { content: [{ type: 'text', text: `Factory accept failed: ${result.error}` }], isError: true }
        }
        return { content: [{ type: 'text', text: `Build accepted. Ticket: ${ticket}. Builder killed.` }] }
      }

      case 'factory_abandon': {
        if (!args.ticket || typeof args.ticket !== 'string') throw new Error('ticket is required')
        const ticket = args.ticket
        if (!callerSessionId) throw new Error('factory_abandon requires a session context')
        const reason = str(args.reason)

        const result = factoryAbandon(ticket, callerSessionId, reason)
        if ('error' in result) {
          return { content: [{ type: 'text', text: `Factory abandon failed: ${result.error}` }], isError: true }
        }
        return { content: [{ type: 'text', text: `Build abandoned. Ticket: ${ticket}. Builder killed.` }] }
      }

      case 'factory_done': {
        if (!callerSessionId) throw new Error('factory_done requires a session context')
        const callerInfo = registry.get(callerSessionId)
        if (callerInfo?.sessionType !== 'factory_builder') throw new Error('factory_done can only be called by factory builders')
        if (!Array.isArray(args.files_changed)) throw new Error('files_changed must be an array of strings')
        if (typeof args.test_results !== 'string') throw new Error('test_results must be a string')
        const doneArgs: FactoryDoneArgs = {
          files_changed: (args.files_changed as unknown[]).filter((f): f is string => typeof f === 'string'),
          test_results: args.test_results as string,
          rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
          known_issues: typeof args.known_issues === 'string' ? args.known_issues : undefined,
          branch: typeof args.branch === 'string' ? args.branch : undefined,
        }
        const result = onBuilderDone(callerSessionId, doneArgs)
        if ('error' in result) {
          return { content: [{ type: 'text', text: result.error }], isError: true }
        }
        return { content: [{ type: 'text', text: 'Build complete. Adversarial review will start shortly — you will defend your implementation as the review owner.' }] }
      }

      case 'factory_status': {
        const ticket = str(args.ticket)
        if (!callerSessionId) throw new Error('factory_status requires a session context')
        const callerInfo = registry.get(callerSessionId)
        if (!callerInfo) throw new Error('session not found')

        const result = factoryStatus(callerInfo.threadId, ticket)
        const reposLine = result.availableRepos.length
          ? `\n\nValid worktree targets: ${result.availableRepos.join(', ')}`
          : ''
        if (result.builds.length === 0) {
          return { content: [{ type: 'text', text: `No active factory builds.${reposLine}` }] }
        }
        return { content: [{ type: 'text', text: `${JSON.stringify(result.builds, null, 2)}${reposLine}` }] }
      }

      case 'factory_review': {
        const name = str(args.name)
        if (!name) throw new Error('name is required')
        const topic = str(args.topic)
        const reviewerModel = str(args.reviewer_model)
        const reviewRounds = normalizeReviewRounds(num(args.review_rounds))
        if (!callerSessionId) throw new Error('factory_review requires a session context')
        const callerInfo = registry.get(callerSessionId)
        if (!callerInfo) throw new Error('session not found')

        const target = registry.findByName(name)
        if (!target) throw new Error(`session "${name}" not found`)
        if (!target.threadId) throw new Error(`session "${name}" has no thread`)
        if (target.sessionId === callerSessionId) throw new Error('cannot review yourself')

        await factoryReview({
          callerThreadId: callerInfo.threadId,
          targetSessionId: target.sessionId,
          targetThreadId: target.threadId,
          targetName: name,
          topic,
          reviewerModel,
          reviewRounds,
        })

        return { content: [{ type: 'text', text: `Review started on ${name} (up to ${reviewRounds} rounds). Results will be delivered to your thread.` }] }
      }

      case 'watch_pr': {
        let prUrl = args.pr_url as string | undefined
        const sessionId = callerSessionId ?? 'main'
        const info = registry.get(sessionId)
        if (!prUrl) {
          const cwd = info?.sessionMetadata?.cwd
          if (!cwd) throw new Error(WATCH_ERRORS.NO_CWD)
          const detected = await detectPrUrl(cwd)
          if (!detected.ok) throw new Error(detected.reason)
          prUrl = detected.url
        }
        const threadId = (args.chat_id as string | undefined) ?? info?.threadId ?? ''
        if (!threadId) throw new Error('could not determine thread — pass chat_id')
        const result = await watchPr(prUrl, sessionId, threadId)
        return { content: [{ type: 'text', text: result }] }
      }

      case 'unwatch_pr': {
        const result = unwatchPr(args.pr_url as string, callerSessionId)
        return { content: [{ type: 'text', text: result }] }
      }

      case 'list_watches': {
        const all = args.all as boolean | undefined
        const entries = all ? listWatches() : getWatchesBySession(callerSessionId ?? 'main')
        if (entries.length === 0) return { content: [{ type: 'text', text: 'no PRs being watched' }] }
        const lines = entries.map(e => `• ${formatWatchEntry(e)}`)
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'send_to_thread': {
        const target = (args.target as string)?.trim()
        const msgType = (args.type as string)?.trim()
        const text = args.text as string
        const files = (args.files as string[] | undefined) ?? []
        if (!target) throw new Error('target is required (session name, e.g. "cedar")')
        const VALID_TYPES = ['progress', 'question', 'result']
        if (!msgType || !VALID_TYPES.includes(msgType)) throw new Error(`type is required: ${VALID_TYPES.join(', ')}`)
        if (!text) throw new Error('text is required')
        const visibility = (args.visibility as string | undefined)?.trim() || 'public'
        if (visibility !== 'public' && visibility !== 'private') throw new Error('visibility must be "public" or "private"')
        const isPrivate = visibility === 'private'
        if (!isPrivate && callerSessionId && protocolChildRequiresPrivate(callerSessionId)) {
          throw new Error('this session is a private protocol helper — use send_to_thread with visibility="private"')
        }
        process.stderr.write(`daemon: send_to_thread [${msgType}] → ${target}\n`)

        // Resolve by session name only — no raw thread IDs (use reply for those)
        const resolved = resolveSendTarget(target)
        if (!resolved) {
          const known = [...registry.values()].filter(s => !s.deadAt).map(s => s.tmuxName).join(', ')
          throw new Error(`no session named "${target}". Known sessions: ${known || '(none)'}`)
        }
        const targetSession = resolved.session
        const threadId = targetSession.threadId

        // Private delivery: child → its own parent only, straight to the parent's
        // session. Never touches the gateway, so nothing lands in any thread.
        if (isPrivate) {
          const sender = callerSessionId ? registry.get(callerSessionId) : undefined
          if (!sender) throw new Error('private delivery requires a session context')
          if (resolved.replaced) throw new Error(`no live session named "${target}" for private delivery`)
          if (msgType === 'question') throw new Error('private delivery supports progress and result only')
          if (files.length > 0) throw new Error('private delivery cannot attach files')
          if (!isParentOf(targetSession, sender)) {
            throw new Error(`private delivery denied — "${target}" is not your parent session`)
          }
          // Private reports enter the parent's model context directly. Bound a
          // noisy or hostile helper so one result cannot consume it wholesale.
          const maxPrivateTextChars = 64 * 1024
          const privateText = text.length > maxPrivateTextChars
            ? `${text.slice(0, maxPrivateTextChars)}\n[private result truncated at ${maxPrivateTextChars} characters]`
            : text
          if (msgType === 'result') registerProtocolChildResult(callerSessionId!, targetSession.sessionId, privateText)
          transport.sendOrQueue(targetSession.sessionId, {
            type: 'notification',
            content: `[private ${msgType} from ${sender.tmuxName}] ${privateText}`,
            meta: { chat_id: threadId, message_id: '', user: sender.tmuxName, user_id: 'session', ts: new Date().toISOString() },
          })
          return { content: [{ type: 'text', text: `privately delivered to ${target}` }] }
        }
        const redirectNote = resolved.replaced
          ? ` (delivered to ${targetSession.tmuxName}, which replaced ${resolved.replaced} in that thread)`
          : ''
        if (resolved.replaced) {
          process.stderr.write(`daemon: send_to_thread: ${resolved.replaced} is gone — redirected to ${targetSession.tmuxName}\n`)
        }

        for (const f of files) {
          assertSendable(f)
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
          }
        }
        if (files.length > 10) throw new Error('max 10 attachments per message')

        const access = loadAccess()
        const sendLimit = Math.max(1, Math.min(access.textChunkLimit ?? maxChunkLimit(), maxChunkLimit()))
        const chunks = chunk(text, sendLimit, access.chunkMode ?? 'markdown')
        const sentIds: string[] = []

        try {
          for (let i = 0; i < chunks.length; i++) {
            const sent = await retrySend(() => gateway.send(threadId, chunks[i], {
              ...(i === 0 && files.length > 0 ? { files } : {}),
            }))
            sentIds.push(sent.id)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`send failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
        }

        // A reviewer result counts as complete only once it was actually posted
        // to the parent thread; failed sends must not unlock step_passed.
        if (msgType === 'result' && callerSessionId) {
          registerProtocolChildResult(callerSessionId, targetSession.sessionId, text)
        }

        // Deliver to the target's Claude session so it actually receives the message
        const senderName = callerSessionId ? registry.get(callerSessionId)?.tmuxName ?? callerSessionId : 'unknown'
        const replyInstruction = msgType === 'question'
          ? `\nRespond via send_to_thread(target="${senderName}", type="result", text="...").`
          : ''
        transport.sendOrQueue(targetSession.sessionId, {
          type: 'notification',
          content: `[${msgType} from ${senderName}] ${text}${replyInstruction}`,
          meta: {
            chat_id: threadId,
            message_id: sentIds[0] ?? '',
            user: senderName,
            user_id: 'session',
            ts: new Date().toISOString(),
          },
        })

        const result = sentIds.length === 1
          ? `sent to ${target} (id: ${sentIds[0]})${redirectNote}`
          : `sent ${sentIds.length} parts to ${target} (ids: ${sentIds.join(', ')})${redirectNote}`
        return { content: [{ type: 'text', text: result }], sentIds }
      }

      case 'peek_session': {
        const name = (args.name as string)?.trim()
        if (!name) throw new Error('name is required')
        const lines = Math.min(Math.max((args.lines as number) ?? 50, 1), 500)

        const found = [...registry.values()].find(s => s.tmuxName === name)
        if (!found) throw new Error(`no session named "${name}"`)

        if (callerSessionId && callerSessionId !== 'main') {
          const caller = registry.get(callerSessionId)
          if (caller && !isParentOf(caller, found)) {
            throw new Error(`peek denied — "${name}" is not a child of your session`)
          }
        }

        if (!tmuxHasSession(name)) throw new Error(`session "${name}" tmux not running`)

        const adapter = found.adapter
        const output = adapter.peek(found, lines)

        const ctx = formatContextPercent(adapter, found)
        const msgs = found.messageCount ?? 0
        const duration = formatDuration(Date.now() - found.createdAt)
        const header = `Session: ${name} | ${ctx} | ${msgs} msgs | ${duration}`

        return { content: [{ type: 'text', text: `${header}\n${'─'.repeat(60)}\n${output || '(empty)'}` }] }
      }

      case 'advance': {
        const content = (args.content as string)?.trim()
        if (!content) throw new Error('advance requires content')
        if (!callerSessionId) throw new Error('advance requires a session context')
        const verdict = (args.verdict as string)?.trim() || undefined

        const result = await dispatchAdvance(callerSessionId, content, verdict)
        if (!result.ok) throw new Error(result.reason)

        const verdictNote = verdict ? ` (verdict: ${verdict})` : ''
        return { content: [{ type: 'text', text: `advanced${verdictNote}` }], sentIds: result.sentIds }
      }

      case 'extend_phase': {
        const reason = (args.reason as string)?.trim()
        if (!reason) throw new Error('extend_phase requires a reason')
        if (!callerSessionId) throw new Error('extend_phase requires a session context')
        const minutes = Math.max(1, Math.min(Number(args.minutes) || 5, 15))

        const { onRunExtend } = await import('./protocol-runner.js')
        const result = onRunExtend(callerSessionId, reason, minutes)
        if (!result.ok) throw new Error(result.reason)

        return { content: [{ type: 'text', text: `phase extended by ${minutes}m: ${reason}` }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `unknown tool: ${name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${name} failed: ${msg}` }],
      isError: true,
    }
  }
}
