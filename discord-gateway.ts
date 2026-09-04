/**
 * Discord gateway implementation.
 *
 * Wraps discord.js and implements the ChatGateway interface.
 */

import {
  Client,
  Events,
  Status,
  GatewayIntentBits,
  Partials,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type Message,
} from 'discord.js'
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { sanitizeFilename, COUNT_EMOJI, SUPERSCRIPT } from './gateway.js'
import { GatewayHealth } from './daemon/gateway-health.js'
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
  ReactionEvent,
  SessionVisualOpts,
} from './gateway.js'
import { ThrottledQueue } from './throttled-queue.js'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const RECENT_SENT_CAP = 200
const HEARTBEAT_TICK_MS = 30_000

// ---------------------------------------------------------------------------
// Visual grammar — the thread name IS the spec.
//
// Position 1 (leftmost):  presence indicator — identity, protocol, or state override
// Position 2 (middle):    focus — what the session is working on
// Position 3 (after · ):  identity tag — tmux name (used in commands)
// Position 4 (suffix):    lineage — respawn count as superscript
//
// Precedence for position 1 (highest wins):
//   1. Dead/crashed: › ☠️ / › 💥         (session is gone — everything else is moot)
//   2. Paused:       › ⏸                  (alive but not listening)
//   3. Protocol:     {emoji}{badge}        (identity + protocol as compound: 🔣⚔²⁄³)
//   4. Identity:     session emoji         (default — alive and idle)
// Turn archetypes: ✦ = self/owner/builder, ⚔ = critic/outsider/challenger
// ---------------------------------------------------------------------------

export function formatThreadName(opts: SessionVisualOpts): { name: string; priority: 'high' | 'normal' } {
  const dead = opts.state === 'killed' || opts.state === 'crashed'
  const paused = !!opts.paused && !dead
  const isStateOverride = dead || paused

  // Position 1 — presence indicator (precedence: dead > paused > identity • protocol > identity)
  let position1: string
  if (dead) {
    position1 = opts.state === 'killed' ? '› ☠️' : '› 💥'
  } else if (paused) {
    position1 = '› ⏸'
  } else if (opts.badge) {
    position1 = `${opts.emoji} ${opts.badge}`
  } else {
    position1 = opts.emoji
  }

  // Position 2 — focus (description > topic > session name)
  const title = (opts.description || opts.topic || opts.sessionName)
    .replace(/\*\*/g, '').replace(/\*/g, '').replace(/[\[\]<>]/g, '').replace(/\s+/g, ' ').trim()

  // Position 4 — lineage suffix
  const countSuffix = opts.respawnCount && opts.respawnCount >= 2
    ? (opts.respawnCount <= 9 ? SUPERSCRIPT[opts.respawnCount] : '⁹⁺')
    : ''

  const name = `${position1} ${title} · ${opts.sessionName}${countSuffix}`.slice(0, 100)
  return { name, priority: isStateOverride ? 'high' : 'normal' }
}

export class DiscordGateway implements ChatGateway {
  readonly platform = 'discord' as const
  readonly canThreadInDM = false
  readonly dmThreadsAreExclusive = false
  readonly healthCheckUrl = 'https://discord.com/api/v10/gateway'
  readonly maxMessageLength = 2000 // Discord API hard limit
  private client: Client
  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null
  private threadDeleteHandler: ((threadId: string) => void) | null = null
  private messageDeleteHandler: ((messageId: string, threadId: string | null) => void) | null = null
  private buttonClickHandler: ((click: ButtonClick) => void) | null = null
  private reactionHandler: ((event: ReactionEvent) => Promise<void>) | null = null
  private recentSentIds = new Set<string>()
  private readonly health: GatewayHealth
  private token: string | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  /** Fired after connectivity returns following an outage longer than the threshold. */
  onReconnectAfterOutage?: (gapMs: number) => void

