// A file sent to a write-confined specialist is saved in `<workdir>/.inbox`, a folder the daemon makes itself in the specialist's own readable folder.
// The specialist can write there too, so the daemon never trusts what it finds: a link or a plain file where the folder should be is refused, a name is
// never the sender's, an existing name is never overwritten or followed, and a swapped folder is noticed.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { discardInboxFiles, inboxHooks, inboxSafeName, placeInInbox, prepareConfinedInbox, readPlainFile, writeInboxFile } from '../../infra/confined-inbox.js'
import { INBOX_DIR_NAME, INBOX_LIMITS } from '../../config/write-confinement.js'

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'confined-inbox-')))
const WORK = join(ROOT, 'work'), OUT = join(ROOT, 'outside')
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
beforeEach(() => { rmSync(WORK, { recursive: true, force: true }); rmSync(OUT, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true }); mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, 'victim'), 'keep') })
const mode = (p: string) => statSync(p).mode & 0o777
const names = (d: string) => readdirSync(d)

describe('prepareConfinedInbox', () => {
  test('makes <workdir>/.inbox at 0700 and returns it', () => {
    const dir = prepareConfinedInbox(WORK)
    expect(dir).toBe(join(WORK, INBOX_DIR_NAME))
    expect(mode(dir)).toBe(0o700)
  })
  test('a workdir written as a link is resolved: the folder is made in the real one', () => {
    symlinkSync(WORK, join(ROOT, 'work-link'))
    try { expect(prepareConfinedInbox(join(ROOT, 'work-link'))).toBe(join(WORK, INBOX_DIR_NAME)) } finally { rmSync(join(ROOT, 'work-link')) }
  })
  test('an existing folder left at 0755 is brought to 0700', () => {
    mkdirSync(join(WORK, INBOX_DIR_NAME), { mode: 0o755 })
    expect(mode(prepareConfinedInbox(WORK))).toBe(0o700)
  })
  test('a link where the folder should be is refused, and nothing is made or written through it', () => {
    symlinkSync(OUT, join(WORK, INBOX_DIR_NAME))
    expect(() => prepareConfinedInbox(WORK)).toThrow(/not a plain folder/)
    expect(names(OUT)).toEqual(['victim'])
    expect(mode(OUT)).not.toBe(0o700 + 0) // the link's target was not chmod'ed
  })
  test('a plain file where the folder should be is refused', () => {
    writeFileSync(join(WORK, INBOX_DIR_NAME), 'x')
    expect(() => prepareConfinedInbox(WORK)).toThrow(/not a plain folder/)
    expect(readFileSync(join(WORK, INBOX_DIR_NAME), 'utf8')).toBe('x')
  })
  test('a workdir that does not exist is refused, not made', () => {
    expect(() => prepareConfinedInbox(join(ROOT, 'nope'))).toThrow()
    expect(existsSync(join(ROOT, 'nope'))).toBe(false)
  })
})

