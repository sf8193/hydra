// Files people send a write-confined specialist are saved in its own `<workdir>/.inbox` (the shared inbox is under the state folder, which it is denied), the message
// carries that path, and everything else is unchanged: any other session still gets the shared inbox. Walks the two ways attachments are saved (a message arriving,
// and the `download_attachment` tool) and the check on a file it then attaches.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { InboundMessage } from '../../gateways/gateway.js'
import { writeInboxFile } from '../../shared/confined-inbox.js'
import { INBOX_DIR_NAME, INBOX_LIMITS, fileRefusal } from '../../config/write-confinement.js'
import * as access from '../../sessions/access.js'
import { MAX_ATTACHMENT_BYTES } from '../../sessions/access.js'
import { gateway, INBOX_DIR, STATE_DIR } from '../../infra/config.js'
import { registry } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import { confinementIdFor } from '../restricted.js'
import { buildNotificationPayload } from '../router.js'
import { executeTool } from '../bridge-dispatch.js'
import { noteDeclaredRestrictions } from '../../sessions/tool-surface.js'
import { setHydra } from './test-hydra.js'

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'ib-routing-')))
const WORK = join(ROOT, 'work'), OTHER = join(ROOT, 'other'), OUT = join(ROOT, 'outside')
for (const d of [WORK, OTHER, OUT]) mkdirSync(d, { recursive: true })
writeFileSync(join(OUT, 'victim'), 'keep')
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const policy = (workdir = WORK) => { const w = { workdir, denyCommands: [], cannotRead: [STATE_DIR, OTHER], servers: [] }; return { specialist: 'ops', restricted: false, canOnlyWriteTo: w, id: confinementIdFor(w) } }
const mk = (id: string, extra: Record<string, unknown> = {}) => registry.set(id, {
  sessionId: id, tmuxName: id, topic: '', threadId: `${id}-thread`, createdAt: Date.now(), lastActive: Date.now(), listening: false, engine: 'claude',
  adapter: { stop: async () => {}, isAlive: () => true, isConnected: () => false }, sessionType: 'thread_owner', specialist: 'ops', ...extra,
} as any)
const inbound = (): InboundMessage => ({
  id: '111', channelId: 'chan', authorId: 'u1', authorUsername: 'person', content: 'see file', isDM: false, isThread: false, isBot: false, parentChannelId: null,
  hasExistingThread: false, existingThreadId: null, referenceMessageId: null, effectiveThreadId: null,
  attachments: [{ id: 'A1', name: 'report.pdf', contentType: 'application/pdf', size: 4, url: 'https://x/a' }], createdAt: new Date(0),
})
const inboxOf = () => join(WORK, INBOX_DIR_NAME)
const sharedFiles = () => (existsSync(INBOX_DIR) ? readdirSync(INBOX_DIR).filter(f => f.endsWith('-report.pdf')) : [])

let calls: { dir: string; limits: unknown }[]
let spies: { mockRestore(): void }[] = []
const stderr = process.stderr.write
beforeEach(() => {
  calls = []
  process.stderr.write = (() => true) as any
  ;(transport as any).sendOrQueue = () => {}
  rmSync(inboxOf(), { recursive: true, force: true }); rmSync(INBOX_DIR, { recursive: true, force: true })
  spies = [
    // What a real gateway does with the folder it is given: it saves each file there with the daemon's one writer.
    spyOn(gateway, 'downloadAttachments').mockImplementation((async (_c: string, _m: string, dir: string, limits?: any) => {
      calls.push({ dir, limits })
      return [{ path: writeInboxFile(dir, 'report.pdf', Buffer.from('data'), limits), name: 'report.pdf', contentType: 'application/pdf', sizeKB: '0' }]
    }) as any),
    spyOn(gateway, 'getThreadStarterInfo').mockImplementation((async () => null) as any),
    spyOn(gateway, 'fetchChannel').mockImplementation((async (id: string) => ({ id, isThread: true, parentId: 'ib-parent' })) as any),
    setHydra({ operators: ['u1'], channels: { 'ib-parent': {} } }),
  ]
  mk('ib-confined', { policy: policy(), verified: true })
  mk('ib-plain')
})
afterEach(() => {
  process.stderr.write = stderr
  for (const s of spies) s.mockRestore()
  for (const id of ['ib-confined', 'ib-plain', 'ib-stray']) registry.delete(id)
})

