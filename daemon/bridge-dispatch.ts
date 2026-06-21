import { statSync } from 'fs'
import { gateway, INBOX_DIR } from './config.js'
import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { loadAccess, MAX_CHUNK_LIMIT, MAX_ATTACHMENT_BYTES } from './access.js'
import { doSpawnSession, killSession } from './session-lifecycle.js'
import { fallbackDescription, formatDuration, getContextPercent, chunk, assertSendable } from './util.js'

// ---------------------------------------------------------------------------
// Bridge tool definitions (sent to bridges on registration for dynamic refresh)
// ---------------------------------------------------------------------------

export const BRIDGE_TOOLS = [
  { name: 'reply', description: 'Reply in chat. Pass chat_id from the inbound message.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' }, reply_to: { type: 'string', description: 'Message ID to thread under.' }, files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to attach.' } }, required: ['chat_id', 'text'] } },
  { name: 'react', description: 'Add an emoji reaction to a message.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' }, emoji: { type: 'string' } }, required: ['chat_id', 'message_id', 'emoji'] } },
  { name: 'edit_message', description: 'Edit a message the bot previously sent.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' }, text: { type: 'string' } }, required: ['chat_id', 'message_id', 'text'] } },
  { name: 'delete_message', description: 'Delete a message. Bot can delete its own messages; in DMs the bot can also delete user messages.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' } }, required: ['chat_id', 'message_id'] } },
  { name: 'download_attachment', description: 'Download attachments from a message.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' } }, required: ['chat_id', 'message_id'] } },
  { name: 'create_thread', description: 'Create a thread in a channel.', inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, message_id: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' }, auto_archive_minutes: { type: 'number' }, files: { type: 'array', items: { type: 'string' } } }, required: ['chat_id', 'name'] } },
  { name: 'fetch_messages', description: 'Fetch recent messages from a channel.', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number' } }, required: ['channel'] } },
  { name: 'spawn_session', description: 'Spawn a new Claude session. Main session only. Pass worktree with a repo directory name (e.g. "options_bot") to spawn in an isolated git worktree.', inputSchema: { type: 'object', properties: { topic: { type: 'string' }, chat_id: { type: 'string' }, message_id: { type: 'string' }, worktree: { type: 'string', description: 'Git repo subdirectory to create a worktree from (e.g. "options_bot", "anytester"). Session gets an isolated copy.' } }, required: ['topic'] } },
  { name: 'list_sessions', description: 'List all active sessions. Main session only.', inputSchema: { type: 'object', properties: {} } },
  { name: 'kill_session', description: 'Kill a session by ID or thread ID. Main session only.', inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, thread_id: { type: 'string' } } } },
  { name: 'set_description', description: 'Set a brief description for your session.', inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, description: { type: 'string' } }, required: ['session_id', 'description'] } },
]

export const SPAWN_MODEL = 'claude-opus-4-6[1m]'
export const MAIN_ONLY_TOOLS = new Set(['spawn_session', 'list_sessions', 'kill_session'])

export function computeToolsForSession(sessionId: string): typeof BRIDGE_TOOLS {
  if (sessionId === 'main') return BRIDGE_TOOLS
  return BRIDGE_TOOLS.filter(t => !MAIN_ONLY_TOOLS.has(t.name))
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export type ToolResult = { content: Array<{type: string; text: string}>; isError?: boolean; sentIds?: string[] }

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
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

        const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
        const mode = access.chunkMode ?? 'length'
        const replyMode = access.replyToMode ?? 'first'
        const chunks = chunk(text, limit, mode)
        const sentIds: string[] = []

        try {
          for (let i = 0; i < chunks.length; i++) {
            const shouldReplyTo =
              reply_to != null &&
              replyMode !== 'off' &&
              (replyMode === 'all' || i === 0)
            const sent = await gateway.send(chat_id, chunks[i], {
              ...(i === 0 && files.length > 0 ? { files } : {}),
              ...(shouldReplyTo ? { replyTo: reply_to } : {}),
            })
            sentIds.push(sent.id)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
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
        await gateway.react(args.chat_id as string, args.message_id as string, args.emoji as string)
        return { content: [{ type: 'text', text: 'reacted' }] }
      }

      case 'edit_message': {
        const edited = await gateway.edit(args.chat_id as string, args.message_id as string, args.text as string)
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
        const result = await doSpawnSession(topic, args.chat_id as string | undefined, args.message_id as string | undefined)
        return { content: [{ type: 'text', text: `session spawned (name: ${result.name}, session_id: ${result.sessionId}, thread_id: ${result.threadId}${result.url ? `, url: ${result.url}` : ''})` }] }
      }

      case 'list_sessions': {
        const sorted = [...registry.values()].sort((a, b) => b.lastActive - a.lastActive)
        const list = sorted.map(s => {
          const desc = s.description ?? fallbackDescription(s.topic)
          return {
            name: s.tmuxName,
            description: desc,
            url: s.threadUrl ?? '',
            context: getContextPercent(s.tmuxName),
            messages: s.messageCount ?? 0,
            running_for: formatDuration(Date.now() - s.createdAt),
            status: transport.has(s.sessionId) ? 'connected' : 'disconnected',
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
        await killSession(info, 'session ended')
        return { content: [{ type: 'text', text: `killed session ${targetId}` }] }
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
