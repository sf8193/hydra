// A write-confined specialist cannot read a file its tools are denied, and the bridge runs outside that sandbox: so the daemon refuses, in the tool
// result, any `files` path it could not read itself, opens what it decided on once, and posts a copy it owns, never the session's path.
// Other sessions are unchanged.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeTool } from '../../app/bridge-dispatch.js'
import * as access from '../../sessions/access.js'
import { gateway, STATE_DIR } from '../../infra/config.js'
import { registry } from '../../sessions/registry.js'
import { transport } from '../../sessions/bridge-transport.js'
import { confinementIdFor } from '../../shared/launch-policy.js'
import { confinedTemp, fileArgTools, snapshotHooks } from '../../engines/write-confinement.js'
import { noteDeclaredRestrictions } from '../../sessions/tool-surface.js'
import { fileRefusal } from '../../config/write-confinement.js'
import { MAX_ATTACHMENT_BYTES } from '../../shared/constants.js'
import { setHydra } from './test-hydra.js'

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'wc-dispatch-')))
const WORK = join(ROOT, 'work'), REALTMP = join(ROOT, 'real-tmp'), TMPLINK = join(ROOT, 'tmp-link'), SECRET = join(ROOT, 'secret'), STATE = join(ROOT, 'state')
for (const d of [WORK, REALTMP, SECRET, STATE]) mkdirSync(d, { recursive: true })
symlinkSync(REALTMP, TMPLINK)   // the session's temp as written down is a link: not pre-resolved
writeFileSync(join(WORK, 'a.txt'), 'a'); writeFileSync(join(REALTMP, 't.txt'), 't'); writeFileSync(join(SECRET, 'x'), 'secret-bytes'); writeFileSync(join(STATE, 'cfg'), 'c')
symlinkSync(join(SECRET, 'x'), join(WORK, 'link')); symlinkSync(join(WORK, 'a.txt'), join(WORK, 'inside'))
const savedTemp = confinedTemp.dir
confinedTemp.dir = () => TMPLINK
afterAll(() => { confinedTemp.dir = savedTemp; rmSync(ROOT, { recursive: true, force: true }) })

type Sent = { channel: string; files?: string[]; bytes?: string[] }
const sends: Sent[] = []
const stderr = process.stderr.write
let spies: { mockRestore(): void }[] = []
const policy = () => { const w = { workdir: WORK, denyCommands: [], cannotRead: [STATE], servers: [] }; return { specialist: 'ops', restricted: false, canOnlyWriteTo: w, id: confinementIdFor(w) } }
const mk = (id: string, extra: Record<string, unknown> = {}) => registry.set(id, {
  sessionId: id, tmuxName: id, topic: '', threadId: `${id}-thread`, createdAt: Date.now(), lastActive: Date.now(), listening: false, engine: 'claude',
  adapter: { stop: async () => {}, isAlive: () => true, isConnected: () => false }, sessionType: 'thread_owner', specialist: 'ops', ...extra,
} as any)
const inboxCopies = () => { const d = join(STATE_DIR, 'inbox'); return existsSync(d) ? readdirSync(d).filter(f => f.startsWith('confined-send-')) : [] }

beforeEach(() => {
  sends.length = 0
  process.stderr.write = (() => true) as any
  ;(transport as any).sendOrQueue = () => {}
  spies = [
    // The gateway reads the files it is given at send time, as a real one does: what it read is what was posted.
    spyOn(gateway, 'send').mockImplementation((async (channel: string, _t: string, opts?: { files?: string[] }) => {
      sends.push({ channel, ...(opts?.files ? { files: opts.files, bytes: opts.files.map(f => readFileSync(f, 'utf8')) } : {}) }); return { id: 'm1', channelId: channel }
    }) as any),
    spyOn(gateway, 'fetchChannel').mockImplementation((async (id: string) => ({ id, isThread: true, parentId: 'wc-parent' })) as any),
    setHydra({ operators: ['u1'], channels: { 'wc-parent': {} } }),
  ]
  mk('wc-confined', { policy: policy(), verified: true })
  mk('wc-plain')
})
afterEach(() => {
  process.stderr.write = stderr
  snapshotHooks.beforeOpen = () => {}
  snapshotHooks.afterStat = () => {}
  for (const s of spies) s.mockRestore()
  for (const id of ['wc-confined', 'wc-plain', 'wc-stray']) registry.delete(id)
})

