import { describe, test, expect, mock } from 'bun:test'
import * as bolt from '@slack/bolt'
import { SLACK_CLIENT_PING_TIMEOUT_MS } from '../constants.js'

// A real App calls auth.test the moment it is built, so App is faked; the receiver is the SDK's own.
const built: { token: string; receiver: unknown; socketMode: boolean; logLevel: unknown }[] = []
class FakeApp { receiver: unknown; constructor(opts: (typeof built)[number]) { built.push(opts); this.receiver = opts.receiver } }
mock.module('@slack/bolt', () => ({ ...bolt, App: FakeApp }))
const { buildSocketApp, parseAuth, unfurlFields } = await import('../slack-client.js')

describe('buildSocketApp', () => {
  test('builds a Socket Mode receiver with the keepalive headroom and an App on it', () => {
    const { app } = buildSocketApp({ appToken: 'xapp-1', botToken: 'xoxb-1' })
    const receiver = (app as unknown as { receiver: bolt.SocketModeReceiver }).receiver
    expect(receiver).toBeInstanceOf(bolt.SocketModeReceiver)
    expect((receiver.client as unknown as { clientPingTimeoutMS: number }).clientPingTimeoutMS).toBe(SLACK_CLIENT_PING_TIMEOUT_MS)
    expect(app).toBeInstanceOf(FakeApp)
    expect(built).toEqual([{ token: 'xoxb-1', receiver, socketMode: true, logLevel: bolt.LogLevel.ERROR }])
  })
})

describe('unfurlFields', () => {
  test('off turns both previews off; on adds nothing', () => {
    expect(unfurlFields(true)).toEqual({ unfurl_links: false, unfurl_media: false })
    expect(unfurlFields(false)).toEqual({})
  })
})

describe('parseAuth', () => {
  test('reads the bot, the user and the workspace url', () => {
    expect(parseAuth({ bot_id: 'B1', user_id: 'U1', url: 'https://t.slack.com/' })).toEqual({ botId: 'B1', userId: 'U1', url: 'https://t.slack.com/' })
  })
  test('a field Slack left out is absent, not undefined', () => {
    expect(parseAuth({})).toEqual({})
    expect(Object.keys(parseAuth({ user_id: 'U1' }))).toEqual(['userId'])
  })
})
