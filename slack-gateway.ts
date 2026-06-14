/**
 * Slack gateway implementation.
 *
 * Uses @slack/bolt in Socket Mode to maintain a persistent WebSocket connection,
 * similar to Discord's gateway model.
 */

import { App, type MessageEvent, type GenericMessageEvent, type BotMessageEvent } from '@slack/bolt'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import type {
  ChatGateway,
  InboundMessage,
  SentMessage,
  ChannelInfo,
  FetchedMessage,
  ThreadInfo,
  DownloadedFile,
  ButtonDef,
  ButtonClick,
  AttachmentInfo,
} from './gateway.js'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const RECENT_SENT_CAP = 200

const HEALTH_CHECK_MS = 60_000
const HEALTH_CHECK_FAST_MS = 10_000
const STALE_THRESHOLD_MS = 3 * 60_000
const HEARTBEAT_WRITE_THROTTLE_MS = 10_000
const MAX_RECONNECT_ATTEMPTS = 2
const NETWORK_CHECK_TIMEOUT_MS = 5_000

/**
 * Slack renders FULL Markdown — tables, `-`/`*` lists, headings, code fences — only via the
 * `markdown_text` field. It can't be combined with `blocks`/`text` and caps at ~12k chars.
 * So: plain replies go through `markdown_text` (rich); button messages must use Block Kit (which
 * only does classic mrkdwn); anything past the cap falls back to classic mrkdwn `text`.
 *
 * We deliberately do NOT impose a house style here — presentation taste belongs to each bot's own
 * instructions/CLAUDE.md. This layer's only job is to make the full Markdown palette render reliably.
 */
const MARKDOWN_TEXT_MAX = 12000
function applyMessageBody(payload: Record<string, unknown>, text: string, hasButtons: boolean): void {
  if (hasButtons || text.length > MARKDOWN_TEXT_MAX) payload.text = text
  else payload.markdown_text = text
}

export class SlackGateway implements ChatGateway {
  readonly platform = 'slack' as const
  readonly canThreadInDM = true
  readonly dmThreadsAreExclusive = true
  readonly healthCheckUrl = 'https://slack.com/api/api.test'
  private app: App | null = null
  private _botId: string | null = null
  private _botUserId: string | null = null
  private _teamId: string | null = null
  private _teamDomain: string | null = null
  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null
  private threadDeleteHandler: ((threadId: string) => void) | null = null
  private messageDeleteHandler: ((messageId: string, threadId: string | null) => void) | null = null
  private buttonClickHandler: ((click: ButtonClick) => void) | null = null
  private recentSentIds = new Set<string>()
  private appToken: string
  private token: string | null = null
  private lastEventAt = Date.now()
  private lastHeartbeatWrite = 0
  private healthInterval: ReturnType<typeof setInterval> | null = null
  private heartbeatPath: string | null = null
  private staleThresholdMs: number
  private reconnecting = false
  private reconnectAttempts = 0
  onReconnectAfterOutage: ((gapMs: number) => void) | undefined = undefined

