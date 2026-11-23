/**
 * Chat gateway interface — platform-agnostic abstraction over Discord/Slack.
 *
 * The daemon imports a concrete gateway and calls these methods.
 * Each gateway handles its own connection lifecycle, message normalization,
 * and platform-specific API calls.
 */
import type { InboxLimits } from '../config/write-confinement.js'

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

/** The earlier message a reply answers. `author` and `content` are null when the platform no longer has them; `byUs`: the bot sent it. */
export type ReplyContext = {
  id: string
  author: string | null
  content: string | null
  byUs: boolean
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
  // Where it happened, as on InboundMessage, so the daemon can tell whether it is allowed there.
  isDM: boolean
  parentChannelId: string | null
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

/** What a session's thread shows about its life. `respawned_session`: the session runs and has been respawned at least once (the Discord anchor shows the count as a digit). In memory only, recomputed from `respawnCount`: nothing stores it. */
export const ANCHOR_STATES = ['live', 'crashed', 'killed', 'respawned_session'] as const
export type AnchorState = typeof ANCHOR_STATES[number]

export type SessionVisualOpts = {
  state: AnchorState
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

/** Text on its way out, as a gateway's shapeOutbound left it, with the files that made (attached to the first chunk). */
export type Outbound = { text: string; files: string[] }

export interface ChatGateway {
  readonly platform: 'discord' | 'slack'
  readonly botId: string | null

  readonly canThreadInDM: boolean
  readonly dmThreadsAreExclusive: boolean
  /** `react` posts the emoji on the message. False: the call succeeds as a no-op and nothing shows, so it acknowledges nothing. */
  readonly postsReactions: boolean
  readonly healthCheckUrl: string
  readonly maxMessageLength: number
  /** Files one message may carry. */
  readonly maxAttachments: number

  // Lifecycle
  start(token: string): Promise<void>
  stop(): Promise<void>
  /** The transport is connected now. */
  isConnected(): boolean

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
  /**
   * Optional: how this platform shows outbound markdown it does not render itself (Discord: tables as pictures, box art
   * fenced). Calls `post` once with the text to send and any files it made, at most `maxFiles` of them (0 for an edit,
   * which cannot add files), and removes those files once `post` settles. A gateway without it posts text as written.
   * The daemon calls it through withOutbound (infra/util.ts) before it chunks the text.
   */
  shapeOutbound?<R>(text: string, maxFiles: number, post: (out: Outbound) => Promise<R>): Promise<R>
  send(channelId: string, text: string, opts?: {
    replyTo?: string
    files?: string[]
    buttons?: ButtonDef[]
    unfurl?: boolean
    /** Small grey secondary text: Discord's `-#`, a Slack context block. */
    subtext?: boolean
  }): Promise<SentMessage>
  edit(channelId: string, messageId: string, text: string): Promise<string>
  delete(channelId: string, messageId: string): Promise<void>
  pin?(channelId: string, messageId: string): Promise<void>
  unpin?(channelId: string, messageId: string): Promise<void>
  react(channelId: string, messageId: string, emoji: string): Promise<void>
  unreact(channelId: string, messageId: string, emoji: string): Promise<void>
  typing(channelId: string): Promise<void>

  // Channels & threads
  /** Whether `id` has the shape of a channel or thread this platform can address. Shape only: a session id, a name or a stub is not. */
  isThreadId(id: string): boolean
  fetchChannel(id: string): Promise<ChannelInfo>
  /** False when the platform says the thread is gone, or `id` cannot be one (`isThreadId`); any other failure counts as present. Never throws. */
  threadExists(threadId: string): Promise<boolean>
  fetchMessages(channelId: string, limit: number): Promise<FetchedMessage[]>
  createThread(channelId: string, name: string, opts?: {
    messageId?: string
    archiveDuration?: number
    text?: string
    files?: string[]
  }): Promise<ThreadInfo>
  startThreadOnMessage(msg: InboundMessage, preview: string, archiveDuration: number): Promise<string | null>
  renameThread?(threadId: string, name: string): Promise<void>
  deleteThread?(threadId: string): Promise<void>
  getThreadStarterInfo(channelId: string): Promise<ThreadStarterInfo | null>

  // Attachments
  /** Saves a message's attachments in `inboxDir`. `limits` is given for a write-confined specialist's own inbox (its caps and the checks of infra/confined-inbox.ts); absent for the shared inbox. */
  downloadAttachments(channelId: string, messageId: string, inboxDir: string, limits?: InboxLimits): Promise<DownloadedFile[]>

  // Users
  sendDM(userId: string, text: string, buttons?: ButtonDef[]): Promise<void>

  /**
   * Whether a message this gateway sends shows `emoji` as a picture: a unicode emoji always; a custom one (`<:name:id>`) only where this platform
   * has it, which is one server (Discord: the bot sees it in a guild's cache). False shows as raw text, so the caller picks another.
   */
  canRenderEmoji(emoji: string): boolean

  // Mention detection
  isMentioned(msg: InboundMessage, extraPatterns?: string[]): Promise<boolean>

  /**
   * Optional: the message `msg` replies to, when the platform has a reply that points at one message
   * (Discord's Reply). A gateway whose `referenceMessageId` is not such a pointer (Slack: the thread
   * root) leaves it out. May reject; the caller then keeps the id alone.
   */
  getReplyContext?(msg: InboundMessage): Promise<ReplyContext | null>

  /**
   * Optional: `at` as text the platform draws itself, live and in the reader's own timezone (Discord: `<t:…:R>`). A gateway without it leaves the
   * caller to write the time out.
   */
  relativeTime?(at: Date): string

  // Sent message tracking (for mention-by-reply detection)
  noteSent(id: string): void
  wasSentByUs(id: string): boolean
  /**
   * Whether `msg` is a reply to one of our messages: the platform's reply pointer names a message we sent. A gateway whose
   * `referenceMessageId` is only the thread root (Slack) has no such pointer, so a message in a thread we opened is not a reply to us.
   */
  isReplyToUs(msg: InboundMessage): boolean

  // Session lifecycle visual — platform-specific rendering of lifecycle state
  updateSessionVisual?(threadId: string, opts: SessionVisualOpts): Promise<void>

  // Thread structure
  getThreadAnchor(threadId: string): { channelId: string; messageId: string } | null

  // URL building
  getThreadUrl(threadId: string): Promise<string>
  getMessageUrl(threadId: string, messageTs: string): string
  /** How a message in this chat points at a thread so the chat renders it as a live link to that thread, where the platform has such a form (Discord: `<#id>`). Absent: the thread's URL is the pointer. */
  threadMention?(threadId: string): string
  getMessageAppLink?(threadId: string, messageTs: string): string
  getLastReplyId?(threadId: string): Promise<string | null>
}
