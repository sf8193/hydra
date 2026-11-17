// What a write-confined session may attach with a bridge tool's `files`: only a file its own tools can read (its folder or the temp folder), never one in
// the places its tools are denied, judged on the path as it resolves.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, linkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileRefusal, fileSendDecision } from '../write-confinement.js'

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'wc-files-')))
const WORK = join(ROOT, 'work'), TMP = join(ROOT, 'tmp'), SECRET = join(ROOT, 'secret'), STATE = join(ROOT, 'state'), OTHER = join(ROOT, 'other-workdir')
for (const d of [WORK, TMP, SECRET, STATE, OTHER]) mkdirSync(d, { recursive: true })
writeFileSync(join(WORK, 'a.txt'), 'a'); writeFileSync(join(TMP, 't.txt'), 't'); writeFileSync(join(SECRET, 'x'), 'x'); writeFileSync(join(STATE, 'cfg'), 'c'); writeFileSync(join(OTHER, 'o'), 'o')
symlinkSync(SECRET, join(WORK, 'link-dir')); symlinkSync(join(SECRET, 'x'), join(WORK, 'link-file'))
symlinkSync(join(WORK, 'a.txt'), join(WORK, 'inside-link'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const env = { workdir: WORK, tmpDir: TMP, deny: [STATE, OTHER], realpath: (p: string) => realpathSync(p) }
const ok = (p: string) => { const d = fileSendDecision(p, env); expect(d.refusal).toBeUndefined(); return d.path }
const refused = (p: string, env2 = env) => { const d = fileSendDecision(p, env2); expect(d.refusal).toBe(fileRefusal(p)); return d.refusal! }

describe('fileSendDecision', () => {
  test('a file in the folder, or in the temp folder, goes; the resolved path comes back', () => {
    expect(ok(join(WORK, 'a.txt'))).toBe(join(WORK, 'a.txt'))
    expect(ok(join(TMP, 't.txt'))).toBe(join(TMP, 't.txt'))
  })
  test('a file outside both is refused with the cause (the live repro)', () => {
    expect(refused(join(SECRET, 'x'))).toBeDefined()
  })
  test('a relative path is the folder\'s; `..` out of it is refused', () => {
    expect(ok('a.txt')).toBe(join(WORK, 'a.txt'))
    expect(refused('../secret/x')).toBeDefined()
  })
  test('a symlink inside the folder to a place outside is refused, for the file and for a folder in the path', () => {
    expect(refused(join(WORK, 'link-file'))).toBeDefined()
    expect(refused(join(WORK, 'link-dir', 'x'))).toBeDefined()
  })
  test('a symlink inside the folder to a file inside it goes, as its target', () => {
    expect(ok(join(WORK, 'inside-link'))).toBe(join(WORK, 'a.txt'))
  })
  test('`~` is not expanded: it is a name in the folder, which is not there', () => {
    expect(refused('~/secret/x')).toBeDefined()
  })
  test('a place the layer denies is refused even inside the temp folder', () => {
    expect(refused(join(STATE, 'cfg'), { ...env, tmpDir: ROOT })).toBeDefined()
    expect(refused(join(OTHER, 'o'), { ...env, tmpDir: ROOT })).toBeDefined()
  })
  test('one text for every cause: absent, outside, denied, a link out: the session cannot tell which, and no resolved path is echoed', () => {
    const texts = [join(WORK, 'nope'), join(SECRET, 'x'), join(WORK, 'link-file')].map(p => refused(p).replace(p, '<p>'))
    expect(new Set(texts).size).toBe(1)
    expect(refused(join(WORK, 'link-file'))).not.toContain(join(SECRET, 'x'))
  })
  test('a path that does not exist is refused', () => {
    expect(refused(join(WORK, 'nope'))).toBeDefined()
  })
  test('a hardlink in the folder to a file outside passes (named limit: the path is in the folder; the sandbox is what stops the link being made)', () => {
    linkSync(join(SECRET, 'x'), join(WORK, 'hard'))
    expect(ok(join(WORK, 'hard'))).toBe(join(WORK, 'hard'))
  })
})
