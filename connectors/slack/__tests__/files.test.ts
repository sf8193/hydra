import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATE_DIR } from '../../../infra/config.js'
import { checkUploads, uploadLine, uploadSlackFiles } from '../files.js'

/** A bot client that records each files.uploadV2 call and refuses the files named in `refuse` with that error. */
const client = (refuse: Record<string, string> = {}) => {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    files: { uploadV2: async (a: Record<string, unknown>) => { calls.push(a); const e = refuse[a.filename as string]; if (e) throw new Error(e); return { ok: true } } },
  }
}

const inDir = async (fn: (dir: string) => unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-files-'))
  try { await fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('a reply\'s files into Slack', () => {
  test('each file goes through files.uploadV2 into the thread; one that fails says why and the rest still go', () => inDir(async dir => {
    const a = join(dir, 'a.pdf'), b = join(dir, 'b.png'), c = join(dir, 'c.txt')
    writeFileSync(a, '%PDF'); writeFileSync(b, 'png!'); writeFileSync(c, 'text')
    const fake = client({ 'b.png': 'An API error occurred: missing_scope\nmore detail' })
    const r = await uploadSlackFiles(fake as never, 'C1', '9.000001', checkUploads([a, b, c]))
    expect(fake.calls.map(x => [x.channel_id, x.thread_ts, x.filename, String(x.file)])).toEqual([['C1', '9.000001', 'a.pdf', '%PDF'], ['C1', '9.000001', 'b.png', 'png!'], ['C1', '9.000001', 'c.txt', 'text']])
    expect(r).toEqual({ shared: ['a.pdf', 'c.txt'], failed: [{ name: 'b.png', why: 'An API error occurred: missing_scope (the app needs the files:write bot scope)', unknown: false }] })
    expect(uploadLine(r)).toBe('attached 2 files (a.pdf, c.txt); b.png did not attach: An API error occurred: missing_scope (the app needs the files:write bot scope)')
    // At the top level of a conversation (a DM's), no thread_ts at all.
    const top = client()
    await uploadSlackFiles(top as never, 'D1', undefined, checkUploads([a]))
    expect('thread_ts' in top.calls[0]!).toBe(false)
  }))

  test('a failure Slack gave no clear answer for (a timeout, a 5xx) may have shared the file: said so, never "did not attach"', () => inDir(async dir => {
    const a = join(dir, 'a.pdf'), b = join(dir, 'b.pdf'), c = join(dir, 'c.pdf')
    writeFileSync(a, '1'); writeFileSync(b, '2'); writeFileSync(c, '3')
    const fake = client({ 'a.pdf': 'A request error occurred: timeout of 120000ms exceeded', 'b.pdf': 'An API error occurred: fatal_error', 'c.pdf': 'An API error occurred: invalid_channel' })
    const r = await uploadSlackFiles(fake as never, 'C1', '9.000001', checkUploads([a, b, c]))
    expect(r.failed.map(f => [f.name, f.unknown])).toEqual([['a.pdf', true], ['b.pdf', true], ['c.pdf', false]])
    expect(uploadLine(r)).toBe('a.pdf may have attached (no clear answer from Slack: A request error occurred: timeout of 120000ms exceeded); check before resending it; b.pdf may have attached (no clear answer from Slack: An API error occurred: fatal_error); check before resending it; c.pdf did not attach: An API error occurred: invalid_channel')
  }))

  test('a file is checked again as it is read: one swapped for a link into hydra\'s state since its check is not sent', () => inDir(async dir => {
    const a = join(dir, 'a.txt')
    writeFileSync(a, 'fine')
    const checked = checkUploads([a])
    const state = join(STATE_DIR, 'files-test-state.json')
    writeFileSync(state, '{"secret":1}')
    try {
      unlinkSync(a); symlinkSync(state, a)
      const fake = client()
      const r = await uploadSlackFiles(fake as never, 'C1', undefined, checked)
      expect(fake.calls).toEqual([])
      expect(r).toEqual({ shared: [], failed: [{ name: 'a.txt', why: `refusing to send channel state: ${a}`, unknown: false }] })
    } finally { rmSync(state, { force: true }) }
  }))

  test('checked before anything posts: too many, too large, relative, a folder, missing', () => inDir(dir => {
    const big = join(dir, 'big.bin'), ok = join(dir, 'ok.txt')
    writeFileSync(big, Buffer.alloc(25 * 1024 * 1024 + 1)); writeFileSync(ok, 'x')
    expect(() => checkUploads([big])).toThrow(`nothing was posted: file too large: ${big} (25.0MB, max 25MB)`)
    expect(() => checkUploads(Array(11).fill(ok))).toThrow('nothing was posted: max 10 attachments per message')
    expect(() => checkUploads(['ok.txt'])).toThrow('nothing was posted: ok.txt is not an absolute path')
    expect(() => checkUploads([dir])).toThrow(`nothing was posted: ${dir} is not a file`)
    expect(() => checkUploads([join(dir, 'gone')])).toThrow('nothing was posted: ENOENT')
    expect(checkUploads(Array(10).fill(ok))).toHaveLength(10)
  }))
})