describe('writeInboxFile', () => {
  const limits = INBOX_LIMITS
  test('writes a 0600 file with the bytes, named by the daemon: a stamp, a random part and the sanitized name', () => {
    const dir = prepareConfinedInbox(WORK)
    const p = writeInboxFile(dir, 'report.pdf', Buffer.from('hello'), limits)
    expect(p.startsWith(dir + '/')).toBe(true)
    expect(p).toMatch(/\/\d+-[0-9a-f]+-report\.pdf$/)
    expect(readFileSync(p, 'utf8')).toBe('hello')
    expect(mode(p)).toBe(0o600)
  })
  test('the sender\'s name never leaves the folder or breaks a line: path pieces, dots, newlines and brackets are neutralised', () => {
    const dir = prepareConfinedInbox(WORK)
    for (const evil of ['../../outside/victim', '/etc/passwd', '..', '.', '.bashrc', 'a\nb;c[d].txt', '', 'x'.repeat(500) + '.pdf']) {
      const p = writeInboxFile(dir, evil, Buffer.from('z'), limits)
      expect(realpathSync(join(p, '..'))).toBe(dir)
      expect(p.split('/').pop()).not.toMatch(/[\n;[\]/]|^\./)
      expect(p.split('/').pop()!.length).toBeLessThan(260)
    }
    expect(readFileSync(join(OUT, 'victim'), 'utf8')).toBe('keep')
  })
  test('the same name twice gives two files', () => {
    const dir = prepareConfinedInbox(WORK)
    const a = writeInboxFile(dir, 'a.txt', Buffer.from('1'), limits), b = writeInboxFile(dir, 'a.txt', Buffer.from('2'), limits)
    expect(a).not.toBe(b)
    expect([readFileSync(a, 'utf8'), readFileSync(b, 'utf8')]).toEqual(['1', '2'])
  })
  test('a file or link the session planted at the very name chosen is neither overwritten nor followed: the next name is used', () => {
    const dir = prepareConfinedInbox(WORK)
    const saved = inboxHooks.rand, stamp = inboxHooks.stamp
    const seq = ['aaaa', 'aaaa', 'bbbb']; let i = 0
    inboxHooks.rand = () => seq[Math.min(i++, seq.length - 1)]!
    inboxHooks.stamp = () => '1'
    try {
      symlinkSync(join(OUT, 'victim'), join(dir, '1-aaaa-a.txt'))       // a link at the predicted name
      const p = writeInboxFile(dir, 'a.txt', Buffer.from('new'), limits)
      expect(p).toBe(join(dir, '1-bbbb-a.txt'))
      expect(readFileSync(join(OUT, 'victim'), 'utf8')).toBe('keep')
      expect(lstatSync(join(dir, '1-aaaa-a.txt')).isSymbolicLink()).toBe(true)
    } finally { inboxHooks.rand = saved; inboxHooks.stamp = stamp }
  })
  test('a dangling link at the chosen name is not written through either', () => {
    const dir = prepareConfinedInbox(WORK)
    const saved = inboxHooks.rand, stamp = inboxHooks.stamp
    let i = 0; inboxHooks.rand = () => (i++ === 0 ? 'cccc' : 'dddd'); inboxHooks.stamp = () => '2'
    try {
      symlinkSync(join(OUT, 'not-yet'), join(dir, '2-cccc-a.txt'))
      writeInboxFile(dir, 'a.txt', Buffer.from('new'), limits)
      expect(existsSync(join(OUT, 'not-yet'))).toBe(false)
    } finally { inboxHooks.rand = saved; inboxHooks.stamp = stamp }
  })
  test('a file over the attachment limit is refused and leaves nothing', () => {
    const dir = prepareConfinedInbox(WORK)
    expect(() => writeInboxFile(dir, 'big', Buffer.alloc(11), { ...limits, maxFileBytes: 10 })).toThrow(/too large/)
    expect(names(dir)).toEqual([])
  })
  test('a full folder (file count) refuses the next file and says what to do', () => {
    const dir = prepareConfinedInbox(WORK)
    for (let n = 0; n < 3; n++) writeInboxFile(dir, `f${n}`, Buffer.from('x'), { ...limits, maxFiles: 3 })
    expect(() => writeInboxFile(dir, 'f3', Buffer.from('x'), { ...limits, maxFiles: 3 })).toThrow(/\.inbox is full/)
    expect(names(dir).length).toBe(3)
  })
  test('a full folder (total bytes) refuses the next file', () => {
    const dir = prepareConfinedInbox(WORK)
    writeInboxFile(dir, 'a', Buffer.alloc(6), { ...limits, maxTotalBytes: 10 })
    expect(() => writeInboxFile(dir, 'b', Buffer.alloc(6), { ...limits, maxTotalBytes: 10 })).toThrow(/full/)
  })
  test('a folder swapped for a link after it was prepared is noticed before any byte is written, and nothing lands outside', () => {
    const dir = prepareConfinedInbox(WORK)
    rmSync(dir, { recursive: true }); symlinkSync(OUT, dir)
    expect(() => writeInboxFile(dir, 'a.txt', Buffer.from('x'), limits)).toThrow()
    expect(names(OUT)).toEqual(['victim'])
  })
  test('a swapped folder is refused before the open, not only undone after it: the message says so even when the place swapped to cannot be written', () => {
    const dir = prepareConfinedInbox(WORK)
    rmSync(dir, { recursive: true }); symlinkSync(OUT, dir)
    chmodSync(OUT, 0o500)
    try { expect(() => writeInboxFile(dir, 'a.txt', Buffer.from('x'), limits)).toThrow(/no longer leads to itself/) } finally { chmodSync(OUT, 0o700) }
  })
  const swapOut = (dir: string) => { renameSync(dir, `${dir}-moved`); symlinkSync(OUT, dir) }
  const swapBack = (dir: string) => { rmSync(dir); renameSync(`${dir}-moved`, dir) }
  const withHook = (name: 'beforeCreate' | 'afterCreate' | 'afterCheck' | 'beforeOpenDir', fn: () => void, run: () => void) => {
    const saved = inboxHooks[name]
    inboxHooks[name] = () => { inboxHooks[name] = saved; fn() }
    try { run() } finally { inboxHooks[name] = saved }
  }
  test('the folder is swapped for a link just before the file is created: the file lands outside empty, is found to be, and is removed; the bytes were never written', () => {
    const dir = prepareConfinedInbox(WORK)
    withHook('beforeCreate', () => swapOut(dir), () => expect(() => writeInboxFile(dir, 'a.txt', Buffer.from('x'), limits)).toThrow(/replaced/))
    expect(names(OUT)).toEqual(['victim'])
  })
  test('swapped out and straight back around the create (the residual): one EMPTY file with a neutral extension stays outside, never the sender\'s bytes, and the write is refused', () => {
    const dir = prepareConfinedInbox(WORK)
    let swapped = false
    withHook('beforeCreate', () => { swapOut(dir); swapped = true }, () =>
      withHook('afterCreate', () => swapBack(dir), () => expect(() => writeInboxFile(dir, 'evil.plist', Buffer.from('<plist>payload</plist>'), limits)).toThrow(/replaced/)))
    expect(swapped).toBe(true)
    const left = names(OUT).filter(n => n !== 'victim')
    expect(left.length).toBe(1)
    expect(left[0]).toMatch(/-evil_plist\.dat$/)
    expect(statSync(join(OUT, left[0]!)).size).toBe(0)
    expect(names(dir)).toEqual([])
  })
  test('hard-link variant: the folder is swapped out for the create, restored, and the new file hard-linked into the real folder before the check: refused, and not one byte is written', () => {
    const dir = prepareConfinedInbox(WORK)
    withHook('beforeCreate', () => swapOut(dir), () =>
      withHook('afterCreate', () => {
        const f = readdirSync(OUT).find(n => n !== 'victim')!
        swapBack(dir); linkSync(join(OUT, f), join(dir, f))
      }, () => expect(() => writeInboxFile(dir, 'a.txt', Buffer.from('SENDER-BYTES'), limits)).toThrow(/replaced/)))
    const left = names(OUT).filter(n => n !== 'victim')
    expect(left.length).toBe(1)
    expect(readFileSync(join(OUT, left[0]!), 'utf8')).toBe('')
    expect(names(dir)).toEqual([])
  })
  test('a failed write (disk full) leaves no empty or partial file to count toward the cap', () => {
    const dir = prepareConfinedInbox(WORK)
    const saved = inboxHooks.write
    inboxHooks.write = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) }
    try { expect(() => writeInboxFile(dir, 'a.txt', Buffer.from('x'), limits)).toThrow(/ENOSPC/) } finally { inboxHooks.write = saved }
    expect(names(dir)).toEqual([])
  })
  test('a partial write is continued until every byte is in', () => {
    const dir = prepareConfinedInbox(WORK)
    const saved = inboxHooks.write
    inboxHooks.write = (fd, data, at) => writeSync(fd, data, at, Math.min(3, data.length - at))
    let p = ''
    try { p = writeInboxFile(dir, 'a.txt', Buffer.from('0123456789'), limits) } finally { inboxHooks.write = saved }
    expect(readFileSync(p, 'utf8')).toBe('0123456789')
  })
  test('the folder is swapped after the check: the bytes still go into the file that was checked, in the real folder, and nothing is written outside', () => {
    const dir = prepareConfinedInbox(WORK)
    let p = ''
    withHook('afterCheck', () => swapOut(dir), () => { p = writeInboxFile(dir, 'a.txt', Buffer.from('payload'), limits) })
    expect(names(OUT)).toEqual(['victim'])
    expect(readFileSync(join(`${dir}-moved`, p.split('/').pop()!), 'utf8')).toBe('payload')
  })
  test('the name is replaced by another file between the create and the check: refused, and that other file is not removed', () => {
    const dir = prepareConfinedInbox(WORK)
    withHook('afterCreate', () => {
      const f = readdirSync(dir)[0]!
      rmSync(join(dir, f)); writeFileSync(join(dir, f), 'someone else')
    }, () => expect(() => writeInboxFile(dir, 'a.txt', Buffer.from('x'), limits)).toThrow(/replaced/))
    const f = readdirSync(dir)
    expect(f.length).toBe(1)
    expect(readFileSync(join(dir, f[0]!), 'utf8')).toBe('someone else')
  })
  test('the folder is replaced by another real folder between the check of it and its open: refused', () => {
    mkdirSync(join(WORK, INBOX_DIR_NAME), { mode: 0o700 })
    // The old folder is moved aside, not removed: a freed inode number is reused at once on Linux (the CI runner), and the new folder would then compare equal.
    withHook('beforeOpenDir', () => { renameSync(join(WORK, INBOX_DIR_NAME), join(WORK, 'inbox-aside')); mkdirSync(join(WORK, INBOX_DIR_NAME), { mode: 0o755 }) }, () => expect(() => prepareConfinedInbox(WORK)).toThrow(/changed while/))
  })
  test('without limits (the shared inbox) it creates the folder and still never overwrites or follows', () => {
    const shared = join(ROOT, 'shared-inbox')
    const a = writeInboxFile(shared, 'a.txt', Buffer.from('1')), b = writeInboxFile(shared, 'a.txt', Buffer.from('2'))
    expect(a).not.toBe(b)
    expect(names(shared).length).toBe(2)
  })
})

