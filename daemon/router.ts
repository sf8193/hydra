import { gateway, PERMISSION_REPLY_RE, INBOX_DIR } from './config.js'
import { registry, threadRegistry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { loadAccess, gate } from './access.js'
import type { Access } from './access.js'
import type { DownloadedFile } from '../gateway.js'
import type { InboundMessage } from '../gateway.js'
import { transcribeDownloads, mergeTranscripts } from './transcription.js'

import { handleSpawnIntercept, handleTemplateSpawn, handleKillIntercept, handleRestartIntercept, handleReconnectIntercept, handleCommandsIntercept, handleRecoverIntercept } from './commands/global.js'
import { resolveModelAlias, extractModelPrefix, MODEL_ALIAS_PATTERN, MODEL_ALIASES } from '../shared/constants.js'
import { handleThreadKillIntercept, handleForkIntercept, handleForksIntercept, handleResumeIntercept, handleRespawnIntercept } from './commands/thread.js'
import { handleReviewIntercept, handleCancelReviewIntercept } from './commands/review.js'
import { listPostPasses } from './adversarial.js'
import { handleBuildIntercept, handleCancelBuildIntercept } from './commands/build.js'
import { handleDesignIntercept, handleCancelDesignIntercept } from './commands/design.js'
import { getDesignByThread, handleDesignAnswer } from './design.js'
import { isThreadOccupied } from './protocol-registry.js'
import { refreshSessionVisual } from './anchor-state.js'
import { handleListIntercept, handleUsageIntercept, handleHealthIntercept, handleProtocolsIntercept } from './commands/status.js'
import { handleWatchIntercept, handleUnwatchIntercept, handleWatchesIntercept } from './commands/watch.js'
import { killSession } from './session-lifecycle.js'
import { pendingPermissions } from './permission.js'
import { isAlive, reportError, safeSend } from './util.js'
import { listTemplates, getTemplate } from './templates.js'
import { splitChain, enqueue, clearQueue, registerRouter, onProtocolComplete as dispatchQueueNext } from './command-queue.js'
import { registerOnComplete } from './protocol-registry.js'

// Global command prefixes — gated on top-level allowFrom. Thread-scoped
// commands (fork, watch, build, respawn, resume) are excluded: those are
// gated on session ownership, not allowFrom, so non-allowlisted users
// can never trigger them.
const COMMAND_PREFIXES = [
  'new session:', 'spawn:', '/spawn', 'spawn-wt:', '/spawn-wt',
  ...Object.keys(MODEL_ALIASES).flatMap(a => [`spawn ${a}:`, `new session ${a}:`, `spawn-wt ${a}:`]),
  'kill session:', 'kill:', '/kill',
  '/sessions', 'list sessions',
  '/restart', 'restart daemon', 'restart',
  '/health', 'health', 'status',
  '/protocols', 'protocols',
  '/reconnect', 'reconnect',
  '/recover', 'recover',
  '/commands', 'commands', '/help', 'help',
  '/usage', 'usage',
]
const COMMAND_RE = new RegExp(
  `^(?:${COMMAND_PREFIXES.map(p => p.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')).join('|')})(?:\\s|$)`, 'i',
)
const SPAWN_MODEL_RE = new RegExp(`^(?:new session|spawn)\\s+(${MODEL_ALIAS_PATTERN}):\\s*([\\s\\S]+)`, 'i')
const SPAWN_CODEX_RE = /^(?:new session|spawn)\s+codex(?:\s+(\S+))?:\s*([\s\S]+)/i
const SPAWN_WT_MODEL_RE = new RegExp(`^(?:spawn-wt|/spawn-wt)\\s+(${MODEL_ALIAS_PATTERN}):\\s*(\\S+)\\s+([\\s\\S]+)`, 'i')
const BARE_ALIAS_RE = new RegExp(`^(${MODEL_ALIAS_PATTERN}):?$`, 'i')
const BARE_CODEX_RE = /^codex:?\s*$/i

// ---------------------------------------------------------------------------
// Notification payload builder (auto-downloads attachments)
// ---------------------------------------------------------------------------

async function buildNotificationPayload(
  msg: InboundMessage,
  chatId: string,
): Promise<{ content: string; meta: Record<string, string> }> {
  let downloadedFiles: DownloadedFile[] = []
  if (msg.attachments.length > 0) {
    try {
      downloadedFiles = await gateway.downloadAttachments(msg.channelId, msg.id, INBOX_DIR)
    } catch (err) {
      process.stderr.write(`daemon: auto-download failed for ${msg.id}: ${err}\n`)
    }
  }

  const atts: string[] = downloadedFiles.length > 0
    ? downloadedFiles.map(f => `${f.name} (${f.contentType}, ${f.sizeKB}KB) -> ${f.path}`)
    : msg.attachments.map(att => {
        const kb = (att.size / 1024).toFixed(0)
        return `${att.name} (${att.contentType ?? 'unknown'}, ${kb}KB)`
      })

  // Voice dictation: transcribe any audio attachments so Claude reads the
  // spoken prompt as text. The original audio file stays in downloaded_files,
  // so Claude can still inspect it if needed. No-op unless transcription is
  // enabled and an audio file is present.
  const transcripts = downloadedFiles.length > 0
    ? await transcribeDownloads(downloadedFiles)
    : []

  let content = msg.content || (atts.length > 0 ? '(attachment)' : '')
  if (transcripts.length > 0) {
    content = mergeTranscripts(content, transcripts)
  }

  let threadContext: Record<string, string> = {}
  if (msg.isThread) {
    const starter = await gateway.getThreadStarterInfo(msg.channelId)
    if (starter) {
      threadContext = {
        thread_name: starter.threadName,
        thread_starter_user: starter.starterUser,
        thread_starter_content: starter.starterContent,
        thread_starter_id: starter.starterId,
      }
    }
  }

  const meta: Record<string, string> = {
    chat_id: chatId,
    message_id: msg.id,
    user: msg.authorUsername,
    user_id: msg.authorId,
    ts: msg.createdAt.toISOString(),
    ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    ...(downloadedFiles.length > 0 ? { downloaded_files: downloadedFiles.map(f => f.path).join('; ') } : {}),
    ...(transcripts.length > 0 ? { voice_transcript_count: String(transcripts.length) } : {}),
    ...threadContext,
  }

  return { content, meta }
}

// ---------------------------------------------------------------------------
// Deliver a message to a session
// ---------------------------------------------------------------------------

const CONTEXT_LINK_DOMAINS = /slack\.com\/archives|linear\.app|notion\.so|incident\.io|app\.datadoghq\.com|sentry\.io|pagerduty\.com/
const MAX_CONTEXT_LINKS = 5

function extractContextLinks(text: string): string[] {
  const links: string[] = []

  // Match URLs from Slack mrkdwn: <https://...|label> or bare https://...
  const urlRe = /https?:\/\/[^\s|>)]+/g
  let m: RegExpExecArray | null
  while ((m = urlRe.exec(text)) !== null) {
    const url = m[0].replace(/[.,;:!?)]+$/, '')
    if (CONTEXT_LINK_DOMAINS.test(url)) links.push(url)
  }

  // Match Slack channel mentions: <#C0ABC123> or <#C0ABC123|channel-name>
  const channelRe = /<#([A-Z0-9]+)(?:\|([^>]+))?>/g
  while ((m = channelRe.exec(text)) !== null) {
    const channelId = m[1]
    const label = m[2] || channelId
    links.push(`slack:channel:${channelId}:${label}`)
  }

  return links
}

