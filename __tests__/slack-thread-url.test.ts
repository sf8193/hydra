import { expect, test } from 'bun:test'
import { SlackGateway } from '../slack-gateway'

// A thread link must carry thread_ts and cid, or Slack opens the channel at that message instead of the thread.
test('getThreadUrl links to the thread, not the message in the channel', async () => {
  const gw = Object.create(SlackGateway.prototype) as SlackGateway
  ;(gw as any)._teamDomain = 'acme'
  expect(await gw.getThreadUrl('D0B6KKFNH4N:1786502966.648539'))
    .toBe('https://acme.slack.com/archives/D0B6KKFNH4N/p1786502966648539?thread_ts=1786502966.648539&cid=D0B6KKFNH4N')
})

test('getMessageAppLink opens the message in its thread in the Slack app; empty without a team id', () => {
  const gw = Object.create(SlackGateway.prototype) as SlackGateway
  ;(gw as any)._teamId = 'T123'
  expect(gw.getMessageAppLink('D0B6KKFNH4N:1786502966.648539', '1786503000.000100'))
    .toBe('slack://channel?team=T123&id=D0B6KKFNH4N&message=1786503000.000100&thread_ts=1786502966.648539')
  expect(gw.getMessageAppLink('D0B6KKFNH4N', '1786503000.000100')).toBe('')
  ;(gw as any)._teamId = null
  expect(gw.getMessageAppLink('D0B6KKFNH4N:1786502966.648539', '1786503000.000100')).toBe('')
})
