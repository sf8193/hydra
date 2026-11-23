import { describe, test, expect, mock } from 'bun:test'
import * as bolt from '@slack/bolt'
import { SLACK_CLIENT_PING_TIMEOUT_MS } from '../constants.js'

// A real App calls auth.test the moment it is built, so App is faked; the receiver is the SDK's own.
const built: { token: string; receiver: unknown; socketMode: boolean; logLevel: unknown }[] = []
class FakeApp { receiver: unknown; constructor(opts: (typeof built)[number]) { built.push(opts); this.receiver = opts.receiver } }
mock.module('@slack/bolt', () => ({ ...bolt, App: FakeApp }))
const { buildSocketApp, messageBody, MARKDOWN_TEXT_MAX, parseAuth, unfurlFields } = await import('../slack-client.js')

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

describe('messageBody', () => {
  const md = 'See [#1](https://example.com/1) **now** `code`\n```\na < b\n```'
  test('markdown goes as markdown_text, untouched', () => {
    expect(messageBody(md)).toEqual({ markdown_text: md })
  })
  test('text that is already mrkdwn goes as text, so Slack never reads it as markdown', () => {
    const mrkdwn = '*bold* <https://example.com|a link> _it_'
    expect(messageBody(mrkdwn, true)).toEqual({ text: mrkdwn })
  })
  test('a tag, a channel link and a labelled link are no exception: they go as markdown_text', () => {
    for (const t of ['<@U1> hi', '<!here>', '<#C1|dev>', '<https://x.co|x>']) expect(messageBody(t)).toEqual({ markdown_text: t })
  })
  test('the cap: at the limit still markdown_text, one past it classic text', () => {
    expect(messageBody('x'.repeat(MARKDOWN_TEXT_MAX))).toHaveProperty('markdown_text')
    expect(messageBody('x'.repeat(MARKDOWN_TEXT_MAX + 1))).toHaveProperty('text')
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
