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
  await deliverWatchdogAlert(async t => { sent.push(t); return true }, dir, 1)
  await deliverWatchdogAlert(async t => { sent.push(t); return true }, dir, 1)
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

test('an alert that waited more than an hour says how old it is; a fresh one is posted as written', async () => {
  const { alertText } = await import('../watchdog-alert.js')
  expect(alertText('⚠️ x', 1_000, 1_000 + 3600)).toBe('⚠️ x')
  expect(alertText('⚠️ x', undefined, 1e9)).toBe('⚠️ x')
  expect(alertText('⚠️ x', 0, 2 * 86400 + 3 * 3600)).toBe('_This alert is from 2d 3h ago; no daemon could post it until now._\n⚠️ x')
  writeFileSync(file(), JSON.stringify({ text: '⚠️ x', at: 0 }))
  const sent: string[] = []
  await deliverWatchdogAlert(async t => { sent.push(t); return true }, dir, 7200)
  expect(sent[0]).toStartWith('_This alert is from 2h ago')
})
