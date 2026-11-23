// A post's text goes through the gateway's shapeOutbound (withOutbound) before it is chunked: the bridge's reply,
// send_to_thread and edit_message, and the daemon's own safeSend and safeEdit. The gateway here is a stand-in that turns the word
// TABLE into a drawn file, so no platform is named and nothing is drawn for real.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeTool } from '../../app/bridge-dispatch.js'
import * as access from '../../sessions/access.js'
import { gateway } from '../../infra/config.js'
import { registry } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import { safeEdit, safeSend } from '../../infra/util.js'
import type { ButtonDef, Outbound } from '../../gateways/gateway.js'
import { setHydra } from './test-hydra.js'

const DIR = mkdtempSync(join(tmpdir(), 'outbound-test-'))
const DRAWN = join(DIR, 'drawn.png')
const OWN = join(DIR, 'own.txt')
writeFileSync(DRAWN, 'png')
writeFileSync(OWN, 'own')

const sends: { channel: string; text: string; files?: string[]; replyTo?: string; buttons?: ButtonDef[]; subtext?: boolean }[] = []
const shapes: { text: string; room: number }[] = []
const events: string[] = []
let spies: { mockRestore(): void }[] = []
const saved = { shape: (gateway as any).shapeOutbound, edit: gateway.edit, deliver: transport.deliver, stderr: process.stderr.write }

function session(id: string, type: string, policy?: object) {
  registry.set(id, {
    sessionId: id, tmuxName: id, topic: '', threadId: `${id}-thread`, threadUrl: `https://x/${id}`,
    createdAt: Date.now(), lastActive: Date.now(), listening: false, engine: 'claude',
    adapter: { stop: async () => {}, isAlive: () => true, isConnected: () => false }, sessionType: type, specialist: 'ops', ...(policy && { policy }),
  } as any)
}

beforeEach(() => {
  sends.length = 0; shapes.length = 0; events.length = 0
  process.stderr.write = (() => true) as any
  ;(gateway as any).shapeOutbound = async (text: string, room: number, post: (o: Outbound) => Promise<unknown>) => {
    shapes.push({ text, room })
    const drawn = text.includes('TABLE') && room > 0
    const r = await post({ text: text.replace('TABLE', drawn ? '' : '[code block]'), files: drawn ? [DRAWN] : [] })
    events.push('files removed')
    return r
  }
  ;(transport as any).deliver = async () => ({ status: 'accepted' })
  spies = [
    spyOn(gateway, 'send').mockImplementation((async (channel: string, text: string, opts?: { files?: string[]; replyTo?: string; buttons?: ButtonDef[]; subtext?: boolean }) => {
      sends.push({
        channel, text,
        ...(opts?.files ? { files: opts.files } : {}),
        ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
        ...(opts?.buttons ? { buttons: opts.buttons } : {}),
        ...(opts?.subtext ? { subtext: opts.subtext } : {}),
      })
      events.push('sent')
      return { id: 'm1', channelId: channel }
    }) as any),
    spyOn(gateway, 'fetchChannel').mockImplementation((async (id: string) => ({ id, isThread: true, parentId: 'ob-parent' })) as any),
    setHydra({ operators: ['u1'], channels: { 'ob-parent': {} } }),
  ]
  session('ob-owner', 'thread_owner')
  session('ob-restricted', 'thread_owner', { specialist: 'ops', restricted: true, id: 'x' })
  session('ob-target', 'thread_owner')
})

afterEach(() => {
  ;(gateway as any).shapeOutbound = saved.shape
  ;(gateway as any).edit = saved.edit
  ;(transport as any).deliver = saved.deliver
  process.stderr.write = saved.stderr
  for (const s of spies) s.mockRestore()
  for (const id of ['ob-owner', 'ob-restricted', 'ob-target']) registry.delete(id)
})

