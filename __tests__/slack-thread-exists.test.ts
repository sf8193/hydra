import { expect, test } from 'bun:test'
import { SlackGateway } from '../slack-gateway'

function gatewayWith(fail: unknown) {
  const calls: { method: string; args: any }[] = []
  const respond = (method: string) => async (args: any) => {
    calls.push({ method, args })
    if (fail) throw fail
    return { ok: true }
  }
  const gw = Object.create(SlackGateway.prototype) as SlackGateway
  ;(gw as any).app = { client: { conversations: { replies: respond('replies'), info: respond('info') } } }
  return { gw, calls }
}

const slackError = (error: string) => Object.assign(new Error(`An API error occurred: ${error}`), { data: { ok: false, error } })

test('a live thread exists, checked against its parent message', async () => {
  const { gw, calls } = gatewayWith(null)
  expect(await gw.threadExists('D0B6KKFNH4N:1786502966.648539')).toBe(true)
  expect(calls).toEqual([{ method: 'replies', args: { channel: 'D0B6KKFNH4N', ts: '1786502966.648539', limit: 1 } }])
})

test('thread_not_found and channel_not_found mean the thread is gone', async () => {
  for (const code of ['thread_not_found', 'channel_not_found']) {
    expect(await gatewayWith(slackError(code)).gw.threadExists('D0B6KKFNH4N:1786502966.648539')).toBe(false)
  }
})

test('any other Slack error, a network error or a missing connection does not count as gone', async () => {
  expect(await gatewayWith(slackError('not_in_channel')).gw.threadExists('D0B6KKFNH4N:1786502966.648539')).toBe(true)
  expect(await gatewayWith(new Error('socket hang up')).gw.threadExists('D0B6KKFNH4N:1786502966.648539')).toBe(true)
  const offline = Object.create(SlackGateway.prototype) as SlackGateway
  expect(await offline.threadExists('D0B6KKFNH4N:1786502966.648539')).toBe(true)
})

test('a bare channel id is checked as a channel', async () => {
  const { gw, calls } = gatewayWith(slackError('channel_not_found'))
  expect(await gw.threadExists('C0B6KKFNH4N')).toBe(false)
  expect(calls.map(c => c.method)).toEqual(['info'])
})
