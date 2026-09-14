import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SlackGateway } from '../../slack-gateway.js'

const CHANNEL = 'D0BE3RB4Y00'
const THREAD_TS = '1789186105.789699'
const REPLY_TS = '1789405927.425409'
const TOP_LEVEL_TS = '1789403254.473939'
const NEWER_TS = '1789404000.000001'
const DELETED_TS = '1789999999.000001'

function file(id: string, bytes: number) {
  return {
    id,
    name: 'image.png',
    mimetype: 'image/png',
    size: bytes,
    url_private_download: `https://files.slack.com/${id}/download`,
  }
}

const PARENT = { ts: THREAD_TS, thread_ts: THREAD_TS, files: [file('F_PARENT', 99000)] }
const THREAD_REPLY = { ts: REPLY_TS, thread_ts: THREAD_TS, files: [file('F_REPLY', 193313)] }
const TOP_LEVEL = { ts: TOP_LEVEL_TS, thread_ts: TOP_LEVEL_TS, files: [file('F_TOPLEVEL', 135890)] }
const NEWER = { ts: NEWER_TS, thread_ts: NEWER_TS, files: [file('F_NEWER', 1000)] }

type Call = { method: string; args: Record<string, unknown> }

function gatewayWithStub(): { gw: SlackGateway; calls: Call[] } {
  const calls: Call[] = []
  const gw = new SlackGateway('xapp-dummy')
  ;(gw as any).app = {
    client: {
      token: 'xoxb-dummy',
      conversations: {
        replies: async (args: Record<string, unknown>) => {
          calls.push({ method: 'conversations.replies', args })
          return { ok: true, messages: [PARENT, THREAD_REPLY] }
        },
        history: async (args: Record<string, unknown>) => {
          calls.push({ method: 'conversations.history', args })
          return { ok: true, messages: [NEWER, TOP_LEVEL] }
        },
      },
    },
  }
  return { gw, calls }
}

function stubHistory(gw: SlackGateway, result: unknown) {
  ;(gw as any).app.client.conversations.history = async () => result
}

let inbox: string
let realFetch: typeof fetch

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'hydra-attach-'))
  realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const id = String(url).split('/')[3]
    return { arrayBuffer: async () => new TextEncoder().encode(`body:${id}`).buffer }
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(inbox, { recursive: true, force: true })
})

describe('SlackGateway.downloadAttachments', () => {
  test('a composite chat ID reads the thread, pinned to the target timestamp', async () => {
    const { gw, calls } = gatewayWithStub()
    const out = await gw.downloadAttachments(`${CHANNEL}:${THREAD_TS}`, REPLY_TS, inbox)

    expect(calls.map(c => c.method)).toEqual(['conversations.replies'])
    expect(calls[0]!.args).toEqual({
      channel: CHANNEL,
      ts: THREAD_TS,
      oldest: REPLY_TS,
      latest: REPLY_TS,
      inclusive: true,
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.sizeKB).toBe('189')
    expect(readFileSync(out[0]!.path, 'utf8')).toBe('body:F_REPLY')
  })

  test('a bare channel ID reads channel history, pinned to the target timestamp', async () => {
    const { gw, calls } = gatewayWithStub()
    const out = await gw.downloadAttachments(CHANNEL, TOP_LEVEL_TS, inbox)

    expect(calls.map(c => c.method)).toEqual(['conversations.history'])
    expect(calls[0]!.args).toEqual({
      channel: CHANNEL,
      oldest: TOP_LEVEL_TS,
      latest: TOP_LEVEL_TS,
      inclusive: true,
    })
    expect(out).toHaveLength(1)
    expect(readFileSync(out[0]!.path, 'utf8')).toBe('body:F_TOPLEVEL')
  })

  test('the target is matched by timestamp, not by position in the response', async () => {
    const { gw } = gatewayWithStub()
    const out = await gw.downloadAttachments(CHANNEL, TOP_LEVEL_TS, inbox)

    expect(readFileSync(out[0]!.path, 'utf8')).toBe('body:F_TOPLEVEL')
  })

  test('a message the API did not return is rejected rather than substituted', async () => {
    const { gw } = gatewayWithStub()

    await expect(gw.downloadAttachments(CHANNEL, REPLY_TS, inbox))
      .rejects.toThrow(`message ${REPLY_TS} not found in ${CHANNEL}`)
  })

  test('a deleted thread reply is rejected rather than served the parent file', async () => {
    const { gw } = gatewayWithStub()

    await expect(gw.downloadAttachments(`${CHANNEL}:${THREAD_TS}`, DELETED_TS, inbox))
      .rejects.toThrow(`message ${DELETED_TS} not found in ${CHANNEL}:${THREAD_TS}`)
  })

  test('an empty response is rejected, not treated as a message without files', async () => {
    const { gw } = gatewayWithStub()
    stubHistory(gw, { ok: true, messages: [] })

    await expect(gw.downloadAttachments(CHANNEL, TOP_LEVEL_TS, inbox))
      .rejects.toThrow(`message ${TOP_LEVEL_TS} not found in ${CHANNEL}`)
  })

  test('a response with no messages key is rejected', async () => {
    const { gw } = gatewayWithStub()
    stubHistory(gw, { ok: true })

    await expect(gw.downloadAttachments(CHANNEL, TOP_LEVEL_TS, inbox))
      .rejects.toThrow(`message ${TOP_LEVEL_TS} not found in ${CHANNEL}`)
  })

  test('a message with no files yields no attachments', async () => {
    const { gw } = gatewayWithStub()
    stubHistory(gw, { ok: true, messages: [{ ts: TOP_LEVEL_TS, thread_ts: TOP_LEVEL_TS }] })

    expect(await gw.downloadAttachments(CHANNEL, TOP_LEVEL_TS, inbox)).toEqual([])
  })
})