  constructor(opts?: { heartbeatPath?: string | null }) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Reaction, Partials.Message],
    })
    this.health = new GatewayHealth({
      heartbeatPath: opts?.heartbeatPath ?? null,
      onOutageRecovered: gapMs => this.onReconnectAfterOutage?.(gapMs),
    })
  }

  get botId(): string | null {
    return this.client.user?.id ?? null
  }

  async start(token: string): Promise<void> {
    this.token = token

    this.client.on('messageCreate', msg => {
      this.health.markAlive()
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

    this.client.on('messageReactionAdd', async (reaction, user) => {
      if (!this.reactionHandler) return
      if (user.bot) return
      const msg = reaction.message
      this.reactionHandler({
        channelId: msg.channelId,
        messageId: msg.id,
        userId: user.id,
        emoji: reaction.emoji.name ?? '',
      }).catch(e => process.stderr.write(`discord gateway: reaction handler error: ${e}\n`))
    })

    this.client.on('error', err => {
      process.stderr.write(`discord gateway: client error: ${err}\n`)
    })

    // Connection lifecycle. discord.js owns reconnect/RESUME internally; we
    // translate the shard events it emits onto the gateway health contract.
    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      this.health.markDisconnected()
      process.stderr.write(`discord gateway: shard ${shardId} disconnected (code ${event?.code ?? '?'})\n`)
    })

    this.client.on(Events.ShardReconnecting, shardId => {
      process.stderr.write(`discord gateway: shard ${shardId} reconnecting\n`)
    })

    // Resume replays the events missed during the gap — nothing was lost, so no
    // recovery report.
    this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
      this.health.markReconnected({ resumed: true })
      process.stderr.write(`discord gateway: shard ${shardId} resumed (${replayedEvents} events replayed)\n`)
    })

    // A fresh identify means the session could not be resumed; events in the gap
    // were lost. The initial connect has no recorded disconnect, so it reports nothing.
    this.client.on(Events.ShardReady, shardId => {
      this.health.markReconnected({ resumed: false })
      process.stderr.write(`discord gateway: shard ${shardId} ready\n`)
    })

    // The session is dead and discord.js has stopped trying — the real give-up
    // boundary. Exit for the watchdog to cold-restart (mirrors Slack's exhaustion exit).
    this.client.on(Events.Invalidated, () => {
      process.stderr.write('discord gateway: session invalidated, exiting for supervisor restart\n')
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      process.exit(1)
    })

    await new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, c => {
        process.stderr.write(`discord gateway: connected as ${c.user.tag}\n`)
        resolve()
      })
      this.client.login(token).catch(err => {
        process.stderr.write(`discord gateway: login failed: ${err}\n`)
        process.exit(1)
      })
    })

    this.health.markAlive()
    this.startHeartbeatTicker()
  }

  // Connectivity-aware heartbeat: only refresh while the socket is actually Ready,
  // so a wedged transport goes stale and the watchdog restarts the daemon. This
  // replaces the blind interval that previously wrote the heartbeat unconditionally.
  private startHeartbeatTicker(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      if (this.client.ws.status === Status.Ready) this.health.markAlive()
    }, HEARTBEAT_TICK_MS)
  }

  async forceReconnect(): Promise<{ ok: boolean; message: string }> {
    if (!this.token) return { ok: false, message: 'gateway not started' }
    try {
      this.health.markDisconnected()
      await Promise.resolve(this.client.destroy())
      await this.client.login(this.token)
      return { ok: true, message: 'discord gateway reconnecting' }
    } catch (err) {
      return { ok: false, message: `reconnect failed: ${err}` }
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
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

  onReaction(handler: (event: ReactionEvent) => Promise<void>): void {
    this.reactionHandler = handler
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


  async deleteThread(threadId: string): Promise<void> {
    const channel = await this.client.channels.fetch(threadId)
    if (!channel) throw new Error('channel not found')
    if (!channel.isThread()) throw new Error('channel is not a thread')
    await channel.delete()
  }
  async delete(channelId: string, messageId: string): Promise<void> {
    const ch = await this.fetchTextChannel(channelId)
    const msg = await ch.messages.fetch(messageId)
    await msg.delete()
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const ch = await this.fetchTextChannel(channelId)
    const msg = await ch.messages.fetch(messageId)
    await msg.react(emoji)
  }

  async unreact(channelId: string, messageId: string, emoji: string): Promise<void> {
    const ch = await this.fetchTextChannel(channelId)
    const msg = await ch.messages.fetch(messageId)
    const botReaction = msg.reactions.cache.find(r => r.emoji.name === emoji)
    if (botReaction) await botReaction.users.remove(this.client.user!.id)
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
      const name = att.name || `${att.id}`
      const sanitizedName = sanitizeFilename(name, `${att.id}`)
      const path = `${inboxDir}/${Date.now()}-${sanitizedName}`
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

  // Sync by contract, so the guild comes from cache rather than a fetch.
  // Discord thread IDs *are* channel IDs, so threadId slots straight into the URL.
  //
  // An uncached channel yields '' rather than a guess: every caller falls back
  // to the thread URL on empty, and picking an arbitrary guild would hand them
  // a confidently wrong deep link instead — which they cannot detect. Matches
  // getThreadUrl above, which declines the same guess.
  getMessageUrl(threadId: string, messageId: string): string {
    if (!threadId || !messageId) return ''
    const cached = this.client.channels.cache.get(threadId)
    if (!cached) return ''
    // A DM channel has no guildId; its messages live under the /@me pseudo-guild.
    const guildId = 'guildId' in cached ? (cached as { guildId?: string | null }).guildId : null
    return `https://discord.com/channels/${guildId ?? '@me'}/${threadId}/${messageId}`
  }

  // Discord enforces a shared-scope rate limit on thread name changes
  // (x-ratelimit-scope: shared), separate from the per-route bucket (10/15s).
  // Under burst conditions, ~2 rapid renames trigger 429 + retry-after: ~600s.
  // In practice, natural gaps between review turns reduce the effective wait.
  // Scope (per-channel vs global to the bot) is unconfirmed empirically.
  // discord.js retries 429s internally. ThrottledQueue coalesces rapid updates
  // (latest value wins) and retries on non-429 failures (network, deleted thread).
  private renameQueue = new ThrottledQueue<string>(async (threadId, name) => {
    const ch = await this.client.channels.fetch(threadId)
    if (ch?.isThread()) await ch.setName(name.slice(0, 100))
  }, 1_000)

  private reactionQueue = new ThrottledQueue<{ channelId: string; emoji: string; countEmoji?: string }>(
    async (messageId, { channelId, emoji, countEmoji }) => {
      const ch = await this.client.channels.fetch(channelId)
      if (!ch?.isTextBased() || !('messages' in ch)) return
      const msg = await (ch as any).messages.fetch(messageId)
      if (!msg) return
      const removePromises = [...(msg.reactions?.cache?.values() ?? [])].map(
        (r: any) => r.users.remove(this.client.user?.id).catch((e: unknown) => process.stderr.write(`discord gateway: reaction remove failed: ${e}\n`))
      )
      await Promise.allSettled(removePromises)
      await msg.react(emoji).catch((e: unknown) => process.stderr.write(`discord gateway: react failed: ${e}\n`))
      if (countEmoji) await msg.react(countEmoji).catch((e: unknown) => process.stderr.write(`discord gateway: react countEmoji failed: ${e}\n`))
    }, 500,
  )

  async renameThread(threadId: string, name: string, priority: 'high' | 'normal' = 'normal'): Promise<void> {
    this.renameQueue.enqueue(threadId, name, priority)
  }

  private static readonly COUNT_EMOJI = COUNT_EMOJI

  async updateSessionVisual(threadId: string, opts: SessionVisualOpts): Promise<void> {
    const { name, priority } = formatThreadName(opts)
    process.stderr.write(`discord gateway: visual update: state=${opts.state} paused=${opts.paused} priority=${priority}\n`)
    await this.renameThread(threadId, name, priority)

    if (!opts.anchorMessageId) {
      process.stderr.write(`discord gateway: no anchorMessageId for thread ${threadId} — skipping anchor reactions\n`)
    }
    if (opts.anchorChannelId && opts.anchorMessageId) {
      const dead = opts.state === 'killed' || opts.state === 'crashed'
      const emoji = dead ? (opts.state === 'killed' ? '☠️' : '💥') : opts.emoji
      const countEmoji = opts.state === 'zombie' && opts.respawnCount && opts.respawnCount > 0
        ? DiscordGateway.COUNT_EMOJI[Math.min(opts.respawnCount - 1, DiscordGateway.COUNT_EMOJI.length - 1)]
        : undefined
      this.reactionQueue.enqueue(opts.anchorMessageId, {
        channelId: opts.anchorChannelId, emoji, countEmoji,
      }, priority)
    }
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
      effectiveThreadId: msg.channel.isThread() ? msg.channelId : (msg.thread?.id ?? null),
      attachments: atts,
      createdAt: msg.createdAt,
    }
  }
}
