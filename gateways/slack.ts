/**
 * Slack gateway implementation.
 *
 * Uses @slack/bolt in Socket Mode to maintain a persistent WebSocket connection,
 * similar to Discord's gateway model.
 */

import { App, webApi, type types } from '@slack/bolt'
import { readFileSync, writeFileSync } from 'fs'
import { discardInboxFiles, writeInboxFile } from '../infra/confined-inbox.js'
import { customEmojiId } from '../shared/slack-lines.js'
import type { InboxLimits } from '../config/write-confinement.js'
import { SocketSupervisor, type SocketEmitter } from '../shared/socket-supervisor.js'
import { ThrottledQueue } from '../throttled-queue.js'
import { HOME_STATUS_ACTION_PREFIX, MAX_ATTACHMENT_BYTES } from '../shared/constants.js'
import { buildSocketApp, messageBody, parseAuth, unfurlFields, uploadFile } from '../shared/slack-client.js'
import { parseHomeStatusClick } from '../infra/home-status.js'
import { linkPreviewsOff } from '../shared/link-previews.js'
import { gatewayProfile } from '../shared/gateways/index.js'
import { archiveUrl } from '../shared/slack-conversation.js'
import { SlackEventDedupe } from './slack-event-dedupe.js'
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
  HomeTabBlock,
} from './gateway.js'

const RECENT_SENT_CAP = 200


/**
 * Slack renders FULL Markdown — tables, `-`/`*` lists, headings, code fences — only via the
 * `markdown_text` field (`messageBody`, shared/slack-client.ts, the one rule the Slack connector's replies and edits follow too). It can't be combined with `blocks`/`text` and caps at ~12k chars.
 * So: plain replies go through `markdown_text` (rich); button messages must use Block Kit (which
 * only does classic mrkdwn); anything past the cap falls back to classic mrkdwn `text`.
 *
 * We deliberately do NOT impose a house style here — presentation taste belongs to each bot's own
 * instructions/CLAUDE.md. This layer's only job is to make the full Markdown palette render reliably.
 */
function applyMessageBody(payload: Record<string, unknown>, text: string, hasButtons: boolean): void {
  Object.assign(payload, messageBody(text, hasButtons))
}

/** The text a chat.postMessage payload shows, for counting its links: `text`, `markdown_text`, and every `text` inside its blocks. */
function slackPostText(payload: Record<string, unknown>): string {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'text' && typeof x === 'string') out.push(x); else walk(x) }
  }
  for (const k of ['text', 'markdown_text'] as const) if (typeof payload[k] === 'string') out.push(payload[k] as string)
  walk(payload.blocks)
  return out.join('\n')
}

/**
 * Slack has no `-#`; its small grey text is a context block, which reads classic mrkdwn only.
 * Markdown links to web URLs become `<url|label>`; everything else is escaped so `<!channel>` and the like stay inert.
 */
export function slackSubtextBlocks(text: string): Array<Record<string, unknown>> {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const link = /\[([^\]]+)\]\(<?(https?:\/\/[^)\s>|]+)>?\)/g
  let out = ''
  let last = 0
  for (const m of text.matchAll(link)) {
    out += escape(text.slice(last, m.index)) + `<${m[2]}|${escape(m[1])}>`
    last = m.index! + m[0].length
  }
  out += escape(text.slice(last))
  return [{ type: 'context', elements: [{ type: 'mrkdwn', text: out }] }]
}

