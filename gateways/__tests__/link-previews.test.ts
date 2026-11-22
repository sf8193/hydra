// `[places]` `link_previews = false`, at the two gateways every message hydra posts goes through: Slack's unfurl_links and
// unfurl_media, Discord's suppress-embeds flag. A place that does not say keeps today's call, byte for byte.
import { afterEach, describe, expect, test } from 'bun:test'
import { MessageFlags } from 'discord.js'
import { DiscordGateway } from '../discord.js'
import { SlackGateway } from '../slack.js'
import { placeKey } from '../../config/types.js'
import { linkPreviewsOff, linksPreviewed, placesFor, registerPreviewConfig, registerSlackChannelNames } from '../../shared/link-previews.js'

const places = (p: Record<string, boolean | 'single'>) => ({ places: Object.fromEntries(Object.entries(p).map(([k, linkPreviews]) => [k, { files: false, messages: 'addressed', bots: false, linkPreviews }])) }) as any
afterEach(() => { registerPreviewConfig(() => undefined); registerSlackChannelNames(() => undefined) })

describe('which places turn previews off', () => {
  test('only a declared place with link_previews = false; undeclared and default places keep them', () => {
    registerPreviewConfig(() => places({ 'slack:C0OPS': false, 'slack:C0FAQ': true }))
    expect(linkPreviewsOff('slack', ['C0OPS'], {}, '')).toBe(true)
    expect(linkPreviewsOff('slack', ['C0FAQ'], {}, '')).toBe(false)
    expect(linkPreviewsOff('slack', ['C0NONE'], {}, '')).toBe(false)
  })
  test('with no config registered nothing is off', () => {
    expect(linkPreviewsOff('slack', ['C0OPS'], {}, '')).toBe(false)
    expect(linkPreviewsOff('discord', ['1'], {}, '')).toBe(false)
  })
  test('a Slack place named by #name matches through the names the apps read; a DM matches slack:app-dm:*', () => {
    registerPreviewConfig(() => places({ 'slack:#ops': false, 'slack:app-dm:*': false }))
    registerSlackChannelNames(c => (c === 'C0OPS' ? 'ops' : undefined))
    expect(linkPreviewsOff('slack', ['C0OPS'], {}, '')).toBe(true)
    expect(linkPreviewsOff('slack', ['C0OTHER'], {}, '')).toBe(false)
    expect(linkPreviewsOff('slack', ['D0DM'], {}, '')).toBe(true)
    expect(placesFor('slack', ['C0OPS']).map(placeKey)).toEqual(['slack:C0OPS', 'slack:#ops'])
    expect(placesFor('slack', ['D0DM'], undefined, 'sales').map(placeKey)).toEqual(['slack:app-dm:sales'])
    expect(placesFor('discord', ['dm']).map(placeKey)).toEqual(['discord:app-dm:*'])
  })
  test('a DM with one app\'s bot: its own entry decides before slack:app-dm:*, and an entry for another app does not apply', () => {
    registerPreviewConfig(() => places({ 'slack:app-dm:*': false, 'slack:app-dm:sales': true }))
    expect(linkPreviewsOff('slack', ['D0DM'], { app: 'sales' }, '')).toBe(false)
    expect(linkPreviewsOff('slack', ['D0DM'], { app: 'support' }, '')).toBe(true)
    registerPreviewConfig(() => places({ 'slack:app-dm:sales': false }))
    expect(linkPreviewsOff('slack', ['D0DM'], { app: 'support' }, '')).toBe(false)
    expect(linkPreviewsOff('slack', ['D0DM'], { app: 'sales' }, '')).toBe(true)
  })
  test('the platform is part of the key: a Slack place does not switch off a Discord channel of the same id', () => {
    registerPreviewConfig(() => places({ 'slack:123': false }))
    expect(linkPreviewsOff('discord', ['123'], {}, '')).toBe(false)
  })
  test('a key that is a property of Object.prototype is not a place', () => {
    registerPreviewConfig(() => places({}))
    expect(linkPreviewsOff('discord', ['constructor', '__proto__'], {}, '')).toBe(false)
  })
})

