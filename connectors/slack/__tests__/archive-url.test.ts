import { expect, test } from 'bun:test'
import { archiveUrl, parseArchiveUrl } from '../conversation'

const WS = 'https://acme.slack.com'

test('archiveUrl builds each shape the old call sites built', () => {
  // runtime.slackConversationLink and watch.formatDelivery: a channel or DM top level, then a thread
  expect(archiveUrl(WS, 'C0FOOD')).toBe(`${WS}/archives/C0FOOD`)
  expect(archiveUrl(WS, 'C0FOOD', '1793732224.093059')).toBe(`${WS}/archives/C0FOOD/p1793732224093059`)
  // watch's reaction link on a reply: thread_ts, no cid (the gateway adds its own cid)
  expect(archiveUrl(WS, 'C0FOOD', '1786503000.000100', '1786502966.648539'))
    .toBe(`${WS}/archives/C0FOOD/p1786503000000100?thread_ts=1786502966.648539`)
  // gateway.buildMessageUrl with an empty anchor ts still writes /p, as it did
  expect(archiveUrl(WS, 'C0FOOD', '')).toBe(`${WS}/archives/C0FOOD/p`)
})

test('parseArchiveUrl reads back what each old parser read', () => {
  // router.fetchSlackThreadSummary and artifacts.renderContextLink: a message link, a dot before the last six digits
  expect(parseArchiveUrl(`${WS}/archives/C0FOOD/p1793732224093059`, true)).toEqual({ channel: 'C0FOOD', ts: '1793732224.093059' })
  expect(parseArchiveUrl('https://ws.slack.com/archives/C000/p12345', true)).toEqual({ channel: 'C000', ts: '12345' })
  expect(parseArchiveUrl(`${WS}/archives/C0FOOD`, true)).toBeUndefined()
  // router's channel-name cache and daemon.ts backfill: any [A-Z0-9]+ id, with or without a message
  expect(parseArchiveUrl(`${WS}/archives/T0TEAM`)).toEqual({ channel: 'T0TEAM' })
  expect(parseArchiveUrl(`${WS}/archives/C0FOOD/p1793732224093059`)?.channel).toBe('C0FOOD')
  expect(parseArchiveUrl('https://linear.app/x/issue/BANK-1')).toBeUndefined()
})
