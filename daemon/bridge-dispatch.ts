import { statSync } from 'fs'
import { execSync } from 'child_process'
import { gateway, INBOX_DIR } from './config.js'
import { registry, sessionEmoji } from './sessions.js'
import { transport } from './bridge-transport.js'
import { loadAccess, maxChunkLimit, MAX_ATTACHMENT_BYTES } from './access.js'
import { doSpawnSession, killSession } from './session-lifecycle.js'
import { fallbackDescription, formatDuration, getContextPercent, chunk, assertSendable, isAlive, tmuxHasSession, parseDuration } from './util.js'
import { dispatchAdvance } from './protocol-registry.js'
import { watchPr, unwatchPr, listWatches, getWatchesBySession, formatWatchEntry, detectPrUrl, WATCH_ERRORS } from './pr-watch.js'
import { refreshSessionVisual } from './anchor-state.js'
import { refreshDashboard } from './dashboard.js'
import { extractArtifactLinks, mergeArtifacts, sanitizeArtifacts, cachePrTitle } from './artifacts.js'
import { fetchPrTitle, parsePrUrl } from './pr-watch.js'
import { factoryBuild, factoryRetry, factoryAccept, factoryAbandon, factoryStatus, factoryReview, onBuilderDone, VALID_DIFFICULTIES, type Difficulty, type FactoryDoneArgs } from './factory.js'

const SEND_RETRY_ATTEMPTS = 3
const SEND_RETRY_BASE_MS = 1_000
const RETRYABLE_PATTERNS = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EPIPE|socket hang up|not connected|network/i

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
            throw new Error(`channel ${chat_id} is not allowlisted`)
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
          return { content: [{ type: 'text', text: 'message has no attachments' }] }
        }
        const lines = results.map(r => `  ${r.path}  (${r.name}, ${r.contentType}, ${r.sizeKB}KB)`)
        return {
          content: [{ type: 'text', text: `downloaded ${results.length} attachment(s):\n${lines.join('\n')}` }],
        }
      }

      case 'spawn_session': {
        const worktree = args.worktree as string | undefined
        const topic = worktree ? `worktree:${worktree} ${args.topic}` : args.topic as string
        const model = (args.model as string | undefined)?.trim() || undefined
        if (model) process.stderr.write(`daemon: spawn_session model override: ${model}\n`)
        const budgetRaw = (args.phase_budget as string | undefined)?.trim() || undefined
        const phaseBudgetMs = budgetRaw ? parseDuration(budgetRaw) ?? undefined : undefined
        if (budgetRaw && !phaseBudgetMs) throw new Error(`invalid phase_budget "${budgetRaw}" — use e.g. "90s", "20m", "1h"`)
        const headless = args.headless as boolean | undefined
        const spawnerName = callerSessionId ? registry.get(callerSessionId)?.tmuxName ?? 'main' : 'main'
        const result = await doSpawnSession(topic, args.chat_id as string | undefined, args.message_id as string | undefined, {
          ...(model ? { model } : {}),
          ...(phaseBudgetMs ? { phaseBudgetMs } : {}),
          ...(headless ? { headless: true } : {}),
          trigger: 'spawn_session',
          initiator: spawnerName,
        })
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
            context: getContextPercent(s.tmuxName),
            messages: s.messageCount ?? 0,
            running_for: formatDuration(Date.now() - s.createdAt),
            status: transport.has(s.sessionId) ? 'connected' : 'disconnected',
            origin_type: s.originType ?? 'spawn',
            origin_from: s.originFrom ?? null,
          }
        })
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
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
        if (callerSessionId && callerSessionId !== 'main') {
          const callerName = registry.get(callerSessionId)?.tmuxName
          if (info.initiator !== callerName && info.originFrom !== callerName) {
            throw new Error(`cannot kill ${info.tmuxName} — you can only kill sessions you spawned`)
          }
        }

        await killSession(info, 'session ended')
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
        if (callerInfo.isFactoryBuilder) throw new Error('factory builders cannot call factory_build (recursion guard)')

        const fresh = args.fresh === true

        const result = factoryBuild({
          pmThreadId: callerInfo.threadId,
          pmSessionId: callerSessionId,
          spec: args.spec as string,
          builderModel: str(args.builder_model),
          reviewerModel: str(args.reviewer_model),
          reviewRounds: num(args.review_rounds),
          difficulty: difficulty as Difficulty | undefined,
          worktree: str(args.worktree),
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

        const result = factoryAbandon(ticket, callerSessionId)
        if ('error' in result) {
          return { content: [{ type: 'text', text: `Factory abandon failed: ${result.error}` }], isError: true }
        }
        return { content: [{ type: 'text', text: `Build abandoned. Ticket: ${ticket}. Builder killed.` }] }
      }

      case 'factory_done': {
        if (!callerSessionId) throw new Error('factory_done requires a session context')
        const callerInfo = registry.get(callerSessionId)
        if (!callerInfo?.isFactoryBuilder) throw new Error('factory_done can only be called by factory builders')
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
        if (result.builds.length === 0) {
          return { content: [{ type: 'text', text: 'No active factory builds.' }] }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.builds, null, 2) }] }
      }

      case 'factory_review': {
        const name = str(args.name)
        if (!name) throw new Error('name is required')
        const topic = str(args.topic)
        const reviewerModel = str(args.reviewer_model)
        const reviewRounds = num(args.review_rounds) ?? 3
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

        return { content: [{ type: 'text', text: `Review started on ${name} (${reviewRounds} rounds). Results will be delivered to your thread.` }] }
      }

      case 'watch_pr': {
        let prUrl = args.pr_url as string | undefined
        const sessionId = callerSessionId ?? 'main'
        const info = registry.get(sessionId)
        if (!prUrl) {
          const cwd = info?.capabilities?.cwd
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
        process.stderr.write(`daemon: send_to_thread [${msgType}] → ${target}\n`)

        // Resolve by session name only — no raw thread IDs (use reply for those)
        const targetSession = [...registry.values()].find(s => s.tmuxName === target)
        if (!targetSession) {
          const known = [...registry.values()].map(s => s.tmuxName).join(', ')
          throw new Error(`no session named "${target}". Known sessions: ${known || '(none)'}`)
        }
        const threadId = targetSession.threadId

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
          ? `sent to ${target} (id: ${sentIds[0]})`
          : `sent ${sentIds.length} parts to ${target} (ids: ${sentIds.join(', ')})`
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
          if (caller && found.originFrom !== caller.tmuxName) {
            throw new Error(`peek denied — "${name}" is not a child of your session`)
          }
        }

        if (!tmuxHasSession(name)) throw new Error(`session "${name}" tmux not running`)

        const output = execSync(
          `tmux capture-pane -t '${name.replace(/'/g, "'\\''")}' -p -S -${lines}`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trimEnd()

        const ctx = getContextPercent(name)
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