async function deliverToSession(msg: InboundMessage, targetSessionId: string, access: Access): Promise<void> {
  void gateway.typing(msg.channelId).catch(() => {})
  if (access.ackReaction) {
    void gateway.react(msg.channelId, msg.id, access.ackReaction).catch(() => {})
  }

  const sessionInfo = registry.get(targetSessionId)
  if (sessionInfo) {
    sessionInfo.messageCount = (sessionInfo.messageCount ?? 0) + 1
    const thread = threadRegistry.get(sessionInfo.threadId)
    if (thread) thread.totalMessages++

    const links = extractContextLinks(msg.content)
    if (links.length > 0) {
      const existing = new Set(sessionInfo.contextLinks ?? [])
      for (const url of links) existing.add(url)
      sessionInfo.contextLinks = [...existing].slice(-MAX_CONTEXT_LINKS)
      registry.debouncedPersist()
    }
  }
  const chatId = sessionInfo?.threadId ?? msg.channelId

  const { content, meta } = await buildNotificationPayload(msg, chatId)
  transport.sendOrQueue(targetSessionId, { type: 'notification', content, meta })
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

gateway.onThreadDelete(threadId => {
  const sessionId = registry.getByThread(threadId)
  if (!sessionId) return
  const info = registry.get(sessionId)
  if (!info) return
  process.stderr.write(`daemon: thread ${threadId} deleted, killing session ${info.tmuxName}\n`)
  void killSession(info, 'thread deleted')
})

gateway.onMessageDelete((messageId, threadId) => {
  if (!threadId) return
  const sessionId = registry.getByThread(threadId)
  if (!sessionId) return
  const info = registry.get(sessionId)
  if (!info) return
  if (info.anchorMessageId && messageId === info.anchorMessageId) {
    process.stderr.write(`daemon: anchor message deleted, killing session ${info.tmuxName}\n`)
    void killSession(info, 'anchor message deleted')
  } else {
    if (info.lastReplyId === messageId) {
      info.lastReplyId = undefined
      registry.persist()
    }
  }
})

// ---------------------------------------------------------------------------
// Reaction-based message deletion (:hocho: on bot messages)
// ---------------------------------------------------------------------------

if (gateway.onReaction) {
  gateway.onReaction(async (event) => {
    if (event.emoji !== 'hocho' && event.emoji !== '🔪') return
    const access = loadAccess()
    if (!access.allowFrom.includes(event.userId)) return
    try {
      await gateway.delete(event.channelId, event.messageId)
      process.stderr.write(`daemon: deleted message ${event.messageId} via reaction from ${event.userId}\n`)
    } catch (err) {
      process.stderr.write(`daemon: failed to delete message ${event.messageId}: ${err}\n`)
    }
  })
}

// ---------------------------------------------------------------------------
// Inbound message routing
// ---------------------------------------------------------------------------

// Extracted so the command queue can re-invoke routing for chained commands.
async function routeMessage(msg: InboundMessage): Promise<void> {
  const access = loadAccess()
  const senderId = msg.authorId
  const isAllowed = access.allowFrom.includes(senderId)

  if (!isAllowed && COMMAND_RE.test(msg.content)) {
    process.stderr.write(`daemon: command-shaped message from non-allowlisted sender ${senderId} ignored — add them to access.json allowFrom to enable commands\n`)
  }

  if (isAllowed) {
    // "spawn codex: topic" / "spawn codex gpt-5.5: topic" — codex engine with optional model
    const spawnCodexMatch = msg.content.match(SPAWN_CODEX_RE)
    if (spawnCodexMatch) {
      const topic = spawnCodexMatch[2].trim()
      if (topic) {
        void handleSpawnIntercept(msg, topic, access, spawnCodexMatch[1] || undefined, 'codex')
        return
      }
    }

    // "spawn sonnet: topic" / "new session haiku: topic" — model alias before colon
    const spawnModelMatch = msg.content.match(SPAWN_MODEL_RE)
    if (spawnModelMatch) {
      const topic = spawnModelMatch[2].trim()
      if (topic) {
        void handleSpawnIntercept(msg, topic, access, spawnModelMatch[1])
        return
      }
    }

    const spawnMatch = msg.content.match(/^(?:new session:|spawn:|\/spawn)\s*([\s\S]+)/i)
    if (spawnMatch) {
      const topic = spawnMatch[1].trim()
      // Catch "spawn sonnet:" (alias without topic) — don't spawn with "sonnet:" as topic
      const bareAlias = topic.match(BARE_ALIAS_RE) || topic.match(BARE_CODEX_RE)
      if (bareAlias) {
        const alias = bareAlias[1] || 'codex'
        void gateway.send(msg.channelId, `_\`spawn ${alias}:\` needs a topic — e.g. \`spawn ${alias}: describe the task\`_`, { replyTo: msg.id })
        return
      }
      if (topic) {
        void handleSpawnIntercept(msg, topic, access)
        return
      }
    }

    // spawn-wt sonnet: repo_name topic — worktree spawn with model alias
    const spawnWtModelMatch = msg.content.match(SPAWN_WT_MODEL_RE)
    if (spawnWtModelMatch) {
      const [, alias, repo, topic] = spawnWtModelMatch
      if (repo && topic.trim()) {
        void handleSpawnIntercept(msg, `wt:${repo.trim()} ${topic.trim()}`, access, alias)
        return
      }
    }

    // spawn-wt: repo_name topic — shorthand for worktree spawns
    const spawnWtMatch = msg.content.match(/^(?:spawn-wt:|\/spawn-wt)\s*(\S+)\s+([\s\S]+)/i)
    if (spawnWtMatch) {
      const repo = spawnWtMatch[1].trim()
      const topic = spawnWtMatch[2].trim()
      if (repo && topic) {
        void handleSpawnIntercept(msg, `wt:${repo} ${topic}`, access)
        return
      }
    }

    const killMatch = msg.content.match(/^(?:kill session:|kill:|\/kill)\s*(.+)/i)
    if (killMatch) {
      void handleKillIntercept(msg, killMatch[1].trim())
      return
    }

    const listMatch = msg.content.match(/^(?:\/sessions|list sessions)\s*$/i)
    if (listMatch) {
      void handleListIntercept(msg)
      return
    }

    const templatesMatch = msg.content.match(/^(?:\/templates|templates)\s*$/i)
    if (templatesMatch) {
      const templates = listTemplates()
      if (templates.length === 0) {
        void gateway.send(msg.channelId, 'No templates configured.', { replyTo: msg.id })
      } else {
        const lines = templates.map(t => {
          const actionTag = t.action ? ` _(+ ${t.action} protocol)_` : ''
          const modelTag = t.model ? ` \`[${t.model}]\`` : ''
          return `**${t.name}**${actionTag}${modelTag} — ${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? '...' : ''}`
        })
        void gateway.send(msg.channelId, `**Spawn Templates**\n${lines.join('\n')}`, { replyTo: msg.id })
      }
      return
    }

    const restartMatch = msg.content.match(/^(?:\/restart|restart daemon|restart)\s*$/i)
    if (restartMatch) {
      void handleRestartIntercept(msg)
      return
    }

    const healthMatch = msg.content.match(/^(?:\/health|health|status)\s*$/i)
    if (healthMatch) {
      void handleHealthIntercept(msg)
      return
    }

    const protocolsMatch = msg.content.match(/^(?:\/protocols|protocols)\s*$/i)
    if (protocolsMatch) {
      void handleProtocolsIntercept(msg)
      return
    }

    const reconnectMatch = msg.content.match(/^(?:\/reconnect|reconnect)\s*$/i)
    if (reconnectMatch) {
      void handleReconnectIntercept(msg)
      return
    }

    const recoverMatch = msg.content.match(/^(?:recover|\/recover)(?:\s+(.+))?$/i)
    if (recoverMatch) {
      void handleRecoverIntercept(msg, recoverMatch[1]?.trim() || undefined)
      return
    }

    const commandsMatch = msg.content.match(/^(?:\/commands|commands|list commands|show commands|\/help|help)\s*$/i)
    if (commandsMatch) {
      void handleCommandsIntercept(msg)
      return
    }

    const threadKillMatch = msg.content.match(/^(?:kill|\/kill)\s*$/i)
    if (threadKillMatch && msg.isThread) {
      void handleThreadKillIntercept(msg)
      return
    }

    const respawnMatch = msg.content.match(/^(?:respawn|\/respawn)(?::\s*([\s\S]+))?$/i)
    if (respawnMatch) {
      void handleRespawnIntercept(msg, respawnMatch[1]?.trim() || undefined)
      return
    }

    const resumeMatch = msg.content.match(/^(?:resume|\/resume)\s*$/i)
    if (resumeMatch) {
      void handleResumeIntercept(msg)
      return
    }

    const usageMatch = msg.content.match(/^(?:\/usage|usage)\s*$/i)
    if (usageMatch) {
      void handleUsageIntercept(msg)
      return
    }

    // Template as first-class command: "review: topic", "design: topic", etc.
    // Placed AFTER all hardcoded commands so new commands naturally take priority.
    // Skip in active session threads — let thread-scoped commands (design, review, build) handle it.
    {
      const resolvedThread = registry.resolveThreadId(msg)
      const activeSession = registry.getByThread(resolvedThread)
      const activeInfo = activeSession ? registry.get(activeSession) : undefined
      const liveInThread = activeInfo ? isAlive(activeInfo) : false

      if (!liveInThread) {
        const colonIdx = msg.content.indexOf(':')
        if (colonIdx > 0) {
          const candidateName = msg.content.slice(0, colonIdx).trim().toLowerCase()
          const template = getTemplate(candidateName)
          if (template) {
            const candidateTopic = msg.content.slice(colonIdx + 1).trim()
            void handleTemplateSpawn(msg, candidateName, candidateTopic, template, access)
            return
          }
          // "review sonnet: topic" — template name + model alias before colon
          const spaceIdx = candidateName.indexOf(' ')
          if (spaceIdx > 0) {
            const tplName = candidateName.slice(0, spaceIdx)
            const modelAlias = candidateName.slice(spaceIdx + 1)
            const tpl = getTemplate(tplName)
            if (tpl && resolveModelAlias(modelAlias)) {
              const candidateTopic = msg.content.slice(colonIdx + 1).trim()
              void handleTemplateSpawn(msg, tplName, candidateTopic, tpl, access, modelAlias)
              return
            }
          }
        }
      }
    }

    if (msg.isThread) {
      const forkMatch = msg.content.match(/^(?:fork|\/fork)(?::\s*([\s\S]+))?$/i)
      if (forkMatch) {
        void handleForkIntercept(msg, forkMatch[1]?.trim())
        return
      }

      const forksMatch = msg.content.match(/^(?:forks|\/forks)\s*$/i)
      if (forksMatch) {
        void handleForksIntercept(msg)
        return
      }

      const reviewMatch = msg.content.match(/^(?:\/review|review)\s*(?:(\S+?):\s+)?(\d+)?\s*(?:(\S+?):\s+)?([\s\S]+)?$/i)
      if (reviewMatch) {
        const preAlias = reviewMatch[1]?.toLowerCase()
        const postAlias = reviewMatch[3]?.toLowerCase()
        const isCodex = preAlias === 'codex' || postAlias === 'codex'
        const preModel = (preAlias && preAlias !== 'codex') ? resolveModelAlias(preAlias) : undefined
        const postModel = (postAlias && postAlias !== 'codex') ? resolveModelAlias(postAlias) : undefined
        const modelId = preModel ?? postModel
        const rounds = parseInt(reviewMatch[2] ?? '3')
        let topic = reviewMatch[4]?.trim()
        // Detect wrong order: "review fable 3 topic" (alias without colon)
        if (!modelId && topic) {
          const badOrder = topic.match(/^(\S+)\s+(\d+)\b/)
          if (badOrder && resolveModelAlias(badOrder[1])) {
            void gateway.send(msg.channelId, `_Model syntax: \`/review ${badOrder[2]} ${badOrder[1]}: topic\` or \`/review ${badOrder[1]}: ${badOrder[2]} topic\`_`, { replyTo: msg.id }).catch(() => {})
            return
          }
        }
        // Parse +pass suffixes — only match known pass names to avoid collisions with
        // natural language (e.g. "+1 error handling" shouldn't extract "1" as a pass)
        const knownPasses = listPostPasses()
        const passRe = new RegExp(`\\+(${knownPasses.join('|')})\\b`, 'g')
        const postPasses = [...(topic ?? '').matchAll(passRe)].map(m => m[1])
        if (postPasses.length > 0) {
          topic = topic!.replace(passRe, '').replace(/\s{2,}/g, ' ').trim() || undefined
        }
        void handleReviewIntercept(msg, rounds, topic, modelId, postPasses.length > 0 ? postPasses : undefined, isCodex ? 'codex' : undefined)
        return
      }

      const cancelReviewMatch = msg.content.match(/^(?:kill review)\s*$/i)
      if (cancelReviewMatch) {
        void handleCancelReviewIntercept(msg)
        return
      }

      const buildWtMatch = msg.content.match(/^(?:\/build-wt|build-wt):\s*(\S+)\s+(\d+)?(?:\s+([\s\S]+))?$/i)
      if (buildWtMatch) {
        const rawWtTask = buildWtMatch[3]?.trim()
        const { model: wtModelId, rest: wtTask } = rawWtTask ? extractModelPrefix(rawWtTask) : { model: undefined, rest: rawWtTask }
        void handleBuildIntercept(msg, parseInt(buildWtMatch[2] ?? '3'), wtTask, buildWtMatch[1].trim(), wtModelId)
        return
      }
      // Catch malformed build-wt (missing repo)
      if (msg.content.match(/^(?:\/build-wt|build-wt)[:\s]/i)) {
        void gateway.send(msg.channelId, `Usage: \`build-wt: <repo> [rounds] [task]\`\nExample: \`build-wt: options_bot 3 implement ticket 1\``, { replyTo: msg.id }).catch(() => {})
        return
      }

      const buildMatch = msg.content.match(/^(?:\/build|build)\s*(?:(\S+?):\s+)?(\d+)?\s*(?:(\S+?):\s+)?([\s\S]+)?$/i)
      if (buildMatch) {
        const buildPreAlias = buildMatch[1]?.toLowerCase()
        const buildPostAlias = buildMatch[3]?.toLowerCase()
        const buildIsCodex = buildPreAlias === 'codex' || buildPostAlias === 'codex'
        const preModel = (buildPreAlias && buildPreAlias !== 'codex') ? resolveModelAlias(buildPreAlias) : undefined
        const postModel = (buildPostAlias && buildPostAlias !== 'codex') ? resolveModelAlias(buildPostAlias) : undefined
        const buildModelId = preModel ?? postModel
        const buildRounds = parseInt(buildMatch[2] ?? '3')
        const buildTask = buildMatch[4]?.trim()
        if (!buildModelId && buildTask) {
          const badOrder = buildTask.match(/^(\S+)\s+(\d+)\b/)
          if (badOrder && resolveModelAlias(badOrder[1])) {
            void gateway.send(msg.channelId, `_Model syntax: \`build ${badOrder[2]} ${badOrder[1]}: task\` or \`build ${badOrder[1]}: ${badOrder[2]} task\`_`, { replyTo: msg.id }).catch(() => {})
            return
          }
        }
        void handleBuildIntercept(msg, buildRounds, buildTask, undefined, buildModelId, buildIsCodex ? 'codex' : undefined)
        return
      }

      const cancelBuildMatch = msg.content.match(/^(?:kill build)\s*$/i)
      if (cancelBuildMatch) {
        void handleCancelBuildIntercept(msg)
        return
      }

      const designMatch = msg.content.match(/^(?:\/design|design):\s*([\s\S]+)$/i)
      if (designMatch) {
        void handleDesignIntercept(msg, designMatch[1].trim())
        return
      }

      const cancelDesignMatch = msg.content.match(/^(?:kill design)\s*$/i)
      if (cancelDesignMatch) {
        void handleCancelDesignIntercept(msg)
        return
      }

      const cancelQueueMatch = msg.content.match(/^kill queue\s*$/i)
      if (cancelQueueMatch) {
        const threadId = registry.resolveThreadId(msg)
        const dropped = clearQueue(threadId)
        if (dropped > 0) {
          void safeSend(msg.channelId, `_Queue cleared — ${dropped} command${dropped !== 1 ? 's' : ''} dropped_`)
        } else {
          void safeSend(msg.channelId, `_No queued commands._`)
        }
        return
      }

      const watchMatch = msg.content.match(/^(?:\/watch|watch)(?:\s+<?(?:(https:\/\/[^\s|>]+)(?:\|[^>]*)?)>?)?\s*$/i)
      if (watchMatch) {
        void handleWatchIntercept(msg, watchMatch[1]?.trim())
        return
      }

      const unwatchMatch = msg.content.match(/^(?:\/unwatch|unwatch)\s+<?(?:(https:\/\/[^\s|>]+)(?:\|[^>]*)?)>?\s*$/i)
      if (unwatchMatch) {
        void handleUnwatchIntercept(msg, unwatchMatch[1].trim())
        return
      }

      const watchesMatch = msg.content.match(/^(?:\/watches|watches)\s*$/i)
      if (watchesMatch) {
        void handleWatchesIntercept(msg)
        return
      }

      // Design answer: user message during 'answering' phase
      const designThreadId = registry.resolveThreadId(msg)
      const design = getDesignByThread(designThreadId)
      if (design && design.phase === 'answering') {
        void handleDesignAnswer(designThreadId, msg.content)
        void gateway.react(msg.channelId, msg.id, '👍').catch(() => {})
        return
      }
    }

    if (msg.isThread) {
      const resolvedThreadId = registry.resolveThreadId(msg)
      const mappedSession = registry.getByThread(resolvedThreadId)
      process.stderr.write(`daemon: thread routing: channelId=${msg.channelId} effectiveThreadId=${msg.effectiveThreadId} resolvedThreadId=${resolvedThreadId} mappedSession=${mappedSession ?? 'none'} threadToSession keys=[${[...registry.threadToSession.keys()].join(',')}]\n`)
      if (mappedSession) {
        const info = registry.get(mappedSession)
        if (info && isAlive(info)) {
          const listenMatch = msg.content.match(/^(listen|unlisten)\s*$/i)
          if (listenMatch) {
            info.listening = listenMatch[1].toLowerCase() === 'listen'
            registry.persist()
            const thread = threadRegistry.get(resolvedThreadId)
            if (thread) {
              thread.listenOverride = info.listening
              threadRegistry.persist()
            }
            void gateway.react(msg.channelId, msg.id, info.listening ? '👂' : '🔇').catch(() => {})
            return
          }

          const permReplyMatch = msg.content.match(/^(allow|deny)\s*$/i)
          if (permReplyMatch) {
            const behavior = permReplyMatch[1].toLowerCase() === 'allow' ? 'allow' : 'deny'
            // Find the most recent pending permission for this session
            let foundId: string | undefined
            for (const [reqId, perm] of pendingPermissions) {
              if (perm.sessionId === mappedSession) foundId = reqId
            }
            if (foundId) {
              const targetBridge = transport.get(mappedSession)
              if (targetBridge) {
                transport.sendToBridge(targetBridge, {
                  type: 'permission_response',
                  request_id: foundId,
                  behavior,
                })
              }
              pendingPermissions.delete(foundId)
              void gateway.react(msg.channelId, msg.id, behavior === 'allow' ? '✅' : '❌').catch(() => {})
            } else {
              void gateway.send(msg.channelId, '_No pending permission for this session._', { replyTo: msg.id }).catch(() => {})
            }
            return
          }

          const pauseMatch = msg.content.match(/^(pause|unpause)\s*$/i)
          if (pauseMatch) {
            if (pauseMatch[1].toLowerCase() === 'pause') {
              const occupied = isThreadOccupied(resolvedThreadId)
              if (occupied) {
                void reportError(msg.channelId, msg.id, 'pause', `a ${occupied} is active in this thread`, `Cancel the active ${occupied} first.`)
                return
              }
            }
            info.paused = pauseMatch[1].toLowerCase() === 'pause'
            registry.persist()
            void gateway.react(msg.channelId, msg.id, info.paused ? '⏸' : '▶️').catch(() => {})
            refreshSessionVisual(resolvedThreadId)
            return
          }

          if (msg.content.startsWith('!') && msg.content.length > 1) {
            const stripped = msg.content.slice(1).trim()
            if (stripped) {
              void gateway.react(msg.channelId, msg.id, '⚡').catch(() => {})
              try {
                Bun.spawn(['tmux', 'send-keys', '-t', info.tmuxName, 'Escape'], { stdio: ['pipe', 'pipe', 'pipe'] })
                process.stderr.write(`daemon: interrupt sent to ${info.tmuxName} via ! prefix\n`)
              } catch (err) {
                process.stderr.write(`daemon: interrupt failed for ${info.tmuxName}: ${err instanceof Error ? err.message : err}\n`)
              }
              msg.content = stripped
              await new Promise(r => setTimeout(r, 50))
              info.lastActive = Date.now()
              registry.debouncedPersist()
              void deliverToSession(msg, mappedSession, access)
              return
            }
          }

          const alwaysRoute = gateway.dmThreadsAreExclusive && msg.isDM
          const shouldRoute =
            alwaysRoute ||
            info.listening ||
            msg.content.toLowerCase().startsWith(info.tmuxName) ||
            (msg.referenceMessageId && gateway.wasSentByUs(msg.referenceMessageId))

          if (shouldRoute) {
            info.lastActive = Date.now()
            registry.debouncedPersist()
            void deliverToSession(msg, mappedSession, access)
            return
          }

          if (msg.referenceMessageId) {
            const mentioned = await gateway.isMentioned(msg)
            if (mentioned) {
              info.lastActive = Date.now()
              registry.debouncedPersist()
              void deliverToSession(msg, mappedSession, access)
              return
            }
          }

          return
        }
      }
    }
  }

  const result = await gate(msg)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try {
      await gateway.send(msg.channelId, `${lead} -- run in Claude Code:\n\n/discord:access pair ${result.code}`, { replyTo: msg.id })
    } catch (err) {
      process.stderr.write(`daemon: failed to send pairing code: ${err}\n`)
    }
    return
  }

  let chat_id = msg.channelId

  if (!msg.isDM && !msg.isThread) {
    const channelId = msg.channelId
    const policy = result.access.groups[channelId]
    if (policy?.threadReply) {
      const preview = msg.content.slice(0, 50).replace(/<@!?\d+>\s*/g, '').trim() || 'Thread'
      const archiveDuration = policy.threadArchiveMinutes ?? 1440

      const existingSessionId = msg.hasExistingThread && msg.existingThreadId
        && registry.getByThread(msg.existingThreadId)
      if (msg.hasExistingThread && msg.existingThreadId && !existingSessionId) {
        chat_id = msg.existingThreadId
      } else {
        const threadId = await gateway.startThreadOnMessage(msg, preview, archiveDuration)
        if (threadId) {
          chat_id = threadId
        }
      }
    }
  }

  const permMatch = PERMISSION_REPLY_RE.exec(msg.content)
  if (permMatch) {
    const requestId = permMatch[2]!.toLowerCase()
    const pending = pendingPermissions.get(requestId)
    const targetSessionId = pending?.sessionId ?? 'main'
    const targetBridge = transport.get(targetSessionId)
    if (targetBridge) {
      transport.sendToBridge(targetBridge, {
        type: 'permission_response',
        request_id: requestId,
        behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
      })
    }
    pendingPermissions.delete(requestId)
    const emoji = permMatch[1]!.toLowerCase().startsWith('y') ? '✅' : '❌'
    void gateway.react(msg.channelId, msg.id, emoji).catch(() => {})
    return
  }

  void gateway.typing(msg.channelId).catch(() => {})

  if (result.access.ackReaction) {
    void gateway.react(msg.channelId, msg.id, result.access.ackReaction).catch(() => {})
  }

  let targetSessionId = 'main'
  let effectiveChatId = chat_id

  if (msg.isThread) {
    const rtid = registry.resolveThreadId(msg)
    const mappedSession = registry.getByThread(rtid)
    if (mappedSession && registry.has(mappedSession)) {
      const info = registry.get(mappedSession)!
      if (isAlive(info)) {
        targetSessionId = mappedSession
        info.lastActive = Date.now()
        registry.debouncedPersist()
        effectiveChatId = info.threadId
      }
    }
  }
  const { content, meta } = await buildNotificationPayload(msg, effectiveChatId)
  transport.sendOrQueue(targetSessionId, { type: 'notification', content, meta })
}