describe('a message with an attachment arrives for a write-confined session', () => {
  test('it is saved in <workdir>/.inbox with the inbox limits, and the message carries that path', async () => {
    const { meta } = await buildNotificationPayload(inbound(), 'ib-confined-thread', 'ib-confined')
    expect(calls).toEqual([{ dir: inboxOf(), limits: INBOX_LIMITS }])
    expect(meta.downloaded_files!.startsWith(inboxOf() + '/')).toBe(true)
    expect(meta.attachments).toContain(`-> ${meta.downloaded_files}`)
    expect(readFileSync(meta.downloaded_files!, 'utf8')).toBe('data')
    expect(sharedFiles()).toEqual([])
  })
  test('the folder is 0700 and the saved file 0600', async () => {
    const { meta } = await buildNotificationPayload(inbound(), 'ib-confined-thread', 'ib-confined')
    const { statSync } = await import('fs')
    expect(statSync(inboxOf()).mode & 0o777).toBe(0o700)
    expect(statSync(meta.downloaded_files!).mode & 0o777).toBe(0o600)
  })
  test('another session gets the shared inbox, as before (no limits, no folder in any workdir)', async () => {
    const { meta } = await buildNotificationPayload(inbound(), 'ib-plain-thread', 'ib-plain')
    expect(calls).toEqual([{ dir: INBOX_DIR, limits: undefined }])
    expect(meta.downloaded_files!.startsWith(INBOX_DIR + '/')).toBe(true)
    expect(existsSync(inboxOf())).toBe(false)
  })
  test('a message to no known session (or none named) still uses the shared inbox', async () => {
    await buildNotificationPayload(inbound(), 'x')
    await buildNotificationPayload(inbound(), 'x', 'no-such-session')
    expect(calls.map(c => c.dir)).toEqual([INBOX_DIR, INBOX_DIR])
  })
  test('a link where .inbox should be: nothing is saved anywhere, and the session is told why', async () => {
    symlinkSync(OUT, inboxOf())
    const { meta, content } = await buildNotificationPayload(inbound(), 'ib-confined-thread', 'ib-confined')
    expect(calls).toEqual([])
    expect(readdirSync(OUT)).toEqual(['victim'])
    expect(meta.downloaded_files).toBeUndefined()
    expect(meta.attachments).toContain('not saved')
    expect(meta.attachments).toContain('not a plain folder')
    expect(content).toBe('see file')
  })
  test('a plain file where .inbox should be is refused the same way', async () => {
    writeFileSync(inboxOf(), 'x')
    const { meta } = await buildNotificationPayload(inbound(), 'ib-confined-thread', 'ib-confined')
    expect(meta.downloaded_files).toBeUndefined()
    expect(meta.attachments).toContain('not saved')
  })
  test('a full inbox: the next file is refused, and the session is told to clear it', async () => {
    mkdirSync(inboxOf(), { mode: 0o700 })
    for (let i = 0; i < INBOX_LIMITS.maxFiles; i++) writeFileSync(join(inboxOf(), `f${i}`), 'x')
    const { meta } = await buildNotificationPayload(inbound(), 'ib-confined-thread', 'ib-confined')
    expect(meta.downloaded_files).toBeUndefined()
    expect(meta.attachments).toContain('is full')
    expect(readdirSync(inboxOf()).length).toBe(INBOX_LIMITS.maxFiles)
  })
  test('a session its bridge declared write-confined with no record of a policy gets the same answer here as from download_attachment: nothing is saved, and it is told why', async () => {
    noteDeclaredRestrictions('ib-stray', { writeConfined: true })
    mk('ib-stray')
    const { meta } = await buildNotificationPayload(inbound(), 'ib-stray-thread', 'ib-stray')
    expect(calls).toEqual([])
    expect(meta.downloaded_files).toBeUndefined()
    expect(meta.attachments).toContain('not saved')
    expect(meta.attachments).toContain('no record')
  })
  test('a failed download for a non-confined session says nothing new (the log only)', async () => {
    ;(gateway.downloadAttachments as any).mockImplementation(async () => { throw new Error('boom') })
    const { meta } = await buildNotificationPayload(inbound(), 'ib-plain-thread', 'ib-plain')
    expect(meta.attachments).toBe('report.pdf (application/pdf, 0KB)')
  })
  test('the inbox file limit is the attachment limit', () => { expect(INBOX_LIMITS.maxFileBytes).toBe(MAX_ATTACHMENT_BYTES) })
})