describe('Slack', () => {
  function slack() {
    const calls: { method: string; args: any }[] = []
    const gw = Object.create(SlackGateway.prototype) as SlackGateway
    ;(gw as any).app = { client: { chat: {
      postMessage: async (args: any) => { calls.push({ method: 'postMessage', args }); return { ts: '1.1' } },
      update: async (args: any) => { calls.push({ method: 'update', args }); return { ts: '1.1' } },
    } } }
    ;(gw as any)._sendChain = Promise.resolve()
    ;(gw as any)._lastSendAt = 0
    ;(gw as any).noteSent = () => {}
    return { gw, calls }
  }
  test('a message to a place with link_previews = false is posted with unfurl_links and unfurl_media false', async () => {
    registerPreviewConfig(() => places({ 'slack:C0OPS': false }))
    const { gw, calls } = slack()
    await gw.send('C0OPS', 'see https://example.com')
    await gw.send('C0OPS:1700.1', 'in a thread')   // a thread in that place is the place
    expect(calls.map(c => [c.args.unfurl_links, c.args.unfurl_media])).toEqual([[false, false], [false, false]])
  })
  test('without the option the arguments are exactly what they were: neither key is sent', async () => {
    registerPreviewConfig(() => places({ 'slack:C0OPS': false }))
    const { gw, calls } = slack()
    await gw.send('C0FAQ', 'see https://example.com')
    expect(Object.keys(calls[0].args)).not.toContain('unfurl_links')
    expect(Object.keys(calls[0].args)).not.toContain('unfurl_media')
  })
  test('a caller that already asked for no unfurl still gets none, in any place', async () => {
    const { gw, calls } = slack()
    await gw.send('C0FAQ', 'x', { unfurl: false })
    expect(calls[0].args.unfurl_links).toBe(false)
  })
})

describe('Slack: hydra\'s own subtext lines', () => {
  function slack() {
    const calls: any[] = []
    const gw = Object.create(SlackGateway.prototype) as SlackGateway
    ;(gw as any).app = { client: { chat: { postMessage: async (args: any) => { calls.push(args); return { ts: '1.1' } } } } }
    ;(gw as any)._sendChain = Promise.resolve()
    ;(gw as any)._lastSendAt = 0
    ;(gw as any).noteSent = () => {}
    return { gw, calls }
  }
  const permalink = 'https://acme.slack.com/archives/C0MAIN/p1700000000000100?thread_ts=1700000000.000100&cid=C0MAIN'
  test('a relay line with a Slack permalink, in a place that says nothing about previews, is posted with unfurl_links and unfurl_media false', async () => {
    const { gw, calls } = slack()
    await gw.send('C0OTHER:1700.1', `📨 from ⚡ [nova](<${permalink}>) → hi`, { subtext: true })
    expect([calls[0].unfurl_links, calls[0].unfurl_media]).toEqual([false, false])
  })
  test('a session reply (not subtext) keeps today\'s call: neither key', async () => {
    const { gw, calls } = slack()
    await gw.send('C0OTHER:1700.1', `see ${permalink}`)
    expect(Object.keys(calls[0])).not.toContain('unfurl_links')
    expect(Object.keys(calls[0])).not.toContain('unfurl_media')
  })
})

