import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { parseEnvLine, sourceEnvFiles, sourceNewEnvNames, sourcedEnvNames } from '../env-parse.js'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('parseEnvLine', () => {
  test('simple key=value', () => {
    expect(parseEnvLine('FOO=bar')).toEqual(['FOO', 'bar'])
  })

  test('strips inline comments on unquoted values', () => {
    expect(parseEnvLine('SPAWN_CWD=~/work # my dir')).toEqual(['SPAWN_CWD', '~/work'])
  })

  test('preserves # inside double-quoted values', () => {
    expect(parseEnvLine('VAL="has # hash"')).toEqual(['VAL', 'has # hash'])
  })

  test('preserves # inside single-quoted values', () => {
    expect(parseEnvLine("VAL='has # hash'")).toEqual(['VAL', 'has # hash'])
  })

  test('tolerates leading whitespace', () => {
    expect(parseEnvLine('  SPAWN_CWD=/a/b')).toEqual(['SPAWN_CWD', '/a/b'])
    expect(parseEnvLine('\tFOO=bar')).toEqual(['FOO', 'bar'])
  })

  test('tolerates CRLF line endings', () => {
    expect(parseEnvLine('FOO=bar\r')).toEqual(['FOO', 'bar'])
  })

  test('handles export prefix', () => {
    expect(parseEnvLine('export KEY=val')).toEqual(['KEY', 'val'])
  })

  test('export with inline comment', () => {
    expect(parseEnvLine('export KEY=val # note')).toEqual(['KEY', 'val'])
  })

  test('ignores comment-only lines', () => {
    expect(parseEnvLine('# this is a comment')).toBeNull()
  })

  test('ignores blank lines', () => {
    expect(parseEnvLine('')).toBeNull()
  })

  test('value with no comment is unchanged', () => {
    expect(parseEnvLine('URL=http://127.0.0.1:8123/transcribe')).toEqual(['URL', 'http://127.0.0.1:8123/transcribe'])
  })

  test('trailing whitespace stripped on unquoted', () => {
    expect(parseEnvLine('KEY=val   ')).toEqual(['KEY', 'val'])
  })

  test('empty value', () => {
    expect(parseEnvLine('KEY=')).toEqual(['KEY', ''])
  })
})

describe('sourceEnvFiles', () => {
  let saved: NodeJS.ProcessEnv
  let dir: string

  beforeEach(() => {
    saved = { ...process.env }
    delete process.env.PROBE_A
    delete process.env.PROBE_B
    dir = mkdtempSync(join(tmpdir(), 'env-src-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    for (const [k, v] of Object.entries(saved)) if (process.env[k] !== v) process.env[k] = v as string
  })

  test('fills an unset var', () => {
    writeFileSync(join(dir, '.env'), 'PROBE_A=from-file\n')
    sourceEnvFiles([join(dir, '.env')])
    expect(process.env.PROBE_A).toBe('from-file')
  })

  test('a set-but-blank var counts as absent and is backfilled', () => {
    process.env.PROBE_A = ''
    writeFileSync(join(dir, '.env'), 'PROBE_A=from-file\n')
    sourceEnvFiles([join(dir, '.env')])
    expect(process.env.PROBE_A).toBe('from-file')
  })

  test('a whitespace-only var counts as absent too', () => {
    process.env.PROBE_A = '   '
    writeFileSync(join(dir, '.env'), 'PROBE_A=from-file\n')
    sourceEnvFiles([join(dir, '.env')])
    expect(process.env.PROBE_A).toBe('from-file')
  })

  test('a real value is never overwritten', () => {
    process.env.PROBE_A = 'from-env'
    writeFileSync(join(dir, '.env'), 'PROBE_A=from-file\n')
    sourceEnvFiles([join(dir, '.env')])
    expect(process.env.PROBE_A).toBe('from-env')
  })

  test('a missing file is skipped, later files still apply', () => {
    writeFileSync(join(dir, 'second.env'), 'PROBE_B=second\n')
    expect(() => sourceEnvFiles([join(dir, 'missing.env'), join(dir, 'second.env')])).not.toThrow()
    expect(process.env.PROBE_B).toBe('second')
  })

  test('a present but unreadable file warns and does not silently succeed', () => {
    const f = join(dir, 'locked.env')
    writeFileSync(f, 'PROBE_A=from-file\n')
    chmodSync(f, 0o000)
    const written: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((s: string) => { written.push(String(s)); return true }) as typeof process.stderr.write
    try {
      sourceEnvFiles([f])
      expect(process.env.PROBE_A).toBeUndefined()
      expect(written.join('')).toContain('cannot read')
    } finally {
      process.stderr.write = orig
      chmodSync(f, 0o600)
    }
  })

  test('a missing file is silent — no warning for the normal case', () => {
    const written: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((s: string) => { written.push(String(s)); return true }) as typeof process.stderr.write
    try {
      sourceEnvFiles([join(dir, 'absent.env')])
      expect(written.join('')).toBe('')
    } finally {
      process.stderr.write = orig
    }
  })

  test('the first file to supply a value wins', () => {
    writeFileSync(join(dir, 'one.env'), 'PROBE_A=first\n')
    writeFileSync(join(dir, 'two.env'), 'PROBE_A=second\n')
    sourceEnvFiles([join(dir, 'one.env'), join(dir, 'two.env')])
    expect(process.env.PROBE_A).toBe('first')
  })
})

// A file edited after boot (a key added for a specialist's server): the boot loader again, for names not loaded only.
describe('sourceNewEnvNames', () => {
  let saved: NodeJS.ProcessEnv
  let dir: string
  beforeEach(() => {
    saved = { ...process.env }
    for (const k of ['PROBE_A', 'PROBE_B', 'PROBE_HELD']) delete process.env[k]
    dir = mkdtempSync(join(tmpdir(), 'env-new-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    for (const [k, v] of Object.entries(saved)) if (process.env[k] !== v) process.env[k] = v as string
  })
  const none = () => false

  test('a name added to the file after boot is set, and returned', () => {
    writeFileSync(join(dir, '.env'), 'PROBE_A=boot\n')
    sourceEnvFiles([join(dir, '.env')])
    writeFileSync(join(dir, '.env'), 'PROBE_A=boot\nPROBE_B=added\n')
    expect(sourceNewEnvNames([join(dir, '.env')], none)).toEqual(['PROBE_B'])
    expect(process.env.PROBE_B).toBe('added')
    expect(sourcedEnvNames()).toContain('PROBE_B')
  })

  test('a value already loaded is never changed: not one in the environment (even blank), not one the caller holds', () => {
    process.env.PROBE_A = 'boot'
    process.env.PROBE_B = ''
    writeFileSync(join(dir, '.env'), 'PROBE_A=edited\nPROBE_B=edited\nPROBE_HELD=edited\n')
    expect(sourceNewEnvNames([join(dir, '.env')], n => n === 'PROBE_HELD')).toEqual([])
    expect(process.env.PROBE_A).toBe('boot')
    expect(process.env.PROBE_B).toBe('')
    expect(process.env.PROBE_HELD).toBeUndefined()
  })

  test('nothing is unset: a name removed from the file stays', () => {
    process.env.PROBE_A = 'boot'
    writeFileSync(join(dir, '.env'), '')
    expect(sourceNewEnvNames([join(dir, '.env')], none)).toEqual([])
    expect(process.env.PROBE_A).toBe('boot')
  })

  test('a missing file adds nothing', () => {
    expect(sourceNewEnvNames([join(dir, 'gone.env')], none)).toEqual([])
  })
})
