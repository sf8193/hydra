import { expect, test } from 'bun:test'
import { archiveUrl, parseArchiveUrl } from '../conversation'

const WS = 'https://acme.slack.com'

test('archiveUrl builds each shape the old call sites built', () => {
  // runtime.slackConversationLink and watch.formatDelivery: a channel or DM top level, then a thread
  expect(archiveUrl(WS, 'C0FOOD')).toBe(`${WS}/archives/C0FOOD`)
  expect(archiveUrl(WS, 'C0FOOD', '1793732224.093059')).toBe(`${WS}/archives/C0FOOD/p1793732224093059`)
  // gateway.buildMessageUrl and watch's reaction link: a reply, opened in its thread
  expect(archiveUrl(WS, 'D0B6KKFNH4N', '1786503000.000100', '1786502966.648539'))
    .toBe(`${WS}/archives/D0B6KKFNH4N/p1786503000000100?thread_ts=1786502966.648539&cid=D0B6KKFNH4N`)
})

test('parseArchiveUrl reads back what each old parser read', () => {
  // router.fetchSlackThreadSummary: channel and thread ts, a dot before the last six digits
  expect(parseArchiveUrl(`${WS}/archives/C0FOOD/p1793732224093059`)).toEqual({ channel: 'C0FOOD', ts: '1793732224.093059' })
  expect(parseArchiveUrl(`${WS}/archives/D0B6KKFNH4N/p1786503000000100?thread_ts=1786502966.648539&cid=D0B6KKFNH4N`))
    .toEqual({ channel: 'D0B6KKFNH4N', ts: '1786503000.000100' })
  // artifacts.renderContextLink's short test links: kept as written
  expect(parseArchiveUrl('https://ws.slack.com/archives/C000/p12345')).toEqual({ channel: 'C000', ts: '12345' })
  // router's channel-name cache and daemon.ts backfill: a channel link without a message
  expect(parseArchiveUrl(`${WS}/archives/G0PRIV`)).toEqual({ channel: 'G0PRIV' })
  // not a channel id, not an archive link
  expect(parseArchiveUrl(`${WS}/archives/T0TEAM/p1`)).toBeUndefined()
  expect(parseArchiveUrl('https://linear.app/x/issue/BANK-1')).toBeUndefined()
})
