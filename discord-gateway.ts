/**
 * Discord gateway implementation.
 *
 * Wraps discord.js and implements the ChatGateway interface.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type Message,
} from 'discord.js'
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
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

export class DiscordGateway implements ChatGateway {
  readonly platform = 'discord' as const
  readonly canThreadInDM = false
  readonly dmThreadsAreExclusive = false
  readonly healthCheckUrl = 'https://discord.com/api/v10/gateway'
  private client: Client
  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null
  private threadDeleteHandler: ((threadId: string) => void) | null = null
  private messageDeleteHandler: ((messageId: string, threadId: string | null) => void) | null = null
  private buttonClickHandler: ((click: ButtonClick) => void) | null = null
  private recentSentIds = new Set<string>()

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    })
  }

  get botId(): string | null {
    return this.client.user?.id ?? null
  }

  async start(token: string): Promise<void> {
    this.client.on('messageCreate', msg => {
      if (msg.author.bot) return
      if (!this.messageHandler) return
      this.messageHandler(this.normalizeMessage(msg)).catch(e =>
        process.stderr.write(`discord gateway: messageCreate handler error: ${e}\n`),
      )
    })

    this.client.on('threadDelete', thread => {
      this.threadDeleteHandler?.(thread.id)
    })

    this.client.on('messageDelete', msg => {
      if (!msg.hasThread) return
      const threadId = msg.thread?.id ?? null
      if (threadId) this.messageDeleteHandler?.(msg.id, threadId)
    })

    this.client.on('interactionCreate', async interaction => {
      if (!interaction.isButton()) return
      if (!this.buttonClickHandler) return

      this.buttonClickHandler({
        userId: interaction.user.id,
        customId: interaction.customId,
        messageContent: interaction.message.content,
        respond: async (text, buttons) => {
          if (buttons) {
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
              ...buttons.map(b => {
                const btn = new ButtonBuilder()
                  .setCustomId(b.id)
                  .setLabel(b.label)
                  .setStyle(
                    b.style === 'success' ? ButtonStyle.Success :
                    b.style === 'danger' ? ButtonStyle.Danger :
                    ButtonStyle.Secondary,
                  )
                if (b.emoji) btn.setEmoji({ name: b.emoji })
                return btn
              }),
            )
            await interaction.update({ content: text, components: [row] }).catch(() => {})
          } else {
            await interaction.reply({ content: text, ephemeral: true }).catch(() => {})
          }
        },
        clearButtons: async (text) => {
          await interaction.update({ content: text, components: [] }).catch(() => {})
        },
      })
    })

    this.client.on('error', err => {
      process.stderr.write(`discord gateway: client error: ${err}\n`)
    })

    await new Promise<void>((resolve) => {
      this.client.once('ready', c => {
        process.stderr.write(`discord gateway: connected as ${c.user.tag}\n`)
        resolve()
      })
      this.client.login(token).catch(err => {
        process.stderr.write(`discord gateway: login failed: ${err}\n`)
        process.exit(1)
      })
    })
  }

  async stop(): Promise<void> {
    await Promise.resolve(this.client.destroy())
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

  async send(channelId: string, text: string, opts?: {
    replyTo?: string
    files?: string[]
    buttons?: ButtonDef[]
  }): Promise<SentMessage> {
    const ch = await this.fetchTextChannel(channelId)
    if (!('send' in ch)) throw new Error('channel is not sendable')

    const payload: Record<string, unknown> = { content: text }
    if (opts?.files?.length) {
      for (const f of opts.files) {
        const st = statSync(f)
        if (st.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
        }
      }
      if (opts.files.length > 10) throw new Error('Discord allows max 10 attachments per message')
      payload.files = opts.files
    }
    if (opts?.replyTo) {
      payload.reply = { messageReference: opts.replyTo, failIfNotExists: false }
    }
    if (opts?.buttons?.length) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...opts.buttons.map(b => {
          const btn = new ButtonBuilder()
            .setCustomId(b.id)
            .setLabel(b.label)
            .setStyle(
              b.style === 'success' ? ButtonStyle.Success :
              b.style === 'danger' ? ButtonStyle.Danger :
              ButtonStyle.Secondary,
            )
          if (b.emoji) btn.setEmoji({ name: b.emoji })
          return btn
        }),
      )
      payload.components = [row]
    }

    const sent = await ch.send(payload)
    this.noteSent(sent.id)
    return { id: sent.id, channelId: sent.channelId }
  }

  async edit(channelId: string, messageId: string, text: string): Promise<string> {
    const ch = await this.fetchTextChannel(channelId)
    const msg = await ch.messages.fetch(messageId)
    const edited = await msg.edit(text)
    return edited.id
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const ch = await this.fetchTextChannel(channelId)
    const msg = await ch.messages.fetch(messageId)
    await msg.react(emoji)
  }

  async typing(channelId: string): Promise<void> {
    const ch = await this.fetchTextChannel(channelId)
    if ('sendTyping' in ch) {
      await (ch as any).sendTyping()
    }
  }

  async fetchChannel(id: string): Promise<ChannelInfo> {
    const ch = await this.client.channels.fetch(id)
    if (!ch || !ch.isTextBased()) {
      throw new Error(`channel ${id} not found or not text-based`)
    }
    return {
      id: ch.id,
      isDM: ch.type === ChannelType.DM,
      isThread: ch.isThread(),
      parentId: ch.isThread() ? ch.parentId : null,
      recipientId: ch.type === ChannelType.DM ? (ch as any).recipientId : '',
      sendable: 'send' in ch,
    }
  }

  async fetchMessages(channelId: string, limit: number): Promise<FetchedMessage[]> {
    const ch = await this.fetchTextChannel(channelId)
    const msgs = await ch.messages.fetch({ limit: Math.min(limit, 100) })
    return [...msgs.values()].reverse().map(m => ({
      id: m.id,
      authorId: m.author.id,
      authorUsername: m.author.username,
      content: m.content,
      attachmentCount: m.attachments.size,
      createdAt: m.createdAt,
    }))
  }

  async createThread(channelId: string, name: string, opts?: {
    messageId?: string
    archiveDuration?: number
    text?: string
    files?: string[]
  }): Promise<ThreadInfo> {
    const ch = await this.fetchTextChannel(channelId)
    const archiveDuration = opts?.archiveDuration ?? 1440
    let thread: any

    if (opts?.messageId) {
      const msg = await ch.messages.fetch(opts.messageId)
      thread = await msg.startThread({ name: name.slice(0, 100), autoArchiveDuration: archiveDuration })
    } else {
      if (!('threads' in ch)) throw new Error('channel does not support threads')
      thread = await (ch as any).threads.create({ name: name.slice(0, 100), autoArchiveDuration: archiveDuration })
    }

    let messageId: string | undefined
    if (opts?.text) {
      if (opts?.files?.length) {
        for (const f of opts.files) {
          const st = statSync(f)
          if (st.size > MAX_ATTACHMENT_BYTES) {
            throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`)
          }
        }
      }
      const sent = await thread.send({
        content: opts.text,
        ...(opts?.files?.length ? { files: opts.files } : {}),
      })
      this.noteSent(sent.id)
      messageId = sent.id
    }

    let url = ''
    try {
      if (thread.guildId) {
        url = `https://discord.com/channels/${thread.guildId}/${thread.id}`
      }
    } catch {}

    return { id: thread.id, url }
  }

  async downloadAttachments(channelId: string, messageId: string, inboxDir: string): Promise<DownloadedFile[]> {
    const ch = await this.fetchTextChannel(channelId)
    const msg = await ch.messages.fetch(messageId)
    if (msg.attachments.size === 0) return []

    const results: DownloadedFile[] = []
    for (const att of msg.attachments.values()) {
      if (att.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max 25MB`)
      }
      const res = await fetch(att.url)
      const buf = Buffer.from(await res.arrayBuffer())
      const name = att.name ?? `${att.id}`
      const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
      const path = `${inboxDir}/${Date.now()}-${att.id}.${ext}`
      mkdirSync(inboxDir, { recursive: true })
      writeFileSync(path, buf)
      results.push({
        path,
        name: (att.name ?? att.id).replace(/[\[\]\r\n;]/g, '_'),
        contentType: att.contentType ?? 'unknown',
        sizeKB: (att.size / 1024).toFixed(0),
      })
    }
    return results
  }

  async sendDM(userId: string, text: string, buttons?: ButtonDef[]): Promise<void> {
    const user = await this.client.users.fetch(userId)
    const payload: Record<string, unknown> = { content: text }
    if (buttons?.length) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...buttons.map(b => {
          const btn = new ButtonBuilder()
            .setCustomId(b.id)
            .setLabel(b.label)
            .setStyle(
              b.style === 'success' ? ButtonStyle.Success :
              b.style === 'danger' ? ButtonStyle.Danger :
              ButtonStyle.Secondary,
            )
          if (b.emoji) btn.setEmoji({ name: b.emoji })
          return btn
        }),
      )
      payload.components = [row]
    }
    await user.send(payload)
  }

  async isMentioned(msg: InboundMessage, extraPatterns?: string[]): Promise<boolean> {
    // Check @mention of bot
    const ch = await this.fetchTextChannel(msg.channelId)
    const discordMsg = await ch.messages.fetch(msg.id)
    if (this.client.user && discordMsg.mentions.has(this.client.user)) return true

    // Check reply-to one of our messages
    if (msg.referenceMessageId) {
      if (this.recentSentIds.has(msg.referenceMessageId)) return true
      try {
        const ref = await discordMsg.fetchReference()
        if (ref.author.id === this.client.user?.id) return true
      } catch {}
    }

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

  async getThreadUrl(threadId: string): Promise<string> {
    try {
      const ch = await this.client.channels.fetch(threadId)
      if (ch && 'guildId' in ch && (ch as any).guildId) {
        return `https://discord.com/channels/${(ch as any).guildId}/${threadId}`
      }
    } catch {}
    return ''
  }

  getThreadAnchor(_threadId: string): { channelId: string; messageId: string } | null {
    return null
  }

  getMessageUrl(_threadId: string, _messageTs: string): string {
    return ''
  }

  /** Start a thread on a message in a guild channel (for threadReply policy). */
  async startThreadOnMessage(msg: InboundMessage, preview: string, archiveDuration: number): Promise<string | null> {
    const ch = await this.fetchTextChannel(msg.channelId)
    const discordMsg = await ch.messages.fetch(msg.id)

    if (discordMsg.hasThread && discordMsg.thread) {
      return discordMsg.thread.id
    }

    try {
      const thread = await discordMsg.startThread({
        name: preview.slice(0, 100),
        autoArchiveDuration: archiveDuration,
      })
      return thread.id
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`discord gateway: startThread failed: ${errMsg}\n`)
      try {
        const refetched = await ch.messages.fetch(msg.id)
        if (refetched.hasThread && refetched.thread) {
          return refetched.thread.id
        }
      } catch {}
    }
    return null
  }

  /** Fetch thread starter message content (for thread context). */
  async getThreadStarterInfo(channelId: string): Promise<{
    threadName: string
    starterUser: string
    starterContent: string
    starterId: string
  } | null> {
    try {
      const ch = await this.client.channels.fetch(channelId)
      if (!ch || !ch.isThread()) return null
      const starter = await ch.fetchStarterMessage()
      if (!starter) return null
      return {
        threadName: ch.name,
        starterUser: starter.author.username,
        starterContent: starter.content.slice(0, 500),
        starterId: starter.id,
      }
    } catch {
      return null
    }
  }

  private async fetchTextChannel(id: string) {
    const ch = await this.client.channels.fetch(id)
    if (!ch || !ch.isTextBased()) {
      throw new Error(`channel ${id} not found or not text-based`)
    }
    return ch
  }

  private normalizeMessage(msg: Message): InboundMessage {
    const atts: AttachmentInfo[] = [...msg.attachments.values()].map(att => ({
      id: att.id,
      name: (att.name ?? att.id).replace(/[\[\]\r\n;]/g, '_'),
      contentType: att.contentType ?? null,
      size: att.size,
      url: att.url,
    }))

    return {
      id: msg.id,
      channelId: msg.channelId,
      authorId: msg.author.id,
      authorUsername: msg.author.username,
      content: msg.content,
      isDM: msg.channel.type === ChannelType.DM || msg.channel.isDMBased(),
      isThread: msg.channel.isThread(),
      isBot: msg.author.bot,
      parentChannelId: msg.channel.isThread() ? (msg.channel.parentId ?? null) : null,
      hasExistingThread: msg.hasThread,
      existingThreadId: msg.thread?.id ?? null,
      referenceMessageId: msg.reference?.messageId ?? null,
      attachments: atts,
      createdAt: msg.createdAt,
    }
  }
}