describe('placeInInbox (a file the daemon already holds, copied in)', () => {
  test('copies the bytes under a safe name and returns the new path', () => {
    const src = join(ROOT, 'downloaded.pdf'); writeFileSync(src, 'pdf-bytes')
    const p = placeInInbox(WORK, src, 'inv oice.pdf')
    expect(p.startsWith(join(WORK, INBOX_DIR_NAME) + '/')).toBe(true)
    expect(readFileSync(p, 'utf8')).toBe('pdf-bytes')
    expect(readFileSync(src, 'utf8')).toBe('pdf-bytes')
  })
  test('a link as .inbox refuses the copy and writes nothing outside', () => {
    const src = join(ROOT, 'downloaded.pdf'); writeFileSync(src, 'pdf-bytes')
    symlinkSync(OUT, join(WORK, INBOX_DIR_NAME))
    expect(() => placeInInbox(WORK, src, 'a.pdf')).toThrow()
    expect(names(OUT)).toEqual(['victim'])
  })
})

describe('inboxSafeName: an extension something might act on is not kept', () => {
  test.each([
    ['report.pdf', 'report.pdf'], ['Photo.JPG', 'Photo.JPG'], ['notes.tar.zst', 'notes.tar_zst.dat'], ['notes.tar.gz', 'notes.tar.gz'], ['q.sql', 'q.sql'], ['s.py', 's.py'], ['x.toml', 'x.toml'], ['p.tiff', 'p.tiff'], ['.', 'file.dat'], ['...', 'file.dat'], ['voice.amr', 'voice.amr'], ['evil.plist', 'evil_plist.dat'], ['x.workflow', 'x_workflow.dat'],
    ['a.desktop', 'a_desktop.dat'], ['run.sh', 'run_sh.dat'], ['Makefile', 'Makefile.dat'], ['a.', 'a_.dat'], ['.plist', 'plist.dat'], ['x.PLIST', 'x_PLIST.dat'],
  ])('%s -> %s', (raw, want) => { expect(inboxSafeName(raw, true)).toBe(want) })
  test('without neutralising (the shared inbox) the sender\'s extension and the lack of one are kept', () => {
    for (const n of ['script.py', 'q.sql', 'x.toml', 'x.tar.gz', 'photo.tiff', 'README', 'evil.plist', 'v.amr']) expect(inboxSafeName(n)).toBe(n)
    expect(inboxSafeName('.')).toBe('file'); expect(inboxSafeName('../../x/y z.txt')).toBe('_.._x_y_z.txt')
  })
  test('a long name keeps its (neutral) extension and stays under the cap', () => {
    const n = inboxSafeName('x'.repeat(300) + '.pdf', true)
    expect(n.length).toBeLessThanOrEqual(100); expect(n.endsWith('.pdf')).toBe(true)
  })
  test('in the shared inbox (no limits) the file keeps its name: evil.plist stays, with the stamp and random part', () => {
    expect(writeInboxFile(join(ROOT, 'shared-names'), 'evil.plist', Buffer.from('x')).endsWith('-evil.plist')).toBe(true)
  })
  test('the file written for evil.plist ends in .dat', () => {
    const p = writeInboxFile(prepareConfinedInbox(WORK), 'evil.plist', Buffer.from('x'), INBOX_LIMITS)
    expect(p.endsWith('-evil_plist.dat')).toBe(true)
  })
})

describe('readPlainFile and discardInboxFiles', () => {
  test('a plain file is read; a link, a second name, a folder, and a file over the cap are refused', () => {
    const f = join(ROOT, 'plain'); writeFileSync(f, 'abc')
    expect(readPlainFile(f, 10).toString()).toBe('abc')
    symlinkSync(f, join(ROOT, 'lnk')); expect(() => readPlainFile(join(ROOT, 'lnk'), 10)).toThrow()
    linkSync(f, join(ROOT, 'second-name')); expect(() => readPlainFile(f, 10)).toThrow(/one name/)
    expect(() => readPlainFile(ROOT, 10)).toThrow()
    const g = join(ROOT, 'big'); writeFileSync(g, 'abcdefghijk'); expect(() => readPlainFile(g, 10)).toThrow(/over/)
  })
  test('discardInboxFiles removes the named files and ignores one already gone', () => {
    const dir = prepareConfinedInbox(WORK)
    const a = writeInboxFile(dir, 'a.txt', Buffer.from('1'), INBOX_LIMITS), b = writeInboxFile(dir, 'b.txt', Buffer.from('2'), INBOX_LIMITS)
    rmSync(b)
    discardInboxFiles([a, b])
    expect(names(dir)).toEqual([])
  })
})
