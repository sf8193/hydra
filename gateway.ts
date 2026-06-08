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
  attachments: AttachmentInfo[]
  createdAt: Date
}

export type SentMessage = {
  id: string
  channelId: string
}

export type ChannelInfo = {
  id: string
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

export type ThreadStarterInfo = {
  threadName: string
  starterUser: string
  starterContent: string
  starterId: string
}

export interface ChatGateway {
  readonly platform: 'discord' | 'slack'
  readonly botId: string | null

  readonly canThreadInDM: boolean
  readonly dmThreadsAreExclusive: boolean
  readonly healthCheckUrl: string

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

  // Sending
  send(channelId: string, text: string, opts?: {
    replyTo?: string
    files?: string[]
    buttons?: ButtonDef[]
    unfurl?: boolean
  }): Promise<SentMessage>
  edit(channelId: string, messageId: string, text: string): Promise<string>
  react(channelId: string, messageId: string, emoji: string): Promise<void>
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

  // Thread structure
  getThreadAnchor(threadId: string): { channelId: string; messageId: string } | null

  // URL building
  getThreadUrl(threadId: string): Promise<string>
  getMessageUrl(threadId: string, messageTs: string): string
}
