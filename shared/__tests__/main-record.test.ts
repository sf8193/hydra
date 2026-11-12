import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearMainRecord, readMainRecord, writeMainRecord } from '../main-record.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'main-record-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('round-trips; a later launch overwrites; cleared is none', () => {
  expect(readMainRecord(dir)).toBeNull()
  writeMainRecord(dir, { model: 'claude-opus-5-5[1m]' })
  writeMainRecord(dir, { model: 'claude-sonnet-5-5[1m]' })
  expect(readMainRecord(dir)).toEqual({ model: 'claude-sonnet-5-5[1m]' })
  clearMainRecord(dir)
  expect(readMainRecord(dir)).toBeNull()
  clearMainRecord(dir) // nothing there: no throw
})

test('junk, or a record with no model, is none', () => {
  writeFileSync(join(dir, 'main.json'), '{not json')
  expect(readMainRecord(dir)).toBeNull()
  writeFileSync(join(dir, 'main.json'), '{"model":""}')
  expect(readMainRecord(dir)).toBeNull()
})