describe('Discord', () => {
  function discord(channel: Record<string, unknown>) {
    const sent: any[] = []
    const edits: any[] = []
    const gw = Object.create(DiscordGateway.prototype) as DiscordGateway
    const ch = {
      id: '100', isTextBased: () => true, isThread: () => false, parentId: null, ...channel,
      send: async (p: any) => { sent.push(p); return { id: 'm1', channelId: '100' } },
      messages: { fetch: async () => ({ edit: async (p: any) => { edits.push(p); return { id: 'm1' } } }) },
    }
    ;(gw as any).client = { channels: { fetch: async () => ch } }
    ;(gw as any).noteSent = () => {}
    return { gw, sent, edits }
  }
  test('a send to a place with link_previews = false carries the suppress-embeds flag', async () => {
    registerPreviewConfig(() => places({ 'discord:100': false }))
    const { gw, sent } = discord({})
    await gw.send('100', 'see https://example.com')
    expect(sent[0].flags).toBe(MessageFlags.SuppressEmbeds)
  })
  test('a thread in that place counts as the place (its parent channel names it)', async () => {
    registerPreviewConfig(() => places({ 'discord:100': false }))
    const { gw, sent } = discord({ id: '555', isThread: () => true, parentId: '100' })
    await gw.send('555', 'x')
    expect(sent[0].flags).toBe(MessageFlags.SuppressEmbeds)
  })
  test('an edit there suppresses embeds again; an edit elsewhere is the plain text edit it was', async () => {
    registerPreviewConfig(() => places({ 'discord:100': false }))
    const off = discord({})
    await off.gw.edit('100', 'm1', 'edited https://example.com')
    expect(off.edits[0]).toEqual({ content: 'edited https://example.com', flags: MessageFlags.SuppressEmbeds })
    const on = discord({ id: '200' })
    await on.gw.edit('200', 'm1', 'edited')
    expect(on.edits[0]).toBe('edited')
  })
  test('default unchanged: a place without the option, and no config at all, send with no flags key', async () => {
    registerPreviewConfig(() => places({ 'discord:999': false }))
    const a = discord({})
    await a.gw.send('100', 'x')
    expect(Object.keys(a.sent[0])).toEqual(['content'])
    registerPreviewConfig(() => undefined)
    const b = discord({})
    await b.gw.send('100', 'x')
    expect(Object.keys(b.sent[0])).toEqual(['content'])
  })
})

describe('every way a gateway posts goes through its one seam', () => {
  test('Slack: a new thread\'s anchor and first reply, and a DM, carry the unfurl flags for a place that turns previews off', async () => {
    registerPreviewConfig(() => places({ 'slack:C0OPS': false, 'slack:app-dm:*': false }))
    const calls: any[] = []
    const gw = Object.create(SlackGateway.prototype) as SlackGateway
    ;(gw as any).app = { client: { chat: { postMessage: async (a: any) => { calls.push(a); return { ts: '1.1' } } }, conversations: { open: async () => ({ channel: { id: 'D0DM' } }) } } }
    ;(gw as any).noteSent = () => {}
    await gw.createThread('C0OPS', 'Topic', { text: 'first reply with https://example.com' })
    await gw.sendDM('U1', 'hello https://example.com')
    expect(calls).toHaveLength(3)
    for (const c of calls) { expect(c.unfurl_links).toBe(false); expect(c.unfurl_media).toBe(false) }
  })
  test('Slack: the same calls in a place that does not say are exactly as they were', async () => {
    registerPreviewConfig(() => places({ 'slack:C0OPS': false }))
    const calls: any[] = []
    const gw = Object.create(SlackGateway.prototype) as SlackGateway
    ;(gw as any).app = { client: { chat: { postMessage: async (a: any) => { calls.push(a); return { ts: '1.1' } } } } }
    ;(gw as any).noteSent = () => {}
    await gw.createThread('C0FAQ', 'Topic', { text: 'x' })
    expect(calls.map(c => Object.keys(c))).toEqual([['channel', 'text'], ['channel', 'text', 'thread_ts']])
  })
  test('Discord: a new thread\'s first message and a DM carry the suppress-embeds flag for a place that turns previews off', async () => {
    registerPreviewConfig(() => places({ 'discord:100': false, 'discord:app-dm:*': false }))
    const sent: any[] = []
    const thread = { id: '555', guildId: 'g', send: async (p: any) => { sent.push(p); return { id: 'm1' } } }
    const ch = { id: '100', isTextBased: () => true, isThread: () => false, threads: { create: async () => thread } }
    const gw = Object.create(DiscordGateway.prototype) as DiscordGateway
    ;(gw as any).client = { channels: { fetch: async () => ch }, users: { fetch: async () => ({ send: async (p: any) => { sent.push(p) } }) } }
    ;(gw as any).noteSent = () => {}
    await gw.createThread('100', 'Topic', { text: 'first https://example.com' })
    await gw.sendDM('7', 'dm https://example.com')
    expect(sent.map(p => p.flags)).toEqual([MessageFlags.SuppressEmbeds, MessageFlags.SuppressEmbeds])
    registerPreviewConfig(() => places({}))
    sent.length = 0
    await gw.createThread('100', 'Topic', { text: 'x' })
    await gw.sendDM('7', 'x')
    expect(sent.map(p => Object.keys(p))).toEqual([['content'], ['content']])
  })
})