  async forceReconnect(): Promise<{ ok: boolean; message: string }> {
    if (this.reconnecting) return { ok: false, message: 'reconnect already in progress' }
    const networkUp = await this.checkNetwork()
    if (!networkUp) return { ok: false, message: 'network unreachable' }
    try {
      const gapMs = Date.now() - this.lastEventAt
      await this.start(this.token!)
      this.reconnectAttempts = 0
      this.setHealthCheckInterval(HEALTH_CHECK_MS)
      if (gapMs > 10 * 60_000 && this.onReconnectAfterOutage) {
        this.onReconnectAfterOutage(gapMs)
      }
      return { ok: true, message: 'reconnected' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  constructor(appToken: string, opts?: { heartbeatPath?: string; staleThresholdMs?: number }) {
    this.appToken = appToken
    this.heartbeatPath = opts?.heartbeatPath ?? null
    this.staleThresholdMs = opts?.staleThresholdMs ?? STALE_THRESHOLD_MS
  }

  get botId(): string | null {
    return this._botUserId
  }

  async start(token: string): Promise<void> {
    this.token = token
    if (this.app) {
      try { await this.app.stop() } catch {}
      this.app = null
    }

    this.app = new App({
      token,
      appToken: this.appToken,
      socketMode: true,
      // Don't log to stdout — we write to stderr like the Discord gateway
      logLevel: 'ERROR' as any,
    })

    // Handle all messages
    this.app.message(async ({ message, client }) => {
      this.touchHeartbeat()
      if (!this.messageHandler) return
      // Skip bot messages
      if (message.subtype === 'bot_message') return
      if (!('user' in message) || !message.user) return

      const msg = message as GenericMessageEvent

      // Fetch user info for username
      let username = msg.user
      try {
        const userInfo = await client.users.info({ user: msg.user })
        username = userInfo.user?.profile?.display_name || userInfo.user?.real_name || userInfo.user?.name || msg.user
      } catch {}

      const normalized = await this.normalizeMessage(msg, username, client)
      this.messageHandler(normalized).catch(e =>
        process.stderr.write(`slack gateway: message handler error: ${e}\n`),
      )
    })

    // Handle app_mention events (for @mentions in channels where the bot isn't a member)
    this.app.event('app_mention', async ({ event, client }) => {
      this.touchHeartbeat()
      if (!this.messageHandler) return

      let username = event.user
      try {
        const userInfo = await client.users.info({ user: event.user })
        username = userInfo.user?.profile?.display_name || userInfo.user?.real_name || userInfo.user?.name || event.user
      } catch {}

      // app_mention doesn't have the same shape as GenericMessageEvent,
      // but we can normalize it similarly
      const normalized: InboundMessage = {
        id: event.ts,
        channelId: event.channel,
        authorId: event.user,
        authorUsername: username,
        content: event.text ?? '',
        isDM: false,
        isThread: !!event.thread_ts && event.thread_ts !== event.ts,
        isBot: false,
        parentChannelId: event.thread_ts ? event.channel : null,
        hasExistingThread: false,
        existingThreadId: null,
        referenceMessageId: event.thread_ts ?? null,
        attachments: [],
        createdAt: new Date(parseFloat(event.ts) * 1000),
      }

      this.messageHandler(normalized).catch(e =>
        process.stderr.write(`slack gateway: app_mention handler error: ${e}\n`),
      )
    })

    // Handle button interactions (Block Kit actions)
    this.app.action(/^perm:/, async ({ action, body, ack, respond }) => {
      this.touchHeartbeat()
      await ack()
      if (!this.buttonClickHandler) return
      if (body.type !== 'block_actions') return

      const act = action as any
      const userId = body.user.id
      const messageText = body.message?.text ?? ''

      this.buttonClickHandler({
        userId,
        customId: act.action_id,
        messageContent: messageText,
        respond: async (text, buttons) => {
          if (buttons) {
            await respond({
              text,
              blocks: [
                { type: 'section', text: { type: 'mrkdwn', text } },
                {
                  type: 'actions',
                  elements: buttons.map(b => ({
                    type: 'button' as const,
                    text: { type: 'plain_text' as const, text: `${b.emoji ? b.emoji + ' ' : ''}${b.label}` },
                    action_id: b.id,
                    style: b.style === 'success' ? 'primary' as const : b.style === 'danger' ? 'danger' as const : undefined,
                  })),
                },
              ],
              replace_original: true,
            })
          } else {
            await respond({ text, replace_original: false })
          }
        },
        clearButtons: async (text) => {
          await respond({
            text,
            blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
            replace_original: true,
          })
        },
      })
    })

    await this.app.start()

    // Get bot identity
    try {
      const auth = await this.app.client.auth.test({ token })
      this._botId = auth.bot_id ?? null
      this._botUserId = auth.user_id ?? null
      this._teamId = auth.team_id ?? null
      const url = auth.url as string | undefined
      if (url) {
        try { this._teamDomain = new URL(url).hostname.split('.')[0] } catch {}
      }
      process.stderr.write(`slack gateway: connected as ${auth.user} (bot_id: ${this._botId}, team: ${this._teamId}, domain: ${this._teamDomain})\n`)
    } catch (err) {
      process.stderr.write(`slack gateway: auth.test failed: ${err}\n`)
    }

    this.touchHeartbeat()
    if (!this.healthInterval) {
      this.startHealthCheck()
    }
  }

  async stop(): Promise<void> {
    if (this.healthInterval) {
      clearInterval(this.healthInterval)
      this.healthInterval = null
    }
    if (this.app) {
      await this.app.stop()
    }
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onThreadDelete(handler: (threadId: string) => void): void {
    this.threadDeleteHandler = handler
  }

  onMessageDelete(handler: (messageId: string, threadId: string | null) => void): void {
    this.messageDeleteHandler = handler
  }

  onButtonClick(handler: (click: ButtonClick) => void): void {
    this.buttonClickHandler = handler
  }

  /** Parse composite thread IDs (channelId:threadTs) into channel + thread_ts */
  private parseChannelId(id: string): { channel: string; threadTs?: string } {
    // Slack timestamps contain a dot (e.g. 1779979488.572029)
    // Composite format: C0B6KKFNH4N:1779979488.572029
    const colonIdx = id.indexOf(':')
    if (colonIdx > 0) {
      const maybeCh = id.slice(0, colonIdx)
      const maybeTs = id.slice(colonIdx + 1)
      // Validate: channel IDs start with C/D/G, timestamps contain a dot
      if (/^[CDG]/.test(maybeCh) && maybeTs.includes('.')) {
        return { channel: maybeCh, threadTs: maybeTs }
      }
    }
    return { channel: id }
  }

  async send(channelId: string, text: string, opts?: {
    replyTo?: string
    files?: string[]
    buttons?: ButtonDef[]
    unfurl?: boolean
    mrkdwn?: boolean
  }): Promise<SentMessage> {
    if (!this.app) throw new Error('not connected')

    const parsed = this.parseChannelId(channelId)
    process.stderr.write(`slack gateway send: channelId=${channelId} parsed=${JSON.stringify(parsed)} replyTo=${opts?.replyTo ?? 'none'}\n`)

    const payload: Record<string, unknown> = { channel: parsed.channel }

    // If channelId was a composite thread ID, always reply in that thread
    if (parsed.threadTs) {
      payload.thread_ts = parsed.threadTs
    }

    // Explicit replyTo overrides
    if (opts?.replyTo) {
      payload.thread_ts = opts.replyTo
    }

    // Render full Markdown via markdown_text; buttons and mrkdwn opt-in force the classic text path.
    if (opts?.mrkdwn) {
      payload.text = text
    } else {
      applyMessageBody(payload, text, !!opts?.buttons?.length)
    }

    // Buttons via Block Kit
    if (opts?.buttons?.length) {
      payload.blocks = [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'actions',
          elements: opts.buttons.map(b => ({
            type: 'button',
            text: { type: 'plain_text', text: `${b.emoji ? b.emoji + ' ' : ''}${b.label}` },
            action_id: b.id,
            style: b.style === 'success' ? 'primary' : b.style === 'danger' ? 'danger' : undefined,
          })),
        },
      ]
    }

    // Upload files first if any, then post message
    if (opts?.files?.length) {
      for (const filePath of opts.files) {
        try {
          const content = readFileSync(filePath)
          const fileName = filePath.split('/').pop() ?? 'file'
          await this.app.client.files.uploadV2({
            channel_id: parsed.channel,
            file: content,
            filename: fileName,
            thread_ts: opts?.replyTo ?? parsed.threadTs,
          })
        } catch (err) {
          process.stderr.write(`slack gateway: file upload failed for ${filePath}: ${err}\n`)
        }
      }
    }

    if (opts?.unfurl === false) {
      payload.unfurl_links = false
      payload.unfurl_media = false
    }

    const result = await this.app.client.chat.postMessage(payload as any)
    const sentId = result.ts!
    this.noteSent(sentId)
    return { id: sentId, channelId }
  }

  async edit(channelId: string, messageId: string, text: string): Promise<string> {
    if (!this.app) throw new Error('not connected')
    const { channel } = this.parseChannelId(channelId)
    const payload: Record<string, unknown> = { channel, ts: messageId }
    applyMessageBody(payload, text, false)
    const result = await this.app.client.chat.update(payload as any)
    return result.ts!
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.app) throw new Error('not connected')
    const { channel } = this.parseChannelId(channelId)
    const name = this.emojiToSlackName(emoji)
    await this.app.client.reactions.add({
      channel,
      timestamp: messageId,
      name,
    })
  }

  async typing(channelId: string): Promise<void> {
    // Slack doesn't have a typing indicator API for bots.
    // No-op.
  }

  async fetchChannel(id: string): Promise<ChannelInfo> {
    if (!this.app) throw new Error('not connected')
    const parsed = this.parseChannelId(id)
    const result = await this.app.client.conversations.info({ channel: parsed.channel })
    const ch = result.channel!
    const isDM = ch.is_im ?? false
    return {
      id,
      isDM,
      isThread: !!parsed.threadTs,
      parentId: null,
      recipientId: isDM ? (ch as any).user ?? '' : '',
      sendable: true,
    }
  }

  async fetchMessages(channelId: string, limit: number): Promise<FetchedMessage[]> {
    if (!this.app) throw new Error('not connected')
    const parsed = this.parseChannelId(channelId)
    // If it's a thread, fetch thread replies instead of channel history
    const result = parsed.threadTs
      ? await this.app.client.conversations.replies({
          channel: parsed.channel,
          ts: parsed.threadTs,
          limit: Math.min(limit, 100),
        })
      : await this.app.client.conversations.history({
          channel: parsed.channel,
          limit: Math.min(limit, 100),
        })

    const messages = (result.messages ?? []).reverse()
    const fetched: FetchedMessage[] = []

    for (const m of messages) {
      let username = m.user ?? 'unknown'
      if (m.user) {
        try {
          const userInfo = await this.app.client.users.info({ user: m.user })
          username = userInfo.user?.profile?.display_name || userInfo.user?.real_name || userInfo.user?.name || m.user
        } catch {}
      }
      fetched.push({
        id: m.ts!,
        authorId: m.user ?? m.bot_id ?? 'unknown',
        authorUsername: username,
        content: m.text ?? '',
        attachmentCount: (m.files ?? []).length,
        createdAt: new Date(parseFloat(m.ts!) * 1000),
      })
    }
    return fetched
  }

  async createThread(channelId: string, name: string, opts?: {
    messageId?: string
    archiveDuration?: number
    text?: string
    files?: string[]
  }): Promise<ThreadInfo> {
    if (!this.app) throw new Error('not connected')
    const { channel } = this.parseChannelId(channelId)

    // In Slack, threads are replies to a parent message.
    // If messageId is given, reply in that thread. Otherwise post a new parent message.
    let threadTs: string

    if (opts?.messageId) {
      threadTs = opts.messageId
    } else {
      // Post a parent message that acts as the thread anchor
      const anchor = await this.app.client.chat.postMessage({
        channel,
        text: `*${name}*`,
      })
      threadTs = anchor.ts!
      this.noteSent(threadTs)
    }

    let messageId: string | undefined
    if (opts?.text) {
      const reply = await this.app.client.chat.postMessage({
        channel,
        text: opts.text,
        thread_ts: threadTs,
      })
      messageId = reply.ts!
      this.noteSent(messageId)
    }

    // File uploads in thread
    if (opts?.files?.length) {
      for (const filePath of opts.files) {
        try {
          const content = readFileSync(filePath)
          const fileName = filePath.split('/').pop() ?? 'file'
          await this.app.client.files.uploadV2({
            channel_id: channel,
            file: content,
            filename: fileName,
            thread_ts: threadTs,
          })
        } catch (err) {
          process.stderr.write(`slack gateway: thread file upload failed: ${err}\n`)
        }
      }
    }

    const url = this.buildMessageUrl(channel, threadTs)
    // In Slack, the "thread ID" is the parent message timestamp
    // We encode it as channel:threadTs for the daemon to use
    return { id: `${channel}:${threadTs}`, url }
  }

  async downloadAttachments(channelId: string, messageId: string, inboxDir: string): Promise<DownloadedFile[]> {
    if (!this.app) throw new Error('not connected')
    const { channel } = this.parseChannelId(channelId)

    // Fetch the specific message
    const result = await this.app.client.conversations.history({
      channel,
      latest: messageId,
      inclusive: true,
      limit: 1,
    })

    const msg = result.messages?.[0]
    if (!msg || !msg.files?.length) return []

    const results: DownloadedFile[] = []
    for (const file of msg.files) {
      if (!file.url_private_download && !file.url_private) continue
      const url = file.url_private_download ?? file.url_private!
      const size = file.size ?? 0
      if (size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`attachment too large: ${(size / 1024 / 1024).toFixed(1)}MB, max 25MB`)
      }

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.app.client.token}` },
      })
      const buf = Buffer.from(await res.arrayBuffer())

      const name = file.name ?? `${file.id}`
      const sanitizedName = name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `${inboxDir}/${Date.now()}-${sanitizedName}`
      mkdirSync(inboxDir, { recursive: true })
      writeFileSync(path, buf)

      results.push({
        path,
        name: (file.name ?? file.id ?? 'unknown').replace(/[\[\]\r\n;]/g, '_'),
        contentType: file.mimetype ?? 'unknown',
        sizeKB: (size / 1024).toFixed(0),
      })
    }
    return results
  }

  async sendDM(userId: string, text: string, buttons?: ButtonDef[]): Promise<void> {
    if (!this.app) throw new Error('not connected')

    // Open a DM channel
    const dm = await this.app.client.conversations.open({ users: userId })
    const channelId = dm.channel!.id!

    const payload: Record<string, unknown> = { channel: channelId }
    applyMessageBody(payload, text, !!buttons?.length)
    if (buttons?.length) {
      payload.blocks = [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'actions',
          elements: buttons.map(b => ({
            type: 'button',
            text: { type: 'plain_text', text: `${b.emoji ? b.emoji + ' ' : ''}${b.label}` },
            action_id: b.id,
            style: b.style === 'success' ? 'primary' : b.style === 'danger' ? 'danger' : undefined,
          })),
        },
      ]
    }

    await this.app.client.chat.postMessage(payload as any)
  }

  async isMentioned(msg: InboundMessage, extraPatterns?: string[]): Promise<boolean> {
    // Check @mention of bot user
    if (this._botUserId && msg.content.includes(`<@${this._botUserId}>`)) return true

    // Check reply to one of our messages (in thread context)
    if (msg.referenceMessageId && this.recentSentIds.has(msg.referenceMessageId)) return true

    // Check extra patterns
    for (const pat of extraPatterns ?? []) {
      try {
        if (new RegExp(pat, 'i').test(msg.content)) return true
      } catch {}
    }
    return false
  }

  noteSent(id: string): void {
    this.recentSentIds.add(id)
    if (this.recentSentIds.size > RECENT_SENT_CAP) {
      const first = this.recentSentIds.values().next().value
      if (first) this.recentSentIds.delete(first)
    }
  }

  wasSentByUs(id: string): boolean {
    return this.recentSentIds.has(id)
  }

  getThreadAnchor(threadId: string): { channelId: string; messageId: string } | null {
    const parts = threadId.split(':')
    if (parts.length < 2) return null
    return { channelId: parts[0], messageId: parts.slice(1).join(':') }
  }

  getMessageUrl(threadId: string, messageTs: string): string {
    const anchor = this.getThreadAnchor(threadId)
    if (!anchor) return ''
    return this.buildMessageUrl(anchor.channelId, messageTs, anchor.messageId)
  }

  async getThreadUrl(threadId: string): Promise<string> {
    const anchor = this.getThreadAnchor(threadId)
    if (!anchor) return ''
    return this.buildMessageUrl(anchor.channelId, anchor.messageId)
  }

  /** Start a thread on a message (for threadReply policy). In Slack this just means replying in-thread. */
  async startThreadOnMessage(msg: InboundMessage, _preview: string, _archiveDuration: number): Promise<string | null> {
    // In Slack, a "thread" is just a message with thread_ts = parent ts.
    // The "thread ID" is the parent message ts within the channel.
    // We return channelId:ts as composite ID for the daemon.
    return `${msg.channelId}:${msg.id}`
  }

  /** Get thread context (starter info). */
  async getThreadStarterInfo(channelId: string): Promise<{
    threadName: string
    starterUser: string
    starterContent: string
    starterId: string
  } | null> {
    // For Slack threads, we'd need the parent message ts.
    // Since Slack threads don't have names, we return the parent message content.
    // This is called with channelId which for Slack threads might be "channelId:threadTs"
    if (!this.app) return null

    const parts = channelId.split(':')
    if (parts.length < 2) return null

    try {
      const result = await this.app.client.conversations.history({
        channel: parts[0],
        latest: parts.slice(1).join(':'),
        inclusive: true,
        limit: 1,
      })
      const msg = result.messages?.[0]
      if (!msg) return null

      let username = msg.user ?? 'unknown'
      if (msg.user) {
        try {
          const userInfo = await this.app.client.users.info({ user: msg.user })
          username = userInfo.user?.profile?.display_name || userInfo.user?.real_name || msg.user
        } catch {}
      }

      return {
        threadName: (msg.text ?? '').slice(0, 100),
        starterUser: username,
        starterContent: (msg.text ?? '').slice(0, 500),
        starterId: msg.ts!,
      }
    } catch {
      return null
    }
  }

  // --- Heartbeat & self-heal ---

  private touchHeartbeat(): void {
    this.lastEventAt = Date.now()
    if (this.heartbeatPath && (this.lastEventAt - this.lastHeartbeatWrite > HEARTBEAT_WRITE_THROTTLE_MS)) {
      this.lastHeartbeatWrite = this.lastEventAt
      this.writeHeartbeat()
    }
  }

  private writeHeartbeat(): void {
    if (!this.heartbeatPath) return
    try {
      writeFileSync(this.heartbeatPath, String(Date.now()) + '\n')
    } catch {}
  }

  private healthCheckMs = HEALTH_CHECK_MS

  private startHealthCheck(): void {
    if (this.healthInterval) clearInterval(this.healthInterval)
    this.healthInterval = setInterval(async () => {
      const elapsed = Date.now() - this.lastEventAt
      if (elapsed > this.staleThresholdMs) {
        process.stderr.write(`slack gateway: connection stale (${Math.round(elapsed / 1000)}s since last event), attempting reconnect\n`)
        await this.reconnect()
      }
      this.writeHeartbeat()
    }, this.healthCheckMs)
    this.healthInterval.unref()
  }

  private setHealthCheckInterval(ms: number): void {
    if (ms === this.healthCheckMs) return
    this.healthCheckMs = ms
    this.startHealthCheck()
  }

  private async checkNetwork(): Promise<boolean> {
    try {
      const resp = await fetch(this.healthCheckUrl, { signal: AbortSignal.timeout(NETWORK_CHECK_TIMEOUT_MS) })
      return resp.ok
    } catch {
      return false
    }
  }

  // Network-aware: if network is down, stay alive and poll fast (10s) instead of
  // exiting for watchdog restart. Prevents restart storms during extended outages.
  private async reconnect(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true
    try {
      const networkUp = await this.checkNetwork()
      if (!networkUp) {
        this.setHealthCheckInterval(HEALTH_CHECK_FAST_MS)
        process.stderr.write(`slack gateway: network unreachable, polling every ${HEALTH_CHECK_FAST_MS / 1000}s\n`)
        this.reconnectAttempts = 0
        this.writeHeartbeat()
        return
      }
      this.reconnectAttempts++
      if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        process.stderr.write(`slack gateway: ${this.reconnectAttempts} reconnect attempts exhausted (network is up), exiting for supervisor restart\n`)
        process.exit(1)
      }
      const gapMs = Date.now() - this.lastEventAt
      await this.start(this.token!)
      this.reconnectAttempts = 0
      this.setHealthCheckInterval(HEALTH_CHECK_MS)
      process.stderr.write(`slack gateway: reconnected successfully\n`)
      if (gapMs > 10 * 60_000 && this.onReconnectAfterOutage) {
        this.onReconnectAfterOutage(gapMs)
      }
    } catch (err) {
      process.stderr.write(`slack gateway: reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} failed: ${err}\n`)
      this.writeHeartbeat()
    } finally {
      this.reconnecting = false
    }
  }

  // --- Internal helpers ---

  private async normalizeMessage(msg: GenericMessageEvent, username: string, client: any): Promise<InboundMessage> {
    const atts: AttachmentInfo[] = (msg.files ?? []).map((f: any) => ({
      id: f.id ?? f.name ?? 'unknown',
      name: (f.name ?? f.id ?? 'unknown').replace(/[\[\]\r\n;]/g, '_'),
      contentType: f.mimetype ?? null,
      size: f.size ?? 0,
      url: f.url_private_download ?? f.url_private ?? '',
    }))

    // In Slack, thread_ts !== ts means this is a threaded reply
    const isThread = !!msg.thread_ts && msg.thread_ts !== msg.ts
    // DM detection: channel type starts with 'D'
    const isDM = msg.channel_type === 'im'

    return {
      id: msg.ts,
      channelId: msg.channel,
      authorId: msg.user,
      authorUsername: username,
      content: msg.text ?? '',
      isDM,
      isThread,
      isBot: false,
      parentChannelId: isThread ? msg.channel : null,
      hasExistingThread: false,
      existingThreadId: isThread ? `${msg.channel}:${msg.thread_ts}` : null,
      referenceMessageId: msg.thread_ts ?? null,
      attachments: atts,
      createdAt: new Date(parseFloat(msg.ts) * 1000),
    }
  }

  private buildMessageUrl(channelId: string, ts: string, threadTs?: string): string {
    const tsClean = ts.replace('.', '')
    const domain = this._teamDomain ?? 'app'
    const threadParam = threadTs ? `?thread_ts=${threadTs}&cid=${channelId}` : ''
    return `https://${domain}.slack.com/archives/${channelId}/p${tsClean}${threadParam}`
  }

