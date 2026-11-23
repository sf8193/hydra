// One table over both platforms: each capability of a GatewayProfile, and the two pure sites that read it (placesFor, linksPreviewed), say what Discord and Slack each did before the profile.
import { describe, expect, test } from 'bun:test'
import { EVERY, placeKey } from '../../config/types.js'
import { GATEWAY_PLATFORMS, GATEWAY_PROFILES, gatewayProfile } from '../gateways/index.js'
import { linksPreviewed, placesFor } from '../link-previews.js'
import type { ChatGateway } from '../../gateways/gateway.js'
import { DiscordGateway } from '../../gateways/discord.js'
import { SlackGateway } from '../../gateways/slack.js'
import { typedDeliveryText } from '../../app/typed-delivery.js'

describe('the table', () => {
  test('every chat platform has a profile', () => {
    expect([...GATEWAY_PLATFORMS].sort()).toEqual(['discord', 'slack'])
  })
  test.each([
    ['discord', { label: 'Discord', channelNames: false, perAppDms: false, previewsWrappedLinks: false, postsReactions: true, accessSkill: '/hydra:access' }],
    ['slack', { label: 'Slack', channelNames: true, perAppDms: true, previewsWrappedLinks: true, postsReactions: false }],
  ] as const)('%s flags', (platform, flags) => {
    const { isDmId: _i, ...rest } = GATEWAY_PROFILES[platform]
    expect(rest).toEqual(flags)
  })
  test.each([
    ['discord', 'dm', true], ['discord', 'D1', false], ['discord', '123', false],
    ['slack', 'D1', true], ['slack', 'dm', false], ['slack', 'C1', false],
  ] as const)('%s: isDmId(%s) = %s', (platform, id, is) => expect(gatewayProfile(platform).isDmId(id)).toBe(is))
})

describe('the sites that read it', () => {
  test.each([['discord', 'Discord'], ['slack', 'Slack']] as const)('the typed tag names %s as %s', (platform, label) => {
    expect(typedDeliveryText('hi', { user: 'u', message_id: 'm', chat_id: 'c' }, platform)).toBe(`[${label} · u · msg m · thread c] hi`)
  })

  const keys = (platform: 'discord' | 'slack', ids: string[], app?: string) => placesFor(platform, ids, id => (id === 'C1' ? 'ops' : undefined), app).map(placeKey)
  test('places: a Discord channel goes by its id, a Slack one also by #name', () => {
    expect(keys('discord', ['C1'])).toEqual(['discord:C1'])
    expect(keys('slack', ['C1'])).toEqual(['slack:C1', 'slack:#ops'])
  })
  test('places: a DM is every app on Discord, the sending app on Slack', () => {
    expect(keys('discord', ['dm'], 'sales')).toEqual([`discord:app-dm:${EVERY}`])
    expect(keys('slack', ['D1'], 'sales')).toEqual(['slack:app-dm:sales'])
    expect(keys('slack', ['D1'])).toEqual([`slack:app-dm:${EVERY}`])
  })

  const wrapped = 'a <https://a.example> b <https://b.example|b> c [d](<https://c.example>)'
  const plain = '[x](https://a.example) [y](https://b.example) https://c.example'
  test.each([['discord', 0], ['slack', 3]] as const)('links previewed on %s', (platform, ofWrapped) => {
    expect(linksPreviewed(platform, wrapped)).toBe(ofWrapped)
    expect(linksPreviewed(platform, plain)).toBe(3)
  })
})

describe('what each gateway does', () => {
  test('postsReactions: Discord posts a reaction, Slack does not', () => {
    expect(new DiscordGateway().postsReactions).toBe(true)
    expect(new SlackGateway('xapp-test').postsReactions).toBe(false)
  })
  test('only Discord draws a time itself', () => {
    expect(new DiscordGateway().relativeTime(new Date(1_700_000_000_999))).toBe('<t:1700000000:R>')
    expect((new SlackGateway('xapp-test') as ChatGateway).relativeTime).toBeUndefined()
  })
})
