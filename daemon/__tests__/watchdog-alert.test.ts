import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { deliverWatchdogAlert } from '../watchdog-alert.js'
import { WATCHDOG_ALERT_FILE } from '../../shared/constants.js'

let dir: string
let origStderr: typeof process.stderr.write
const file = () => join(dir, WATCHDOG_ALERT_FILE)
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watchdog-alert-'))
  origStderr = process.stderr.write
  process.stderr.write = (() => true) as any
})
afterEach(() => {
  process.stderr.write = origStderr
  rmSync(dir, { recursive: true, force: true })
})

test('the alert is posted to the operator once, then removed', async () => {
  writeFileSync(file(), JSON.stringify({ text: '⚠️ restarted 3 times', at: 1 }))
  const sent: string[] = []
  await deliverWatchdogAlert(async t => { sent.push(t); return true }, dir)
  await deliverWatchdogAlert(async t => { sent.push(t); return true }, dir)
  expect(sent).toEqual(['⚠️ restarted 3 times'])
  expect(existsSync(file())).toBe(false)
})

test('an alert that did not reach the operator is kept for the next start', async () => {
  writeFileSync(file(), JSON.stringify({ text: 'x', at: 1 }))
  await deliverWatchdogAlert(async () => false, dir)
  expect(existsSync(file())).toBe(true)
  await deliverWatchdogAlert(async () => { throw new Error('gateway') }, dir)
  expect(existsSync(file())).toBe(true)
})

test('no file: nothing sent; an unreadable file is dropped, not retried forever', async () => {
  const sent: string[] = []
  await deliverWatchdogAlert(async t => { sent.push(t); return true }, dir)
  writeFileSync(file(), '{not json')
  await deliverWatchdogAlert(async t => { sent.push(t); return true }, dir)
  expect(sent).toEqual([])
  expect(existsSync(file())).toBe(false)
})
