import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkUploads, uploadLine, uploadSlackFiles } from '../files.js'

/** A bot client that records each files.uploadV2 call and refuses the files named in `refuse` with Slack's error. */
const client = (refuse: Record<string, string> = {}) => {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    files: { uploadV2: async (a: Record<string, unknown>) => { calls.push(a); const e = refuse[a.filename as string]; if (e) throw new Error(e); return { ok: true } } },
  }
}

describe('a reply\'s files into Slack', () => {
  test('each file goes through files.uploadV2 into the thread; one that fails says why and the rest still go', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slack-files-'))
    try {
      const a = join(dir, 'a.pdf'), b = join(dir, 'b.png'), c = join(dir, 'c.txt')
      writeFileSync(a, '%PDF'); writeFileSync(b, 'png!'); writeFileSync(c, 'text')
      const fake = client({ 'b.png': 'An API error occurred: missing_scope\nmore detail' })
      const r = await uploadSlackFiles(fake as never, 'C1', '9.000001', checkUploads([a, b, c]))
      expect(fake.calls.map(x => [x.channel_id, x.thread_ts, x.filename, String(x.file)])).toEqual([['C1', '9.000001', 'a.pdf', '%PDF'], ['C1', '9.000001', 'b.png', 'png!'], ['C1', '9.000001', 'c.txt', 'text']])
      expect(r).toEqual({ shared: ['a.pdf', 'c.txt'], failed: [{ name: 'b.png', why: 'An API error occurred: missing_scope (the app needs the files:write bot scope)' }] })
      expect(uploadLine(r)).toBe('attached 2 files (a.pdf, c.txt); b.png did not attach: An API error occurred: missing_scope (the app needs the files:write bot scope)')
      // At the top level of a conversation (a DM's), no thread_ts at all.
      const top = client()
      await uploadSlackFiles(top as never, 'D1', undefined, checkUploads([a]))
      expect('thread_ts' in top.calls[0]!).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a file over the attachment limit is refused before anything posts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slack-files-'))
    try {
      const big = join(dir, 'big.bin')
      writeFileSync(big, Buffer.alloc(25 * 1024 * 1024 + 1))
      expect(() => checkUploads([big])).toThrow('nothing was posted: ' + big + ' is 25.0 MB, over the 25 MB a Slack reply may attach')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