  private emojiToSlackName(emoji: string): string {
    // Common unicode → Slack emoji name mappings
    const map: Record<string, string> = {
      '👀': 'eyes',
      '👍': 'thumbsup',
      '👎': 'thumbsdown',
      '❤️': 'heart',
      '✅': 'white_check_mark',
      '❌': 'x',
      '🎉': 'tada',
      '🤔': 'thinking_face',
      '👂': 'ear',
      '⏸️': 'double_vertical_bar',
      '🔥': 'fire',
      '💯': '100',
      '⭐': 'star',
      '🚀': 'rocket',
      '📋': 'clipboard',
      '📊': 'bar_chart',
      '📈': 'chart_with_upwards_trend',
      '💚': 'green_heart',
      '☠️': 'skull_and_crossbones',
      '🍴': 'fork_and_knife',
      '🍽️': 'knife_fork_plate',
      '🤝': 'handshake',
      '🔄': 'arrows_counterclockwise',
      '🔌': 'electric_plug',
    }
    if (map[emoji]) return map[emoji]
    // If it's already a text name (no colons), return as-is
    if (/^[a-z0-9_+-]+$/i.test(emoji)) return emoji
    // Strip colons if present
    if (emoji.startsWith(':') && emoji.endsWith(':')) return emoji.slice(1, -1)
    // Fallback: try to use it directly (Slack will error if invalid)
    return emoji
  }
}