// Wire up the command queue
registerRouter(async (msg) => { await routeMessage(msg) })
registerOnComplete(dispatchQueueNext)

// Commands that can participate in && chains — must be command-shaped, not plain conversation.
const CHAINABLE_RE = /^(?:(?:\/review|review|\/build|build|\/design|push)\b|design:)/i
// Commands that produce a protocol completion signal — non-terminal segments must be one of these.
const PROTOCOL_RE = /^(?:(?:\/review|review|\/build|build|\/design)\b|design:)/i

gateway.onMessage(async (msg: InboundMessage) => {
  if (msg.isBot) return

  // Split on && only when: in a thread, sender is allowlisted, and EVERY
  // segment is command-shaped. If any segment isn't a command, don't split —
  // the && is part of the payload (e.g. "build 3: make sure bun test && bun build pass").
  const access = loadAccess()
  if (msg.isThread && access.allowFrom.includes(msg.authorId)) {
    const segments = splitChain(msg.content)
    if (segments.length > 1) {
      const allCommands = segments.every(s => CHAINABLE_RE.test(s))
      if (allCommands) {
        // Non-terminal segments must produce a completion signal (review/build/design).
        // Commands like `push` can only be last since they don't trigger the next step.
        const nonTerminal = segments.slice(0, -1)
        const badMid = nonTerminal.find(s => !PROTOCOL_RE.test(s))
        if (badMid) {
          void gateway.send(msg.channelId, `_Can't chain — \`${badMid.slice(0, 40)}\` doesn't produce a completion signal (only review/build/design do). Move it to the end or remove it._`, { replyTo: msg.id }).catch(() => {})
          return
        } else {
          const snapshot = structuredClone(msg)
          const threadId = registry.resolveThreadId(msg)
          msg = { ...msg, content: segments[0] }
          const rest = segments.slice(1).map(rawText => ({ rawText, originalMsg: snapshot }))
          enqueue(threadId, rest)
          const preview = segments.map((s, i) => i === 0 ? `**${s}**` : `\`${s}\``).join(' → ')
          void gateway.send(msg.channelId, `_⛓ Chained ${segments.length} commands: ${preview}_`, { replyTo: msg.id }).catch(() => {})
        }
      } else if (CHAINABLE_RE.test(segments[0])) {
        const bad = segments.find(s => !CHAINABLE_RE.test(s))
        void gateway.send(msg.channelId, `_Not chained — \`${bad?.slice(0, 40)}\` isn't a recognized command. The \`&&\` was treated as literal text._`, { replyTo: msg.id }).catch(() => {})
      }
    }
  }

  await routeMessage(msg)
})