describe('download_attachment', () => {
  const dl = (id: string) => executeTool('download_attachment', { chat_id: `${id}-thread`, message_id: '111' }, id)
  test('a write-confined session\'s files land in its own inbox', async () => {
    const r = await dl('ib-confined')
    expect(r.isError).toBeFalsy()
    expect(calls).toEqual([{ dir: inboxOf(), limits: INBOX_LIMITS }])
    expect(r.content[0].text).toContain(inboxOf() + '/')
  })
  test('another session\'s still land in the shared inbox', async () => {
    const r = await dl('ib-plain')
    expect(r.isError).toBeFalsy()
    expect(calls).toEqual([{ dir: INBOX_DIR, limits: undefined }])
  })
  test('with a link as .inbox the tool fails with the cause and nothing is written outside', async () => {
    symlinkSync(OUT, inboxOf())
    const r = await dl('ib-confined')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('not a plain folder')
    expect(readdirSync(OUT)).toEqual(['victim'])
  })
  test('a session its bridge declared write-confined but the daemon has no record of saves nothing', async () => {
    noteDeclaredRestrictions('ib-stray', { writeConfined: true })
    mk('ib-stray')   // a record without a policy
    const r = await dl('ib-stray')
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('no record')
    expect(calls).toEqual([])
  })
})

describe('a file in .inbox attached to a reply (the #739 check)', () => {
  let sent: string[][]
  beforeEach(() => {
    sent = []
    spies.push(spyOn(gateway, 'send').mockImplementation((async (channel: string, _t: string, opts?: { files?: string[] }) => { sent.push((opts?.files ?? []).map(f => readFileSync(f, 'utf8'))); return { id: 'm1', channelId: channel } }) as any))
  })
  const reply = (files: string[]) => executeTool('reply', { chat_id: 'ib-confined-thread', text: 'hi', files }, 'ib-confined')
  test('a file the daemon saved there goes', async () => {
    const { meta } = await buildNotificationPayload(inbound(), 'ib-confined-thread', 'ib-confined')
    expect((await reply([meta.downloaded_files!])).isError).toBeFalsy()
    expect(sent).toEqual([['data']])
  })
  test('a link planted in .inbox that leads out is refused with the one text', async () => {
    mkdirSync(inboxOf(), { mode: 0o700 })
    symlinkSync(join(OUT, 'victim'), join(inboxOf(), 'planted'))
    const r = await reply([join(inboxOf(), 'planted')])
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe(`reply: ${fileRefusal(join(inboxOf(), 'planted'))}`)
    expect(sent).toEqual([])
  })
  test('with .inbox itself a link to a folder outside, a file through it is refused', async () => {
    symlinkSync(OUT, inboxOf())
    expect((await reply([join(inboxOf(), 'victim')])).isError).toBe(true)
    expect(sent).toEqual([])
  })
  test('another specialist\'s .inbox (a denied workdir) is refused', async () => {
    mkdirSync(join(OTHER, INBOX_DIR_NAME), { recursive: true }); writeFileSync(join(OTHER, INBOX_DIR_NAME, 'f'), 'theirs')
    expect((await reply([join(OTHER, INBOX_DIR_NAME, 'f')])).isError).toBe(true)
    expect(sent).toEqual([])
  })
  test('the shared inbox file is refused (the state folder is denied)', async () => {
    mkdirSync(INBOX_DIR, { recursive: true }); writeFileSync(join(INBOX_DIR, 'shared.txt'), 's')
    expect((await reply([join(INBOX_DIR, 'shared.txt')])).isError).toBe(true)
  })
})
