/**
 * Chat gateway interface — platform-agnostic abstraction over Discord/Slack.
 *
 * The daemon imports a concrete gateway and calls these methods.
 * Each gateway handles its own connection lifecycle, message normalization,
 * and platform-specific API calls.
 */

export type AttachmentInfo = {
  id: string
  name: string
  contentType: string | null
  size: number
  url: string
}

export type InboundMessage = {
  id: string
  channelId: string
  authorId: string
  authorUsername: string
  content: string
  isDM: boolean
  isThread: boolean
  isBot: boolean
  parentChannelId: string | null
  hasExistingThread: boolean
  existingThreadId: string | null
  referenceMessageId: string | null
  effectiveThreadId: string | null  // normalized thread ID: in Discord = channelId when isThread; in Slack = channel:thread_ts
  attachments: AttachmentInfo[]
  createdAt: Date
}

export type SentMessage = {
  id: string
  channelId: string
}

export type ChannelInfo = {
  id: string
  name?: string
  isDM: boolean
  isThread: boolean
  parentId: string | null
  /** Slack: recipientId only available on DMs */
  recipientId: string
  sendable: boolean
}

export type FetchedMessage = {
  id: string
  authorId: string
  authorUsername: string
  content: string
  attachmentCount: number
  createdAt: Date
}

export type ThreadInfo = {
  id: string
  url: string
}

export type DownloadedFile = {
  path: string
  name: string
  contentType: string
  sizeKB: string
}

export type ButtonDef = {
  id: string
  label: string
  style: 'success' | 'danger' | 'secondary'
  emoji?: string
}

export type ButtonClick = {
  userId: string
  customId: string
  messageContent: string
  respond: (text: string, buttons?: ButtonDef[]) => Promise<void>
  clearButtons: (text: string) => Promise<void>
}

export type ReactionEvent = {
  channelId: string
  messageId: string
  userId: string
  emoji: string
}

export type ThreadStarterInfo = {
  threadName: string
  starterUser: string
  starterContent: string
  starterId: string
}

/**
 * Sanitize an attachment filename for safe local storage.
 * - Strips leading dots (prevents hidden files)
 * - Replaces non-alphanumeric/dot/dash/underscore chars
 * - Truncates to maxLen chars (preserving extension when possible)
 * - Falls back to fallbackId if the result is empty
 */
export const COUNT_EMOJI = ['2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '👨‍👩‍👦‍👦']
export const SUPERSCRIPT = ['⁰','¹','²','³','⁴','⁵','⁶','⁷','⁸','⁹']
export const SUBSCRIPT = ['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉']

export type SessionVisualOpts = {
  state: 'live' | 'killed' | 'crashed' | 'zombie'
  emoji: string
  sessionName: string
  description?: string
  topic?: string
  badge?: string
  respawnCount?: number
  paused?: boolean
  anchorChannelId?: string
  anchorMessageId?: string
}

export function sanitizeFilename(raw: string, fallbackId: string, maxLen = 200): string {
  const cleaned = raw.replace(/^\.+/, '').replace(/[^a-zA-Z0-9._-]/g, '_')
  let result: string
  if (cleaned.length > maxLen) {
    const dotIdx = cleaned.lastIndexOf('.')
    if (dotIdx > 0) {
      const ext = cleaned.slice(dotIdx)
      const stem = cleaned.slice(0, maxLen - ext.length)
      result = stem + ext
    } else {
      result = cleaned.slice(0, maxLen)
    }
  } else {
    result = cleaned
  }
  return result || fallbackId
}

export interface ChatGateway {
  readonly platform: 'discord' | 'slack'
  readonly botId: string | null

  readonly canThreadInDM: boolean
  readonly dmThreadsAreExclusive: boolean
  readonly healthCheckUrl: string
  readonly maxMessageLength: number

  // Lifecycle
  start(token: string): Promise<void>
  stop(): Promise<void>

  // Resilience (optional — gateways implement if their transport needs it)
  forceReconnect?(): Promise<{ ok: boolean; message: string }>
  onReconnectAfterOutage?: (gapMs: number) => void

  // Event registration
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void
  onThreadDelete(handler: (threadId: string) => void): void
  onMessageDelete(handler: (messageId: string, threadId: string | null) => void): void
  onButtonClick(handler: (click: ButtonClick) => void): void
  onReaction?(handler: (event: ReactionEvent) => Promise<void>): void

  // Sending
  send(channelId: string, text: string, opts?: {
    replyTo?: string
    files?: string[]
    buttons?: ButtonDef[]
    unfurl?: boolean
  }): Promise<SentMessage>
  edit(channelId: string, messageId: string, text: string): Promise<string>
  delete(channelId: string, messageId: string): Promise<void>
  react(channelId: string, messageId: string, emoji: string): Promise<void>
  unreact(channelId: string, messageId: string, emoji: string): Promise<void>
  typing(channelId: string): Promise<void>

  // Channels & threads
  fetchChannel(id: string): Promise<ChannelInfo>
  fetchMessages(channelId: string, limit: number): Promise<FetchedMessage[]>
  createThread(channelId: string, name: string, opts?: {
    messageId?: string
    archiveDuration?: number
    text?: string
    files?: string[]
  }): Promise<ThreadInfo>
  startThreadOnMessage(msg: InboundMessage, preview: string, archiveDuration: number): Promise<string | null>
  renameThread?(threadId: string, name: string): Promise<void>
  getThreadStarterInfo(channelId: string): Promise<ThreadStarterInfo | null>

  // Attachments
  downloadAttachments(channelId: string, messageId: string, inboxDir: string): Promise<DownloadedFile[]>

  // Users
  sendDM(userId: string, text: string, buttons?: ButtonDef[]): Promise<void>

  // Mention detection
  isMentioned(msg: InboundMessage, extraPatterns?: string[]): Promise<boolean>

  // Sent message tracking (for mention-by-reply detection)
  noteSent(id: string): void
  wasSentByUs(id: string): boolean

  // Session lifecycle visual — platform-specific rendering of lifecycle state
  updateSessionVisual?(threadId: string, opts: SessionVisualOpts): Promise<void>

  // Thread structure
  getThreadAnchor(threadId: string): { channelId: string; messageId: string } | null

  // URL building
  getThreadUrl(threadId: string): Promise<string>
  getMessageUrl(threadId: string, messageTs: string): string
  getLastReplyId?(threadId: string): Promise<string | null>
}
