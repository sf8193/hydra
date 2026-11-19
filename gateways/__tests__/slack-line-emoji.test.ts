// What the gateways say about the emoji a Slack line shows (`[slack] line_emoji`), and Discord's no-preview send that keeps its links bare.
import { describe, expect, test } from 'bun:test'
import { MessageFlags } from 'discord.js'
import { DiscordGateway } from '../discord'
import { SlackGateway } from '../slack'
import { loadHydraConfig } from '../../config/load'
import { testLoadEnv } from '../../config/__tests__/load-env'
import { registerPreviewConfig } from '../../shared/link-previews'
import { BASE } from '../../connectors/slack/__tests__/slack-config'

const CUSTOM = '<:slack:1573045794259603566>'

describe('canRenderEmoji', () => {
  const discord = (known: string[]) => {
    const gw = Object.create(DiscordGateway.prototype) as DiscordGateway
    ;(gw as any).client = { emojis: { cache: new Map(known.map(id => [id, {}])) } }
    return gw
  }
  test('Discord: a unicode emoji always; a custom one only when a guild the bot is in has it', () => {
    expect(discord([]).canRenderEmoji('💬')).toBe(true)
    expect(discord(['1573045794259603566']).canRenderEmoji(CUSTOM)).toBe(true)
    expect(discord(['1573045794259603566']).canRenderEmoji('<a:slack:1573045794259603566>')).toBe(true)
    expect(discord([]).canRenderEmoji(CUSTOM)).toBe(false)
    expect(discord(['1']).canRenderEmoji(CUSTOM)).toBe(false)
  })
  test('Slack: a custom Discord emoji would show as raw text; a unicode one renders', () => {
    const gw = Object.create(SlackGateway.prototype) as SlackGateway
    expect(gw.canRenderEmoji(CUSTOM)).toBe(false)
    expect(gw.canRenderEmoji('💬')).toBe(true)
  })
})

describe('Discord send with unfurl: false', () => {
  function discord() {
    const sent: any[] = []
    const gw = Object.create(DiscordGateway.prototype) as DiscordGateway
    const ch = { id: '100', isTextBased: () => true, isThread: () => false, parentId: null, send: async (p: any) => { sent.push(p); return { id: 'm1', channelId: '100' } } }
    ;(gw as any).client = { channels: { fetch: async () => ch } }
    ;(gw as any).noteSent = () => {}
    return { gw, sent }
  }
  test('carries the suppress-embeds flag, so a masked link shows no preview; without it the send is as before', async () => {
    const { gw, sent } = discord()
    await gw.send('100', '📤 to 💬 [thread](<https://x.slack.com/archives/C1/p1>) → hi', { subtext: true, unfurl: false })
    await gw.send('100', 'plain', { subtext: true })
    expect(sent[0].flags).toBe(MessageFlags.SuppressEmbeds)
    expect(sent[1].flags).toBeUndefined()
  })
})

describe('Discord send: unfurl: false beside link_previews = "single"', () => {
  test('an explicit unfurl: false suppresses even a one-link post the place would let preview; the place alone still lets it', async () => {
    registerPreviewConfig(() => ({ places: { 'discord:100': { files: false, messages: 'addressed', bots: false, linkPreviews: 'single' } } }) as any)
    const sent: any[] = []
    const gw = Object.create(DiscordGateway.prototype) as DiscordGateway
    const ch = { id: '100', isTextBased: () => true, isThread: () => false, parentId: null, send: async (p: any) => { sent.push(p); return { id: 'm1', channelId: '100' } } }
    ;(gw as any).client = { channels: { fetch: async () => ch } }
    ;(gw as any).noteSent = () => {}
    await gw.send('100', 'one https://example.com/a', { unfurl: false })
    await gw.send('100', 'one https://example.com/a')
    await gw.send('100', 'two https://example.com/a https://example.com/b')
    registerPreviewConfig(() => undefined)
    expect(sent.map(p => p.flags)).toEqual([MessageFlags.SuppressEmbeds, undefined, MessageFlags.SuppressEmbeds])
  })
})

describe('[slack] line_emoji', () => {
  const load = (extra: string) => loadHydraConfig(`operator = "op"\n[slack]\n${extra}\n${BASE.replace('operator = "op"\n', '')}`, testLoadEnv({ home: '/home/op', sessionNames: [] }))
  test('a unicode emoji or a Discord custom emoji loads; absent is fine', () => {
    for (const v of ['💬', CUSTOM, '<a:slack:1573045794259603566>']) {
      const r = load(`line_emoji = "${v}"`)
      expect(r.ok && r.config.slackLineEmoji).toBe(v)
    }
    const none = load('')
    expect(none.ok && none.config.slackLineEmoji).toBeUndefined()
  })
  test('anything else is refused at load, naming what to write', () => {
    for (const v of [':slack:', 'slack', '<:slack:12>', '<:slack:1573045794259603566> ', '💬💬', '<@U123>']) {
      const r = load(`line_emoji = "${v}"`)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.map(e => e.path)).toContain('slack.line_emoji')
    }
  })
})