const SLACK_TITLE_MAX = 200
const SLACK_TITLE_UNSAFE = /[^\p{L}\p{M}\p{Nd} .,()'!?&_=|-]/gu
const SLACK_VISUAL_DRAIN_MS = 2_500
const SLACK_VISUAL_TIMEOUT_MS = 10_000
const SLACK_VISUALS_UNAVAILABLE = new Set(['missing_scope', 'feature_disabled'])

export function slackSessionStatus(state: SessionVisualOpts['state']): 'active' | 'suspended' | 'closed' {
  return state === 'killed' ? 'closed' : state === 'crashed' ? 'suspended' : 'active'
}

/** Slack's title validator rejects characters it never documents, so callers try each title until one is accepted. */
export function slackSessionTitles(opts: SessionVisualOpts): string[] {
  const cap = (s: string) => {
    let out = ''
    for (const ch of s) {
      if (out.length + ch.length > SLACK_TITLE_MAX) break
      out += ch
    }
    return out.trim()
  }
  const clean = (s = '') => cap(s.normalize('NFC').replace(SLACK_TITLE_UNSAFE, ' ').replace(/\s+/g, ' ').trim())
  const dead = opts.state === 'killed' || opts.state === 'crashed'
  const icon = opts.state === 'killed' ? '☠️' : opts.state === 'crashed' ? '💥' : opts.emoji
  const name = clean(opts.sessionName)
  const focus = clean(opts.description || opts.topic)
  const text = cap((focus ? `${name} - ${focus}` : name) + (opts.paused && !dead ? ' (paused)' : ''))
  return [...new Set([cap(`${icon} ${text}`), text, name])].filter(Boolean)
}

type SlackError = { data?: { error?: unknown } }
function slackErrorCode(err: unknown): string | undefined {
  const code = (err as SlackError | null)?.data?.error
  return typeof code === 'string' ? code : undefined
}

type AppWithReceiver = { receiver?: { client?: SocketEmitter } }
function socketEmitterOf(app: App | null): SocketEmitter | null {
  return (app as AppWithReceiver | null)?.receiver?.client ?? null
}

/** A Slack conversation is a channel id (C, D or G), alone or with a thread's ts: `C0B6KKFNH4N:1779979488.572029`. */
export function isSlackThreadId(id: string): boolean {
  return /^[CDG][A-Z0-9]+(:\d+\.\d+)?$/.test(id)
}

export class SlackGateway implements ChatGateway {
  readonly platform = 'slack' as const
  readonly canThreadInDM = true
  readonly dmThreadsAreExclusive = true
  readonly postsReactions = gatewayProfile('slack').postsReactions // a bot's reaction pushes a notification; reactions people post are heard regardless
  readonly healthCheckUrl = 'https://slack.com/api/api.test'
  readonly maxMessageLength = 4000 // block-kit section text limit
  readonly maxAttachments = 10 // what the daemon has always capped a message at
  private app: App | null = null
  private _botId: string | null = null
  private _botUserId: string | null = null
  private _teamId: string | null = null
  private _teamDomain: string | null = null
  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null
  private threadDeleteHandler: ((threadId: string) => void) | null = null
  private messageDeleteHandler: ((messageId: string, threadId: string | null) => void) | null = null
  private buttonClickHandler: ((click: ButtonClick) => void) | null = null
  private reactionHandler: ((event: ReactionEvent) => Promise<void>) | null = null
  private recentSentIds = new Set<string>()
  /** A tag in a channel the bot is in arrives as `message` and as `app_mention`: one is delivered. */
  private eventDedupe = new SlackEventDedupe()
  private visualApi: webApi.WebClient | null = null
  private visualsUnavailable = false
  private appliedVisuals = new Map<string, string>()
  private visualQueue = new ThrottledQueue<SessionVisualOpts>((threadId, opts) => this.applySessionVisual(threadId, opts), SLACK_VISUAL_DRAIN_MS)
  // Serial rate limiter for chat.postMessage and chat.update (Slack Tier 4: ~50/min).
  // A promise chain ensures at most one outbound send per SEND_RATE_MS, preventing 429s
  // when many sessions post simultaneously.
  private _sendChain = Promise.resolve()
  private _lastSendAt = 0
  private static readonly SEND_RATE_MS = 1200 // 50 msg/min → 1.2s between calls
  private appToken: string
  private token: string | null = null
  private heartbeatPath: string | null = null
  private readonly sup: SocketSupervisor
  onReconnectAfterOutage: ((gapMs: number) => void) | undefined = undefined
  // Set by the daemon; no operators until then.
  operators: () => string[] = () => []
  homeTabHandler: ((userId: string) => Promise<void>) | null = null
  homeSpawnHandler: ((topic: string, userId: string) => Promise<void>) | null = null
  homeStatusHandler: ((sessionId: string, shown: string) => Promise<void>) | null = null

  async forceReconnect(): Promise<{ ok: boolean; message: string }> {
    return this.sup.forceReconnect()
  }

  constructor(appToken: string, opts?: { heartbeatPath?: string; staleThresholdMs?: number }) {
    this.appToken = appToken
    this.heartbeatPath = opts?.heartbeatPath ?? null
    // Keeping the connection alive is the supervisor's job (shared with the Slack connector).
    // What to do when it cannot is the gateway's call: exit, so the watchdog restarts the daemon.
    this.sup = new SocketSupervisor({
      name: 'slack gateway',
      start: () => this.start(this.token!),
      emitter: () => socketEmitterOf(this.app),
      healthUrl: this.healthCheckUrl,
      staleThresholdMs: opts?.staleThresholdMs,
      writeHeartbeat: () => this.writeHeartbeat(),
      onGap: gapMs => this.onReconnectAfterOutage?.(gapMs),
      onExhausted: () => {
        process.stderr.write('slack gateway: exiting for supervisor restart\n')
        process.exit(1)
      },
    })
  }

  get botId(): string | null {
    return this._botUserId
  }

  isConnected(): boolean {
    return this.sup.state.connected
  }

  async start(token: string): Promise<void> {
    this.token = token
    if (this.app) {
      try { await this.app.stop() } catch {}
      this.app = null
    }

    // Don't log to stdout — we write to stderr like the Discord gateway
    this.app = buildSocketApp({ appToken: this.appToken, botToken: token }).app
    this.visualApi = new webApi.WebClient(token, {
      logLevel: webApi.LogLevel.ERROR,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: SLACK_VISUAL_TIMEOUT_MS,
    })

    // Handle all messages
    this.app.message(async ({ message, client }) => {
      this.touchHeartbeat()
      if (!this.messageHandler) return
      // Skip bot messages
      if (message.subtype === 'bot_message') return
      if (!('user' in message) || !message.user) return

      const msg = message as types.GenericMessageEvent
      // The same message may also arrive as an app_mention; the one delivered is this one, which carries the files.
      if (!this.eventDedupe.claimMessage(SlackEventDedupe.key(msg.channel, msg.ts))) return

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

    // Publish Home tab when user opens it
    this.app.event('app_home_opened', async ({ event }) => {
      this.touchHeartbeat()
      if (!this.operators().includes(event.user)) return
      if (this.homeTabHandler) {
        this.homeTabHandler(event.user).catch((e: Error) =>
          process.stderr.write(`slack gateway: app_home_opened handler error: ${e}\n`),
        )
      }
    })

    this.app.action(new RegExp(`^${HOME_STATUS_ACTION_PREFIX}`), async ({ action, body, ack }) => {
      this.touchHeartbeat()
      await ack()
      const value = 'value' in action && typeof action.value === 'string' ? action.value : undefined
      const actionId = 'action_id' in action ? String(action.action_id) : ''
      const userId = 'user' in body && body.user && typeof body.user.id === 'string' ? body.user.id : undefined
      if (!value || !this.homeStatusHandler) return
      const click = parseHomeStatusClick(actionId, value, userId, this.operators())
      if (!click) {
        process.stderr.write(`slack gateway: home status action rejected for user ${userId ?? '(none)'}\n`)
        return
      }
      this.homeStatusHandler(click.sessionId, click.shown).catch((e: Error) =>
        process.stderr.write(`slack gateway: home status handler error: ${e}\n`),
      )
    })
    // Home tab: spawn session on Enter in the text input
    this.app.action('home:spawn', async ({ action, body, ack }) => {
      this.touchHeartbeat()
      await ack()
      const userId = 'user' in body && body.user && typeof body.user.id === 'string' ? body.user.id : undefined
      if (!userId) return
      if (!this.operators().includes(userId)) {
        process.stderr.write(`slack gateway: home:spawn rejected — user ${userId} is not the operator\n`)
        return
      }
      const rawValue = 'value' in action && typeof action.value === 'string' ? action.value : ''
      const topic = rawValue.trim().slice(0, 500)
      if (!topic || !this.homeSpawnHandler) return
      this.homeSpawnHandler(topic, userId).catch((e: Error) =>
        process.stderr.write(`slack gateway: home:spawn handler error: ${e}\n`),
      )
    })



    // Handle reaction_added for :hocho: message deletion
    this.app.event('reaction_added', async ({ event }) => {
      this.touchHeartbeat()
      process.stderr.write(`slack gateway: reaction_added: emoji=${event.reaction} user=${event.user} item=${JSON.stringify(event.item)}\n`)
      if (!this.reactionHandler) return
      if (event.item.type !== 'message') return
      if (event.user === this._botUserId) return
      this.reactionHandler({
        channelId: event.item.channel,
        messageId: event.item.ts,
        userId: event.user,
        emoji: event.reaction,
        // A Slack thread reply lives in its parent's channel.
        isDM: gatewayProfile('slack').isDmId(event.item.channel),
        parentChannelId: null,
      }).catch(e =>
        process.stderr.write(`slack gateway: reaction handler error: ${e}\n`),
      )
    })

    // Handle app_mention events: the one event for a tag where the bot is not in the channel; where it is, the `message` copy is delivered instead
    this.app.event('app_mention', async ({ event, client }) => {
      this.touchHeartbeat()
      if (!this.messageHandler) return
      // Where the bot is in the channel the `message` copy follows (with files): the mention waits for it, and is delivered alone only if none comes.
      this.eventDedupe.holdMention(SlackEventDedupe.key(event.channel, event.ts), () => void this.deliverMention(event, client))
    })

    // Handle button interactions (Block Kit actions)
    this.app.action(/^perm:/, async ({ action, body, ack, respond }) => {
      this.touchHeartbeat()
      await ack()
      if (!this.buttonClickHandler) return
      if (body.type !== 'block_actions') return

      const actionId = 'action_id' in action ? String(action.action_id) : ''
      const userId = body.user.id
      const messageText = body.message?.text ?? ''

      this.buttonClickHandler({
        userId,
        customId: actionId,
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

    // Judge liveness by the socket's own connection lifecycle, not business-event
    // recency. (ws_message fires only on Slack data frames, never on the ws-level
    // ping/pong keepalive — so staleness must NOT key off ws_message recency.)
    // Must be attached before start() so the initial 'connected' is observed.
    this.sup.attach()

    await this.app.start()
    // The supervisor's connected/downSince are set by its generation-guarded
    // 'connected' listener, which has already fired by the time start() resolves
    // (Bolt resolves start() on the Connected event). Don't set them unguarded
    // here — a raced/orphaned start() could otherwise stomp a dead socket as
    // connected and blind both watchdogs.

    // Get bot identity
    try {
      const auth = await this.app.client.auth.test({ token })
      const who = parseAuth(auth)
      this._botId = who.botId ?? null
      this._botUserId = who.userId ?? null
      this._teamId = auth.team_id ?? null
      const url = who.url
      if (url) {
        try { this._teamDomain = new URL(url).hostname.split('.')[0] } catch {}
      }
      process.stderr.write(`slack gateway: connected as ${auth.user} (bot_id: ${this._botId}, team: ${this._teamId}, domain: ${this._teamDomain})\n`)
    } catch (err) {
      process.stderr.write(`slack gateway: auth.test failed: ${err}\n`)
    }

    this.touchHeartbeat()
    this.sup.begin()
  }

  async stop(): Promise<void> {
    this.eventDedupe.clear()
    this.sup.stop()
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

  onReaction(handler: (event: ReactionEvent) => Promise<void>): void {
    this.reactionHandler = handler
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
    subtext?: boolean
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

    // Render full Markdown via markdown_text; buttons, subtext and mrkdwn opt-in force the classic text path.
    if (opts?.subtext) {
      payload.text = text
      payload.blocks = slackSubtextBlocks(text)
    } else if (opts?.mrkdwn) {
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
          await uploadFile(this.app.client, parsed.channel, opts?.replyTo ?? parsed.threadTs, readFileSync(filePath), filePath.split('/').pop() ?? 'file')
        } catch (err) {
          process.stderr.write(`slack gateway: file upload failed for ${filePath}: ${err}\n`)
        }
      }
    }

    // The caller asked, the line is hydra's own subtext (a link in it only previews an old message: noise), or the place says so (`[places]` `link_previews = false`).
    Object.assign(payload, unfurlFields(opts?.unfurl === false || !!opts?.subtext))

    const result = await this.throttledSend(() => this.postMessage(payload))
    const sentId = result.ts!
    this.noteSent(sentId)
    return { id: sentId, channelId }
  }

  async edit(channelId: string, messageId: string, text: string): Promise<string> {
    if (!this.app) throw new Error('not connected')
    const { channel } = this.parseChannelId(channelId)
    const payload: Record<string, unknown> = { channel, ts: messageId }
    applyMessageBody(payload, text, false)
    const result = await this.throttledSend(() => this.app!.client.chat.update(payload as unknown as webApi.ChatUpdateArguments))
    return result.ts!
  }

  /**
   * The one place this gateway posts a message to Slack (every send, thread anchor, first reply and DM goes through it): a place that sets
   * `link_previews = false` gets `unfurl_links` and `unfurl_media` false, and so does a post with 2+ links to one that sets `"single"`.
   * `chat.update` takes no such argument, so an edit is not covered.
   */
  private postMessage(payload: Record<string, unknown>) {
    // No `app`: the gateway's bot is its own Slack app, never one of hydra.toml's `[slack.apps]` (the loader refuses one app on both), so a DM it sends is `slack:app-dm:*` and no `slack:app-dm:<app>`.
    if (typeof payload.channel === 'string') Object.assign(payload, unfurlFields(linkPreviewsOff('slack', [payload.channel], {}, slackPostText(payload))))
    return this.app!.client.chat.postMessage(payload as unknown as webApi.ChatPostMessageArguments)
  }

  /** Rate-limit chat.postMessage and chat.update to ~50/min (Slack Tier 4). */
  private throttledSend<T>(fn: () => Promise<T>): Promise<T> {
    const p = this._sendChain.then(async () => {
      const rateMs = (this as { _sendRateMs?: number })._sendRateMs ?? SlackGateway.SEND_RATE_MS
      const wait = Math.max(0, this._lastSendAt + rateMs - Date.now())
      if (wait > 0) await new Promise<void>(r => setTimeout(r, wait))
      this._lastSendAt = Date.now()
      return fn()
    })
    // Advance the chain regardless of outcome so subsequent calls always proceed.
    this._sendChain = p.then(() => {}, () => {})
    return p
  }

  async delete(channelId: string, messageId: string): Promise<void> {
    if (!this.app) throw new Error('not connected')
    const { channel } = this.parseChannelId(channelId)
    await this.app.client.chat.delete({ channel, ts: messageId })
  }

  async react(_channelId: string, _messageId: string, _emoji: string): Promise<void> {
    // no-op: bot reactions trigger push notifications on Slack
    // NOTE: re-enable with unreact and `postsReactions = true`
  }

  async unreact(_channelId: string, _messageId: string, _emoji: string): Promise<void> {
    // no-op: bot reactions trigger push notifications on Slack
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
      name: ch.name ?? undefined,
      isDM,
      isThread: !!parsed.threadTs,
      parentId: parsed.threadTs ? parsed.channel : null,
      recipientId: isDM && 'user' in ch && typeof ch.user === 'string' ? ch.user : '',
      sendable: true,
    }
  }

  isThreadId(id: string): boolean {
    return isSlackThreadId(id)
  }

  /** A custom emoji in Discord's form is one Discord server's: Slack shows it as the raw `<:name:id>`. */
  canRenderEmoji(emoji: string): boolean {
    return customEmojiId(emoji) === undefined
  }

  async threadExists(threadId: string): Promise<boolean> {
    if (!this.isThreadId(threadId)) return false
    if (!this.app) return true
    const { channel, threadTs } = this.parseChannelId(threadId)
    try {
      if (threadTs) await this.app.client.conversations.replies({ channel, ts: threadTs, limit: 1 })
      else await this.app.client.conversations.info({ channel })
      return true
    } catch (err) {
      const code = (err as { data?: { error?: unknown } })?.data?.error
      return !(code === 'thread_not_found' || code === 'channel_not_found')
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
      const anchor = await this.postMessage({
        channel,
        text: `*${name}*`,
      })
      threadTs = anchor.ts!
      this.noteSent(threadTs)
    }

    let messageId: string | undefined
    if (opts?.text) {
      const reply = await this.postMessage({
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
          await uploadFile(this.app.client, channel, threadTs, readFileSync(filePath), filePath.split('/').pop() ?? 'file')
        } catch (err) {
          process.stderr.write(`slack gateway: thread file upload failed: ${err}\n`)
        }
      }
    }

    const url = this.buildMessageUrl(channel, threadTs, threadTs)
    // In Slack, the "thread ID" is the parent message timestamp
    // We encode it as channel:threadTs for the daemon to use
    return { id: `${channel}:${threadTs}`, url }
  }

  async downloadAttachments(channelId: string, messageId: string, inboxDir: string, limits?: InboxLimits): Promise<DownloadedFile[]> {
    if (!this.app) throw new Error('not connected')
    const { channel, threadTs } = this.parseChannelId(channelId)

    const window = { oldest: messageId, latest: messageId, inclusive: true }
    const result = threadTs
      ? await this.app.client.conversations.replies({ channel, ts: threadTs, ...window })
      : await this.app.client.conversations.history({ channel, ...window })
    const msg = result.messages?.find(m => m.ts === messageId)
    if (!msg) throw new Error(`message ${messageId} not found in ${channelId}`)
    if (!msg.files?.length) return []

    const results: DownloadedFile[] = []
    try {
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

        const path = writeInboxFile(inboxDir, file.name || `${file.id}`, buf, limits)

        results.push({
          path,
          name: (file.name ?? file.id ?? 'unknown').replace(/[\[\]\r\n;]/g, '_'),
          contentType: file.mimetype ?? 'unknown',
          sizeKB: (size / 1024).toFixed(0),
        })
      }
    } catch (err) {
      // A confined session's inbox is its own folder: files this call already saved are not left behind for a message that says none were.
      if (limits) discardInboxFiles(results.map(r => r.path))
      throw err
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

    await this.postMessage(payload)
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

  // Every Slack thread reply carries the thread root as its referenceMessageId, and a root we posted is noted as sent: no reply here points at one message.
  isReplyToUs(_msg: InboundMessage): boolean {
    return false
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

  getMessageAppLink(threadId: string, messageTs: string): string {
    const anchor = this.getThreadAnchor(threadId)
    if (!anchor || !this._teamId) return ''
    return `slack://channel?team=${this._teamId}&id=${anchor.channelId}&message=${messageTs}&thread_ts=${anchor.messageId}`
  }

  // Uses Slack's `latest_reply` — may diverge from routed messages in multi-user threads
  async getLastReplyId(threadId: string): Promise<string | null> {
    if (!this.app) return null
    const anchor = this.getThreadAnchor(threadId)
    if (!anchor) return null
    try {
      const result = await this.app.client.conversations.replies({
        channel: anchor.channelId,
        ts: anchor.messageId,
        limit: 1,
        inclusive: true,
      })
      const parent = result.messages?.[0]
      return parent?.latest_reply ?? null
    } catch { return null }
  }

  async getThreadUrl(threadId: string): Promise<string> {
    const anchor = this.getThreadAnchor(threadId)
    if (!anchor) return ''
    return this.buildMessageUrl(anchor.channelId, anchor.messageId, anchor.messageId)
  }

  /** Start a thread on a message (for threadReply policy). In Slack this just means replying in-thread. */
  async startThreadOnMessage(msg: InboundMessage, _preview: string, _archiveDuration: number): Promise<string | null> {
    // In Slack, a "thread" is just a message with thread_ts = parent ts.
    // The "thread ID" is the parent message ts within the channel.
    // We return channelId:ts as composite ID for the daemon.
    return `${msg.channelId}:${msg.id}`
  }

  async updateSessionVisual(threadId: string, opts: SessionVisualOpts): Promise<void> {
    if (this.visualsUnavailable || !this.getThreadAnchor(threadId)) return
    const urgent = opts.state === 'killed' || opts.state === 'crashed' || !!opts.paused
    this.visualQueue.enqueue(threadId, opts, urgent ? 'high' : 'normal')
  }

  private async applySessionVisual(threadId: string, opts: SessionVisualOpts): Promise<void> {
    const anchor = this.getThreadAnchor(threadId)
    if (!this.visualApi || !anchor || this.visualsUnavailable) return
    const status = slackSessionStatus(opts.state)
    const titles = slackSessionTitles(opts)
    const applied = `${status} ${titles[0]}`
    if (this.appliedVisuals.get(threadId) === applied) return
    const session = { channel_id: anchor.channelId, thread_ts: anchor.messageId }
    this.appliedVisuals.delete(threadId)

    try {
      await this.visualApi.apiCall('agents.sessions.setStatus', { ...session, status })
    } catch (e: unknown) {
      const code = slackErrorCode(e)
      if (!code || !SLACK_VISUALS_UNAVAILABLE.has(code)) throw e
      this.visualsUnavailable = true
      process.stderr.write(`slack gateway: session titles off (${code}): the app needs the Agents feature and assistant:write\n`)
      return
    }
    for (const title of titles) {
      try {
        await this.visualApi.apiCall('agents.sessions.rename', { ...session, title })
        this.appliedVisuals.set(threadId, applied)
        return
      } catch (e: unknown) {
        if (slackErrorCode(e) !== 'invalid_name') throw e
      }
    }
    process.stderr.write(`slack gateway: slack rejected every session title for ${threadId}\n`)
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

  // --- Heartbeat ---

  private touchHeartbeat(): void {
    this.sup.touch()
  }

  private writeHeartbeat(): void {
    if (!this.heartbeatPath) return
    try {
      writeFileSync(this.heartbeatPath, String(Date.now()) + '\n')
    } catch {}
  }

  async publishHomeTab(userId: string, blocks: HomeTabBlock[]): Promise<void> {
    if (!this.visualApi) throw new Error('not connected')
    await this.visualApi.views.publish({
      user_id: userId,
      view: {
        type: 'home',
        blocks,
      },
    })
  }

  async openDMChannel(userId: string): Promise<string | null> {
    const ch = await this.app?.client?.conversations?.open({ users: userId })
    return ch?.channel?.id ?? null
  }

  /** An app_mention as an InboundMessage (it has no files, and no thread of its own), delivered to the daemon. */
  private async deliverMention(event: { ts: string; channel: string; user?: string; text?: string; thread_ts?: string; bot_id?: string }, client: webApi.WebClient): Promise<void> {
    const handler = this.messageHandler
    if (!handler) return
    const user = event.user ?? ''
    let username = user
    try {
      const userInfo = await client.users.info({ user })
      username = userInfo.user?.profile?.display_name || userInfo.user?.real_name || userInfo.user?.name || user
    } catch {}
    const isThread = !!event.thread_ts && event.thread_ts !== event.ts
    const threadId = isThread ? `${event.channel}:${event.thread_ts}` : null
    const normalized: InboundMessage = {
      id: event.ts,
      channelId: event.channel,
      authorId: user,
      authorUsername: username,
      content: event.text ?? '',
      isDM: false,
      isThread,
      isBot: !!event.bot_id,
      parentChannelId: event.thread_ts ? event.channel : null,
      hasExistingThread: false,
      existingThreadId: threadId,
      referenceMessageId: event.thread_ts ?? null,
      effectiveThreadId: threadId,
      attachments: [],
      createdAt: new Date(parseFloat(event.ts) * 1000),
    }
    handler(normalized).catch(e =>
      process.stderr.write(`slack gateway: app_mention handler error: ${e}\n`),
    )
  }

  // --- Internal helpers ---

  private async normalizeMessage(msg: types.GenericMessageEvent, username: string, client: webApi.WebClient): Promise<InboundMessage> {
    const atts: AttachmentInfo[] = (msg.files ?? []).map(f => ({
      id: f.id ?? f.name ?? 'unknown',
      name: (f.name ?? f.id ?? 'unknown').replace(/[\[\]\r\n;]/g, '_'),
      contentType: f.mimetype ?? null,
      size: f.size ?? 0,
      url: f.url_private_download ?? f.url_private ?? '',
    }))

    // In Slack, thread_ts !== ts means this is a threaded reply
    const isThread = !!msg.thread_ts && msg.thread_ts !== msg.ts
    // DM detection: Slack says so in the channel type
    const isDM = msg.channel_type === 'im'

    return {
      id: msg.ts,
      channelId: msg.channel,
      authorId: msg.user,
      authorUsername: username,
      content: msg.text ?? '',
      isDM,
      isThread,
      // A post by an app carries its bot_id. (A plain `bot_message` is dropped by the handler before this; this covers the rest, a file_share by an app for one.)
      isBot: !!msg.bot_id,
      parentChannelId: isThread ? msg.channel : null,
      hasExistingThread: false,
      existingThreadId: isThread ? `${msg.channel}:${msg.thread_ts}` : null,
      referenceMessageId: msg.thread_ts ?? null,
      effectiveThreadId: isThread ? `${msg.channel}:${msg.thread_ts}` : null,
      attachments: atts,
      createdAt: new Date(parseFloat(msg.ts) * 1000),
    }
  }

  private buildMessageUrl(channelId: string, ts: string, threadTs?: string): string {
    return archiveUrl(`https://${this._teamDomain ?? 'app'}.slack.com`, channelId, ts, threadTs || undefined) + (threadTs ? `&cid=${channelId}` : '')
  }
}