const reply = (files: unknown, id = 'wc-confined') => executeTool('reply', { chat_id: `${id}-thread`, text: 'hi', files }, id)

describe('reply from a write-confined session', () => {
  test('a file in its folder goes: a copy with the same bytes, which is removed once the send has settled', async () => {
    const r = await reply([join(WORK, 'a.txt')])
    expect(r.isError).toBeFalsy()
    expect(sends.at(-1)!.bytes).toEqual(['a'])
    expect(sends.at(-1)!.files![0]).not.toBe(join(WORK, 'a.txt'))
    expect(sends.at(-1)!.files![0].endsWith('a.txt')).toBe(true)
    expect(inboxCopies()).toEqual([])
  })
  test('a file in its temp folder goes, though the temp folder is written down as a link (not pre-resolved)', async () => {
    expect((await reply([join(TMPLINK, 't.txt')])).isError).toBeFalsy()
    expect(sends.at(-1)!.bytes).toEqual(['t'])
    expect((await reply([join(REALTMP, 't.txt')])).isError).toBeFalsy()
  })
  test('a file in the daemon\'s own temp folder is not in its temp: refused', async () => {
    const dflt = join(realpathSync(tmpdir()), `wc-daemon-tmp-${process.pid}.txt`)
    writeFileSync(dflt, 'd')
    try { expect((await reply([dflt])).isError).toBe(true) } finally { rmSync(dflt, { force: true }) }
  })
  test('a link inside its folder to a file inside it goes with that file\'s bytes', async () => {
    expect((await reply([join(WORK, 'inside')])).isError).toBeFalsy()
    expect(sends.at(-1)!.bytes).toEqual(['a'])
  })
  test.each([
    ['a file outside its folder (the live repro)', () => join(SECRET, 'x')],
    ['a symlink in its folder that leads out', () => join(WORK, 'link')],
    ['a path that is not there', () => join(WORK, 'nope')],
    ['a folder', () => WORK],
    ['`..` out of its folder', () => '../secret/x'],
  ])('%s is refused with the one text, and nothing is sent', async (_n, path) => {
    const p = path()
    const r = await reply([p])
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe(`reply: ${fileRefusal(p)}`)
    expect(sends).toEqual([])
    expect(inboxCopies()).toEqual([])
  })
  test('one bad file among good ones refuses the whole send and leaves no copy', async () => {
    expect((await reply([join(WORK, 'a.txt'), join(SECRET, 'x')])).isError).toBe(true)
    expect(sends).toEqual([])
    expect(inboxCopies()).toEqual([])
  })
  test('a place the layer denies is refused', async () => {
    const dflt = confinedTemp.dir
    confinedTemp.dir = () => ROOT
    try { expect((await reply([join(STATE, 'cfg')])).isError).toBe(true) } finally { confinedTemp.dir = dflt }
    expect(sends).toEqual([])
  })
  test.each([['a string', join(WORK, 'a.txt')], ['an object', { 0: join(SECRET, 'x') }], ['a number', 7], ['null', null]])('files that is %s, not an array, is refused (not read as characters)', async (_n, files) => {
    const r = await reply(files)
    expect(r.isError).toBe(true)
    expect(sends).toEqual([])
  })
  test('an element that is not a string is refused', async () => {
    expect((await reply([7])).isError).toBe(true)
    expect(sends).toEqual([])
  })
  test('an empty files list is a plain reply', async () => {
    expect((await reply([])).isError).toBeFalsy()
  })
  test('a session without write confinement attaches what it did before, path and all', async () => {
    const r = await reply([join(SECRET, 'x')], 'wc-plain')
    expect(r.isError).toBeFalsy()
    expect(sends.at(-1)!.files).toEqual([join(SECRET, 'x')])
  })
})

