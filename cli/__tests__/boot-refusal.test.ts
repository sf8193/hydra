import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { noteBootRefusal, readBootRefusal } from '../boot-refusal.js'

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('the boot-refusal marker', () => {
  test('the watchdog logs a refusal once, even when the daemon wrote it first, and again when the reason changes', () => {
    dir = mkdtempSync(join(tmpdir(), 'boot-refusal-'))
    expect(readBootRefusal(dir)).toBeUndefined()
    writeFileSync(join(dir, 'boot-refused.json'), JSON.stringify({ reason: 'refusing to start: A', at: 1 }))
    expect(readBootRefusal(dir)).toBe('refusing to start: A')
    expect(noteBootRefusal(dir, 'refusing to start: A', 2)).toBe('refusing to start: A')
    expect(noteBootRefusal(dir, 'refusing to start: A', 3)).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, 'boot-refused.json'), 'utf8')).at).toBe(1)
    expect(noteBootRefusal(dir, 'refusing to start: B', 4)).toBe('refusing to start: B')
    expect(readBootRefusal(dir)).toBe('refusing to start: B')
  })
})
