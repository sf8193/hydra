import { expect, test } from 'bun:test'
import { SlackGateway } from '../slack-gateway'

// A thread link must carry thread_ts and cid, or Slack opens the channel at that message instead of the thread.
test('getThreadUrl links to the thread, not the message in the channel', async () => {
  const gw = Object.create(SlackGateway.prototype) as SlackGateway
  ;(gw as any)._teamDomain = 'acme'
  expect(await gw.getThreadUrl('D0B6KKFNH4N:1786502966.648539'))
    .toBe('https://acme.slack.com/archives/D0B6KKFNH4N/p1786502966648539?thread_ts=1786502966.648539&cid=D0B6KKFNH4N')
})