describe('bridge reply', () => {
  test('the shaped text goes out, the drawn file after the session\'s own, in the room the session left; files stay until the send settles', async () => {
    const res = await executeTool('reply', { chat_id: 'ob-owner-thread', text: 'Status: TABLE', files: [OWN] }, 'ob-owner')
    expect(res.isError).toBeUndefined()
    expect(shapes).toEqual([{ text: 'Status: TABLE', room: 9 }])
    expect(sends).toEqual([{ channel: 'ob-owner-thread', text: 'Status: ', files: [OWN, DRAWN] }])
    expect(events).toEqual(['sent', 'files removed'])
  })

  test('a restricted session gets the picture too: the daemon drew it from the session\'s own text', async () => {
    const res = await executeTool('reply', { chat_id: 'ob-restricted-thread', text: 'TABLE' }, 'ob-restricted')
    expect(res.isError).toBeUndefined()
    expect(sends).toEqual([{ channel: 'ob-restricted-thread', text: '', files: [DRAWN] }])
  })

  test('a long reply goes out in chunks no longer than the platform allows, answering the message only on the first', async () => {
    const text = 'x'.repeat(gateway.maxMessageLength * 2 + 5)
    const res = await executeTool('reply', { chat_id: 'ob-owner-thread', text, reply_to: 'orig' }, 'ob-owner')
    expect(res.isError).toBeUndefined()
    expect(sends).toHaveLength(3)
    expect(sends.map(x => x.replyTo)).toEqual(['orig', undefined, undefined])
    for (const x of sends) expect(x.text.length).toBeLessThanOrEqual(gateway.maxMessageLength)
  })

  test('a reply to a channel the daemon is not in, or to a DM that is not the operator\'s, is refused', async () => {
    const fetch = spies[1] as any
    fetch.mockImplementation((async (id: string) => ({ id, isThread: false, isDM: false, parentId: null })) as any)
    expect((await executeTool('reply', { chat_id: 'elsewhere', text: 'hi' }, 'ob-owner')).isError).toBe(true)
    fetch.mockImplementation((async (id: string) => ({ id, isThread: false, isDM: true, recipientId: 'stranger' })) as any)
    expect((await executeTool('reply', { chat_id: 'dm-1', text: 'hi' }, 'ob-owner')).isError).toBe(true)
    fetch.mockImplementation((async (id: string) => ({ id, isThread: false, isDM: true, recipientId: 'u1' })) as any)
    expect((await executeTool('reply', { chat_id: 'dm-2', text: 'hi' }, 'ob-owner')).isError).toBeUndefined()
    expect(sends.map(x => x.channel)).toEqual(['dm-2'])
  })

  test('a restricted session still may not attach files of its own', async () => {
    const res = await executeTool('reply', { chat_id: 'ob-restricted-thread', text: 'x', files: [OWN] }, 'ob-restricted')
    expect(res.isError).toBe(true)
    expect(sends).toEqual([])
  })
})

test('send_to_thread, posted in full, is shaped the same way', async () => {
  const res = await executeTool('send_to_thread', { target: 'ob-target', type: 'result', text: 'TABLE', files: [OWN] }, 'ob-owner')
  expect(res.isError).toBeFalsy()
  expect(shapes).toEqual([{ text: 'TABLE', room: 9 }])
  expect(sends).toContainEqual({ channel: 'ob-target-thread', text: '', files: [OWN, DRAWN] })
})

test('the daemon\'s own messages: safeSend attaches what was drawn to the first chunk', async () => {
  await safeSend('ob-chan', `TABLE\n${'x'.repeat(gateway.maxMessageLength + 10)}`)
  expect(shapes[0].room).toBe(10)
  expect(sends).toHaveLength(2)
  expect(sends[0].files).toEqual([DRAWN])
  expect(sends[1].files).toBeUndefined()
})

test('safeSend puts caller files ahead of drawn files and reserves their slots', async () => {
  await safeSend('ob-chan', `TABLE\n${'x'.repeat(gateway.maxMessageLength + 10)}`, { files: [OWN] })
  expect(shapes[0].room).toBe(9)
  expect(sends).toHaveLength(2)
  expect(sends[0].files).toEqual([OWN, DRAWN])
  expect(sends[1].files).toBeUndefined()
})

test('safeSend attaches buttons only to the last chunk and forwards subtext', async () => {
  const buttons: ButtonDef[] = [{ id: 'perm:allow:1', label: 'Allow', style: 'success' }]
  await safeSend('ob-chan', 'x'.repeat(gateway.maxMessageLength + 10), { buttons, subtext: true })
  expect(sends).toHaveLength(2)
  expect(sends[0].buttons).toBeUndefined()
  expect(sends[1].buttons).toEqual(buttons)
  expect(sends[0].subtext).toBe(true)
  expect(sends[1].subtext).toBe(true)
})

test('an edit cannot add files: safeEdit asks for no room', async () => {
  let edited = ''
  ;(gateway as any).edit = async (_c: string, _m: string, text: string) => { edited = text; return 'm1' }
  expect(await safeEdit('ob-chan', 'm1', 'TABLE')).toBe('ok')
  expect(shapes).toEqual([{ text: 'TABLE', room: 0 }])
  expect(edited).toBe('[code block]')
})

test('edit_message is shaped with no room: an edit cannot add files', async () => {
  let edited = ''
  ;(gateway as any).edit = async (_c: string, _m: string, text: string) => { edited = text; return 'm1' }
  const res = await executeTool('edit_message', { chat_id: 'ob-owner-thread', message_id: 'm1', text: 'TABLE' }, 'ob-owner')
  expect(res.isError).toBeUndefined()
  expect(shapes).toEqual([{ text: 'TABLE', room: 0 }])
  expect(edited).toBe('[code block]')
})

test('a gateway without shapeOutbound posts text as written', async () => {
  ;(gateway as any).shapeOutbound = undefined
  await safeSend('ob-chan', '| a | b |\n|---|---|')
  expect(sends).toEqual([{ channel: 'ob-chan', text: '| a | b |\n|---|---|' }])
})
