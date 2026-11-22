import { afterEach, expect, test } from 'bun:test'
import { archiveUrl, parseArchiveUrl } from '../../../shared/slack-conversation.js'
import { slackConversationLink, slackRuntimeDeps } from '../runtime.js'

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
  expect(parseArchiveUrl(`${WS}/archives/C0FOOD`, true)).toBeUndefined()
  // router's channel-name cache and daemon.ts backfill: any [A-Z0-9]+ id, with or without a message
  expect(parseArchiveUrl(`${WS}/archives/T0TEAM`)).toEqual({ channel: 'T0TEAM' })
  expect(parseArchiveUrl(`${WS}/archives/C0FOOD/p1793732224093059`)?.channel).toBe('C0FOOD')
  expect(parseArchiveUrl('https://linear.app/x/issue/BANK-1')).toBeUndefined()
  // a lowercase id is no channel id, whichever form of link asks
  expect(parseArchiveUrl(`${WS}/archives/c0food/p1793732224093059`, true)).toBeUndefined()
  expect(parseArchiveUrl(`${WS}/archives/c0food`)).toBeUndefined()
})

test('a message link has the shape Slack writes: https, a slack.com host, p + ten digits + six, an optional query', () => {
  const ts = { channel: 'C0CF2698RQC', ts: '1794969983.366379' }
  expect(parseArchiveUrl('https://angellist.slack.com/archives/D0BN3LP8ASV/p1794969983366379', true)).toEqual({ channel: 'D0BN3LP8ASV', ts: '1794969983.366379' })
  // a thread reply keeps its own ts (the query names the parent)
  expect(parseArchiveUrl('https://acme.slack.com/archives/C0CF2698RQC/p1794969986907669?thread_ts=1794969983.366379&cid=C0CF2698RQC', true)).toEqual({ channel: 'C0CF2698RQC', ts: '1794969986.907669', threadTs: '1794969983.366379' })
  // The query's order does not matter; a thread_ts in the fragment is no thread_ts.
  expect(parseArchiveUrl('https://acme.slack.com/archives/C0CF2698RQC/p1794969986907669?cid=C0CF2698RQC&thread_ts=1794969983.366379', true)?.threadTs).toBe('1794969983.366379')
  expect(parseArchiveUrl('https://acme.slack.com/archives/C0CF2698RQC/p1794969986907669#x&thread_ts=1794969983.366379', true)).toEqual({ channel: 'C0CF2698RQC', ts: '1794969986.907669' })
  // A thread's own first message, linked with its own ts as thread_ts, is that thread.
  expect(parseArchiveUrl('https://acme.slack.com/archives/C0CF2698RQC/p1794969983366379?thread_ts=1794969983.366379', true)?.threadTs).toBe('1794969983.366379')
  // A malformed thread_ts is dropped, not passed on; a channel link has no message, so no thread.
  expect(parseArchiveUrl('https://acme.slack.com/archives/C0CF2698RQC/p1794969986907669?thread_ts=junk', true)).toEqual({ channel: 'C0CF2698RQC', ts: '1794969986.907669' })
  expect(parseArchiveUrl('https://acme.slack.com/archives/C0CF2698RQC?thread_ts=1794969983.366379')).toEqual({ channel: 'C0CF2698RQC' })
  expect(parseArchiveUrl('https://acme.slack.com/archives/C0CF2698RQC/p1794969983366379#x', true)).toEqual(ts)
  // an Enterprise Grid host is a Slack host
  expect(parseArchiveUrl('https://grid-acme.enterprise.slack.com/archives/C0CF2698RQC/p1794969983366379', true)).toEqual(ts)
  // surrounding whitespace is not part of the link
  expect(parseArchiveUrl('  https://acme.slack.com/archives/C0CF2698RQC/p1794969983366379\n', true)).toEqual(ts)
  // not a message link: no ts, a ts of the wrong length, another scheme or host, a link inside another URL, or not a URL
  for (const s of [
    'https://acme.slack.com/archives/C0CF2698RQC',
    'https://acme.slack.com/archives/C0CF2698RQC/p123',
    'https://acme.slack.com/archives/C0CF2698RQC/p17949699833663791',
    'ftp://acme.slack.com/archives/C0CF2698RQC/p1794969983366379',
    'https://acme.example.com/archives/C0CF2698RQC/p1794969983366379',
    'https://evil.example/?u=https://acme.slack.com/archives/C0CF2698RQC/p1794969983366379',
    'slack:C0CF2698RQC', 'https://discord.com/channels/1/2',
  ]) expect(parseArchiveUrl(s, true)).toBeUndefined()
})

test('a channel link has the same host rule: https, a slack.com host, no link inside another URL', () => {
  expect(parseArchiveUrl('https://grid-acme.enterprise.slack.com/archives/C0CF2698RQC')).toEqual({ channel: 'C0CF2698RQC' })
  for (const s of ['http://acme.slack.com/archives/C0CF2698RQC', 'https://acme.example.com/archives/C0CF2698RQC', 'https://evil.example/?u=https://acme.slack.com/archives/C0CF2698RQC', 'slack:C0CF2698RQC'])
    expect(parseArchiveUrl(s)).toBeUndefined()
})

const realView = slackRuntimeDeps.view
afterEach(() => { slackRuntimeDeps.view = realView })

test('slackConversationLink links a top-level conversation to its channel and a thread to its message', () => {
  slackRuntimeDeps.view = () => ({ workspaceUrl: WS }) as never
  expect(slackConversationLink('slack:C0FOOD')).toBe(`${WS}/archives/C0FOOD`)
  expect(slackConversationLink('slack:C0FOOD:1793732224.093059')).toBe(`${WS}/archives/C0FOOD/p1793732224093059`)
})
