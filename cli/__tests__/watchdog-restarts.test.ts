import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { noteRestart, RESTART_ALERT_COUNT, RESTART_ALERT_WINDOW_S } from '../watchdog-restarts.js'
import { WATCHDOG_ALERT_FILE } from '../../shared/constants.js'

describe('noteRestart', () => {
  let dir: string
  const alertFile = () => join(dir, WATCHDOG_ALERT_FILE)
  const note = (at: number, reason = 'Heartbeat stale (364s > 300s), restarting daemon') => noteRestart(dir, at, reason, '~/hydra-watchdog.log')

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'watchdog-restarts-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test(`the ${RESTART_ALERT_COUNT}rd restart within an hour alerts, listing each restart, and leaves the alert for the daemon`, () => {
    expect(note(1_000)).toBeNull()
    expect(note(1_400, 'Daemon CPU pinned (98% >= 90% for 2 ticks), restarting daemon')).toBeNull()
    expect(existsSync(alertFile())).toBe(false)
    const alert = note(1_800)!
    expect(alert).toStartWith('⚠️ The watchdog restarted the daemon 3 times in the last hour:')
    expect(alert).toContain('Daemon CPU pinned (98% >= 90% for 2 ticks)')
    expect(alert.split('\n').filter(l => l.startsWith('• ')).length).toBe(3)
    expect(alert).toContain('~/hydra-watchdog.log')
    expect(JSON.parse(readFileSync(alertFile(), 'utf8'))).toEqual({ text: alert, at: 1_800 })
  })

  test('restarts spread over more than an hour never alert', () => {
    for (const at of [0, 2_000, 4_000, 6_000, 8_000]) expect(note(at)).toBeNull()
  })

  test('a loop that goes on is alerted once per hour, not on every restart', () => {
    note(1_000); note(1_400)
    expect(note(1_800)).not.toBeNull()
    for (const at of [2_200, 2_600, 3_000, 4_000, 5_000]) expect(note(at)).toBeNull()
    // The alerted restart (1_800) has now left the window, which still holds three or more.
    expect(note(1_800 + RESTART_ALERT_WINDOW_S)).not.toBeNull()
  })

  test('the alert can come again after a quiet hour', () => {
    note(0); note(100); expect(note(200)).not.toBeNull()
    const later = 200 + RESTART_ALERT_WINDOW_S + 1
    expect(note(later)).toBeNull()
    expect(note(later + 100)).toBeNull()
    expect(note(later + 200)).not.toBeNull()
  })
})
