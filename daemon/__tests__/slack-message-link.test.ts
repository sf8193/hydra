import { describe, expect, test } from 'bun:test'
import { slackMessageLink } from '../bridge-dispatch.js'

describe('slackMessageLink', () => {
  test('a message link becomes slack:<channel> and the ts with its dot', () => {
    expect(slackMessageLink('https://angellist.slack.com/archives/D0BN3LP8ASV/p1794969983366379')).toEqual({ chat_id: 'slack:D0BN3LP8ASV', message_id: '1794969983.366379' })
  })
  test('a thread reply link keeps its own ts (the query names the parent)', () => {
    expect(slackMessageLink('https://acme.slack.com/archives/C0CF2698RQC/p1794969986907669?thread_ts=1794969983.366379&cid=C0CF2698RQC')).toEqual({ chat_id: 'slack:C0CF2698RQC', message_id: '1794969986.907669' })
  })
  test('anything else is not a link', () => {
    for (const s of ['slack:C0CF2698RQC', 'https://discord.com/channels/1/2', 'https://acme.slack.com/archives/C0CF2698RQC', 'https://acme.slack.com/archives/C0CF2698RQC/p123']) expect(slackMessageLink(s)).toBeUndefined()
  })
})