describe('a Discord button click edits or answers through the same seam', () => {
  test('update (with and without buttons) and reply carry the flag in a place that turns previews off, and do not elsewhere', async () => {
    const gw = new DiscordGateway({ heartbeatPath: null })
    const handler: any[] = []
    gw.onButtonClick(c => { handler.push(c) })
    const calls: any[] = []
    const click = (channelId: string) => ({
      isButton: () => true, user: { id: 'u' }, customId: 'x', message: { content: 'm' }, channelId,
      channel: { isThread: () => false, isDMBased: () => false },
      update: async (p: any) => { calls.push(['update', p]) }, reply: async (p: any) => { calls.push(['reply', p]) },
    })
    registerPreviewConfig(() => places({ 'discord:100': false }))
    ;(gw as any).handleInteraction(click('100'))
    await handler[0].respond('t', [{ id: 'b', label: 'L' }]); await handler[0].respond('t'); await handler[0].clearButtons('t')
    expect(calls.map(([, p]) => p.flags)).toEqual([MessageFlags.SuppressEmbeds, MessageFlags.SuppressEmbeds, MessageFlags.SuppressEmbeds])
    calls.length = 0
    ;(gw as any).handleInteraction(click('999'))
    await handler[1].respond('t'); await handler[1].clearButtons('t')
    expect(calls.map(([, p]) => Object.keys(p).includes('flags'))).toEqual([false, false])
  })
})