describe('a swap between the check and the send', () => {
  test('the file replaced by a link to a secret after the decision: refused, and no secret byte is posted', async () => {
    snapshotHooks.beforeOpen = path => { rmSync(path); symlinkSync(join(SECRET, 'x'), path) }
    writeFileSync(join(WORK, 'swap.txt'), 'harmless')
    const r = await reply([join(WORK, 'swap.txt')])
    expect(r.isError).toBe(true)
    expect(JSON.stringify(sends)).not.toContain('secret-bytes')
    expect(sends).toEqual([])
  })
  test('a folder of the path replaced by a link out after the decision: refused', async () => {
    mkdirSync(join(WORK, 'sub'), { recursive: true }); writeFileSync(join(WORK, 'sub', 'f.txt'), 'harmless'); writeFileSync(join(SECRET, 'f.txt'), 'secret-bytes')
    snapshotHooks.beforeOpen = () => { renameSync(join(WORK, 'sub'), join(WORK, 'sub-moved')); symlinkSync(SECRET, join(WORK, 'sub')) }
    const r = await reply([join(WORK, 'sub', 'f.txt')])
    rmSync(join(WORK, 'sub'), { force: true }); rmSync(join(WORK, 'sub-moved'), { recursive: true, force: true })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(sends)).not.toContain('secret-bytes')
  })
  test('the file changed on disk after the send was read is not what is posted: the copy is', async () => {
    writeFileSync(join(WORK, 'later.txt'), 'before')
    spies.push(spyOn(gateway, 'send').mockImplementation((async (channel: string, _t: string, opts?: { files?: string[] }) => {
      writeFileSync(join(WORK, 'later.txt'), 'after')   // the session's shell rewrites its own file while the gateway is sending
      sends.push({ channel, bytes: (opts?.files ?? []).map(f => readFileSync(f, 'utf8')) }); return { id: 'm', channelId: channel }
    }) as any))
    await reply([join(WORK, 'later.txt')])
    expect(sends.at(-1)!.bytes).toEqual(['before'])
  })
})

describe('a write-confined session known only by its bridge', () => {
  test('a bridge that declared write confinement, whose record is gone, attaches nothing and holds no orchestration tool', async () => {
    noteDeclaredRestrictions('wc-stray', { writeConfined: true })
    for (const t of ['spawn_session', 'kill_session', 'peek_session', 'send_to_thread', 'handoff', 'list_sessions']) {
      const r = await executeTool(t, { target: 'x', type: 'result', text: 't', chat_id: 'c', topic: 't' }, 'wc-stray')
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toContain('write-confined')
    }
    const r = await executeTool('reply', { chat_id: 'wc-stray-thread', text: 'hi', files: [join(WORK, 'a.txt')] }, 'wc-stray')
    expect(r.isError).toBe(true)
    expect(sends).toEqual([])
  })
})

describe('a file with more than one name', () => {
  test('a hardlink in its folder to a file outside it is refused (nlink > 1): its path alone cannot tell it from the file', async () => {
    const link = join(WORK, 'hard.txt')
    linkSync(join(SECRET, 'x'), link)
    const r = await reply([link])
    rmSync(link)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe(`reply: ${fileRefusal(link)}`)
    expect(JSON.stringify(sends)).not.toContain('secret-bytes')
    expect(inboxCopies()).toEqual([])
  })
  test('the same file with one name goes', async () => {
    expect((await reply([join(WORK, 'a.txt')])).isError).toBeFalsy()
  })
})

describe('size', () => {
  test('a file over the attachment limit is refused before any byte is read, and leaves no copy', async () => {
    const big = join(WORK, 'big.bin'); writeFileSync(big, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1))
    const r = await reply([big])
    rmSync(big)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe(`reply: ${fileRefusal(big)}`)
    expect(sends).toEqual([])
    expect(inboxCopies()).toEqual([])
  })
  test('a file at the limit goes', async () => {
    const edge = join(WORK, 'edge.bin'); writeFileSync(edge, Buffer.alloc(MAX_ATTACHMENT_BYTES))
    const r = await reply([edge])
    rmSync(edge)
    expect(r.isError).toBeFalsy()
  })
  test('a file that grows past the limit after its size was read is cut off: refused, no copy left', async () => {
    const grow = join(WORK, 'grow.bin'); writeFileSync(grow, 'small')
    snapshotHooks.afterStat = () => { appendFileSync(grow, Buffer.alloc(MAX_ATTACHMENT_BYTES + 10)) }
    const r = await reply([grow])
    rmSync(grow)
    expect(r.isError).toBe(true)
    expect(sends).toEqual([])
    expect(inboxCopies()).toEqual([])
  })
})

describe('the session\'s temp folder', () => {
  test('is the one the sandbox gives its Bash (TMPDIR=/tmp/claude-<uid>, measured live), not the daemon\'s own tmpdir()', () => {
    expect(savedTemp()).toBe(`/tmp/claude-${process.getuid!()}`)
    expect(savedTemp()).not.toBe(tmpdir())
  })
})

describe('which tools are checked', () => {
  test('every tool it holds that takes files, derived from the schemas', () => {
    expect(fileArgTools()).toEqual(['reply'])
  })
})
