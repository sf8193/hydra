import { gateway, PERMISSION_REPLY_RE, INBOX_DIR } from './config.js'
import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { loadAccess, gate } from './access.js'
import type { Access } from './access.js'
import type { DownloadedFile } from '../gateway.js'
import type { InboundMessage } from '../gateway.js'

import { handleSpawnIntercept, handleKillIntercept, handleRestartIntercept, handleReconnectIntercept, handleCommandsIntercept } from './commands/global.js'
import { handleThreadKillIntercept, handleForkIntercept, handleForksIntercept } from './commands/thread.js'
import { handleHandoffIntercept, handleGoIntercept } from './commands/handoff.js'
import { handleReviewIntercept, handleCancelReviewIntercept } from './commands/review.js'
import { handleListIntercept, handleUsageIntercept, handleHealthIntercept } from './commands/status.js'
import { killSession } from './session-lifecycle.js'

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
    process.stderr.write(`daemon: message ${messageId} deleted in thread for session ${info.tmuxName} (not anchor, ignoring)\n`)
  }
})

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

    const reconnectMatch = msg.content.match(/^(?:\/reconnect|reconnect)\s*$/i)
    if (reconnectMatch) {
      void handleReconnectIntercept(msg)
      return
    }

    const commandsMatch = msg.content.match(/^(?:\/commands|commands|list commands|show commands)\s*$/i)
    if (commandsMatch) {
      void handleCommandsIntercept(msg)
      return
    }

    const threadKillMatch = msg.content.match(/^(?:kill|\/kill)\s*$/i)
    if (threadKillMatch) {
      void handleThreadKillIntercept(msg)
      return
    }

    const usageMatch = msg.content.match(/^(?:\/usage|usage)\s*$/i)
    if (usageMatch) {
      void handleUsageIntercept(msg)
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

      const handoffMatch = msg.content.match(/^(?:handoff|\/handoff)(?::\s*([\s\S]+))?$/i)
      if (handoffMatch) {
        void handleHandoffIntercept(msg, handoffMatch[1]?.trim())
        return
      }

      const goMatch = msg.content.match(/^(?:\/go|go!)\s*$/i)
      if (goMatch) {
        void handleGoIntercept(msg)
        return
      }

      const reviewMatch = msg.content.match(/^(?:\/review|review)\s*(\d+)?\s*$/i)
      if (reviewMatch) {
        void handleReviewIntercept(msg, parseInt(reviewMatch[1] ?? '3'))
        return
      }

      const cancelReviewMatch = msg.content.match(/^(?:\/cancel-review|cancel review)\s*$/i)
      if (cancelReviewMatch) {
        void handleCancelReviewIntercept(msg)
        return
      }
    }

    if (msg.isThread) {
      const mappedSession = registry.getByThread(msg.channelId)
        ?? (msg.existingThreadId ? registry.getByThread(msg.existingThreadId) : undefined)
      process.stderr.write(`daemon: thread routing: channelId=${msg.channelId} existingThreadId=${msg.existingThreadId} mappedSession=${mappedSession ?? 'none'} threadToSession keys=[${[...registry.threadToSession.keys()].join(',')}]\n`)
      if (mappedSession) {
        const info = registry.get(mappedSession)
        if (info) {
          const listenMatch = msg.content.match(/^(listen|pause)\s*$/i)
          if (listenMatch) {
            info.listening = listenMatch[1].toLowerCase() === 'listen'
            registry.persist()
            void gateway.react(msg.channelId, msg.id, info.listening ? '👂' : '⏸️').catch(() => {})
            return
          }

          const alwaysRoute = gateway.dmThreadsAreExclusive && msg.isDM
          const shouldRoute =
            alwaysRoute ||
            info.listening ||
            msg.content.toLowerCase().startsWith(info.tmuxName) ||
            (msg.referenceMessageId && gateway.wasSentByUs(msg.referenceMessageId))

          if (shouldRoute) {
            info.lastActive = Date.now()
            void deliverToSession(msg, mappedSession, access)
            return
          }

          if (msg.referenceMessageId) {
            const mentioned = await gateway.isMentioned(msg)
            if (mentioned) {
              info.lastActive = Date.now()
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

      if (msg.hasExistingThread && msg.existingThreadId) {
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
    const mappedSession = registry.getByThread(msg.channelId)
      ?? (msg.existingThreadId ? registry.getByThread(msg.existingThreadId) : undefined)
    if (mappedSession && registry.has(mappedSession)) {
      targetSessionId = mappedSession
      const info = registry.get(mappedSession)!
      info.lastActive = Date.now()
      effectiveChatId = info.threadId
    }
  }
  if (targetSessionId === 'main' && chat_id !== msg.channelId) {
    const mappedSession = registry.getByThread(chat_id)
      ?? (msg.existingThreadId ? registry.getByThread(msg.existingThreadId) : undefined)
    if (mappedSession && registry.has(mappedSession)) {
      targetSessionId = mappedSession
      const info = registry.get(mappedSession)!
      info.lastActive = Date.now()
      effectiveChatId = info.threadId
    }
  }

  const { content, meta } = await buildNotificationPayload(msg, effectiveChatId)
  transport.sendOrQueue(targetSessionId, { type: 'notification', content, meta })
})