describe('link_previews = "single": at most one preview per post', () => {
  function slack() {
    const calls: any[] = []
    const gw = Object.create(SlackGateway.prototype) as SlackGateway
    ;(gw as any).app = { client: { chat: { postMessage: async (a: any) => { calls.push(a); return { ts: '1.1' } } } } }
    ;(gw as any)._sendChain = Promise.resolve()
    ;(gw as any)._lastSendAt = 0
    ;(gw as any).noteSent = () => {}
    return { gw, calls }
  }
  function discord() {
    const sent: any[] = []
    const edits: any[] = []
    const gw = Object.create(DiscordGateway.prototype) as DiscordGateway
    const ch = {
      id: '100', isTextBased: () => true, isThread: () => false, parentId: null,
      send: async (p: any) => { sent.push(p); return { id: 'm1', channelId: '100' } },
      messages: { fetch: async () => ({ edit: async (p: any) => { edits.push(p); return { id: 'm1' } } }) },
    }
    ;(gw as any).client = { channels: { fetch: async () => ch } }
    ;(gw as any).noteSent = () => {}
    return { gw, sent, edits }
  }
  test('Slack: one link unfurls as Slack would (neither key sent); two links go out with unfurl_links and unfurl_media false', async () => {
    registerPreviewConfig(() => places({ 'slack:C0OPS': 'single' }))
    const { gw, calls } = slack()
    await gw.send('C0OPS', 'see https://example.com')
    await gw.send('C0OPS', 'see https://example.com and https://example.org')
    await gw.send('C0OPS', 'see <https://a.example|a> and <https://b.example>')
    expect(Object.keys(calls[0])).not.toContain('unfurl_links')
    expect(Object.keys(calls[0])).not.toContain('unfurl_media')
    expect([calls[1].unfurl_links, calls[1].unfurl_media]).toEqual([false, false])
    expect([calls[2].unfurl_links, calls[2].unfurl_media]).toEqual([false, false])
  })
  test('Slack, a message with buttons (Block Kit text and blocks): two links go out with unfurl off; one link is not forced off', async () => {
    registerPreviewConfig(() => places({ 'slack:C0OPS': 'single' }))
    const { gw, calls } = slack()
    const buttons = [{ id: 'ok', label: 'OK' }]
    await gw.send('C0OPS', 'see https://example.com and <https://example.org|this>', { buttons })
    await gw.send('C0OPS', 'see https://example.com', { buttons })
    expect(calls[0].blocks).toBeDefined()
    expect([calls[0].unfurl_links, calls[0].unfurl_media]).toEqual([false, false])
    expect(Object.keys(calls[1])).not.toContain('unfurl_links')
    expect(Object.keys(calls[1])).not.toContain('unfurl_media')
  })
  test('Discord: two bare URLs carry the suppress-embeds flag; one, or <url>-wrapped ones, do not', async () => {
    registerPreviewConfig(() => places({ 'discord:100': 'single' }))
    const { gw, sent, edits } = discord()
    await gw.send('100', 'see https://example.com and https://example.org')
    await gw.send('100', 'see https://example.com')
    await gw.send('100', 'see <https://example.com> and <https://example.org> and https://example.net')
    expect(sent.map(p => p.flags)).toEqual([MessageFlags.SuppressEmbeds, undefined, undefined])
    await gw.edit('100', 'm1', 'now https://example.com and https://example.org')
    expect(edits[0]).toEqual({ content: 'now https://example.com and https://example.org', flags: MessageFlags.SuppressEmbeds })
  })
  test('the count: distinct URLs, code previews nothing, Slack counts <url|label> and Discord does not count <url>', () => {
    expect(linksPreviewed('slack', '<https://a.example|a> and https://b.example.')).toBe(2)
    expect(linksPreviewed('discord', '<https://a.example> and https://b.example.')).toBe(1)
    expect(linksPreviewed('discord', 'https://a.example twice https://a.example')).toBe(1)
    expect(linksPreviewed('discord', '[a](https://a.example) `https://b.example` ```\nhttps://c.example\n```')).toBe(1)
  })
  test('links that touch are still separate links: side-by-side markdown links, comma-joined URLs, a `)` inside a URL', () => {
    for (const platform of ['slack', 'discord'] as const) {
      expect(linksPreviewed(platform, '[a](https://a.example/x)[b](https://b.example/y)')).toBe(2)
      expect(linksPreviewed(platform, 'https://a.example,https://b.example')).toBe(2)
      expect(linksPreviewed(platform, '[a](https://a.example) and [b](https://b.example)')).toBe(2)
      expect(linksPreviewed(platform, '[a](https://a.example/x)https://b.example/y')).toBe(2)
    }
    expect(linksPreviewed('discord', '[a](<https://a.example>)[b](https://b.example)')).toBe(1)
    expect(linksPreviewed('slack', '[a](<https://a.example>)[b](https://b.example)')).toBe(2)
    expect(linksPreviewed('discord', '[w](https://en.wikipedia.org/wiki/Foo_(bar))')).toBe(1)
  })
  test('false still wins over "single" (a thread whose channel turns previews off)', () => {
    registerPreviewConfig(() => places({ 'discord:555': 'single', 'discord:100': false }))
    expect(linkPreviewsOff('discord', ['555', '100'], {}, 'one https://example.com')).toBe(true)
  })
})
