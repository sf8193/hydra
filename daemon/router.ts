import { gateway, PERMISSION_REPLY_RE, INBOX_DIR } from './config.js'
import { registry, threadRegistry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { loadAccess, gate } from './access.js'
import type { Access } from './access.js'
import type { DownloadedFile } from '../gateway.js'
import type { InboundMessage } from '../gateway.js'

import { handleSpawnIntercept, handleKillIntercept, handleRestartIntercept, handleReconnectIntercept, handleCommandsIntercept, handleRecoverIntercept } from './commands/global.js'
import { handleThreadKillIntercept, handleForkIntercept, handleForksIntercept, handleResumeIntercept, handleRespawnIntercept } from './commands/thread.js'
import { handleReviewIntercept, handleCancelReviewIntercept } from './commands/review.js'
import { handleBuildIntercept, handleCancelBuildIntercept } from './commands/build.js'
import { handleDesignIntercept, handleDesignSpawnIntercept, handleCancelDesignIntercept } from './commands/design.js'
import { getDesignByThread, handleDesignAnswer } from './design.js'
import { getReviewByThread } from './adversarial.js'
import { getBuildByThread } from './build.js'
import { refreshSessionVisual } from './anchor-state.js'
import { handleListIntercept, handleUsageIntercept, handleHealthIntercept, handleProtocolsIntercept } from './commands/status.js'
import { handleWatchIntercept, handleUnwatchIntercept, handleWatchesIntercept } from './commands/watch.js'
import { killSession } from './session-lifecycle.js'
import { isAlive, reportError } from './util.js'

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
  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

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
    ...threadContext,
  }

  return { content, meta }
}

// ---------------------------------------------------------------------------
// Deliver a message to a session
// ---------------------------------------------------------------------------

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

gateway.onMessage(async (msg: InboundMessage) => {
  if (msg.isBot) return

  const access = loadAccess()
  const senderId = msg.authorId
  const isAllowed = access.allowFrom.includes(senderId)

  if (isAllowed) {
    const spawnMatch = msg.content.match(/^(?:new session:|spawn:|\/spawn)\s*([\s\S]+)/i)
    if (spawnMatch) {
      const topic = spawnMatch[1].trim()
      if (topic) {
        void handleSpawnIntercept(msg, topic, access)
        return
      }
    }

    // spawn-wt: repo_name topic — shorthand for worktree spawns
    const spawnWtMatch = msg.content.match(/^(?:spawn-wt:|\/spawn-wt)\s*(\S+)\s+([\s\S]+)/i)
    if (spawnWtMatch) {
      const repo = spawnWtMatch[1].trim()
      const topic = spawnWtMatch[2].trim()
      if (repo && topic) {
        void handleSpawnIntercept(msg, `worktree:${repo} ${topic}`, access)
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

    // Top-level design: auto-spawn a session, then start the design in its thread
    const topLevelDesignMatch = msg.content.match(/^(?:\/design|design):\s*([\s\S]+)$/i)
    if (topLevelDesignMatch && !msg.isThread) {
      void handleDesignSpawnIntercept(msg, topLevelDesignMatch[1].trim())
      return
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

      const reviewMatch = msg.content.match(/^(?:\/review|review)\s*(\d+)?(?:\s+([\s\S]+))?$/i)
      if (reviewMatch) {
        void handleReviewIntercept(msg, parseInt(reviewMatch[1] ?? '3'), reviewMatch[2]?.trim())
        return
      }

      const cancelReviewMatch = msg.content.match(/^(?:kill review)\s*$/i)
      if (cancelReviewMatch) {
        void handleCancelReviewIntercept(msg)
        return
      }

      const buildWtMatch = msg.content.match(/^(?:\/build-wt|build-wt):\s*(\S+)\s+(\d+)?(?:\s+([\s\S]+))?$/i)
      if (buildWtMatch) {
        void handleBuildIntercept(msg, parseInt(buildWtMatch[2] ?? '3'), buildWtMatch[3]?.trim(), buildWtMatch[1].trim())
        return
      }
      // Catch malformed build-wt (missing repo)
      if (msg.content.match(/^(?:\/build-wt|build-wt)[:\s]/i)) {
        void gateway.send(msg.channelId, `Usage: \`build-wt: <repo> [rounds] [task]\`\nExample: \`build-wt: options_bot 3 implement ticket 1\``, { replyTo: msg.id }).catch(() => {})
        return
      }

      const buildMatch = msg.content.match(/^(?:\/build|build)\s*(\d+)?(?:\s+([\s\S]+))?$/i)
      if (buildMatch) {
        void handleBuildIntercept(msg, parseInt(buildMatch[1] ?? '3'), buildMatch[2]?.trim())
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

          const pauseMatch = msg.content.match(/^(pause|unpause)\s*$/i)
          if (pauseMatch) {
            if (pauseMatch[1].toLowerCase() === 'pause') {
              const activeProtocol = getReviewByThread(resolvedThreadId) || getBuildByThread(resolvedThreadId) || getDesignByThread(resolvedThreadId)
              if (activeProtocol) {
                void reportError(msg.channelId, msg.id, 'pause', 'a protocol is active in this thread', 'Cancel the active review/build/design first.')
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
    const mainBridge = transport.get('main')
    if (mainBridge) {
      transport.sendToBridge(mainBridge, {
        type: 'permission_response',
        request_id: permMatch[2]!.toLowerCase(),
        behavior: permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
      })
    }
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
})
