import { describe, expect, test } from 'bun:test'
import { CODEX_SURFACE_REPAIR_DELAYS_MS, scheduleCodexSurfaceRepairs } from '../codex-bootstrap.js'

describe('delayed Codex surface repair', () => {
  test('rechecks after the TUI teardown window', () => {
    const scheduled: Array<{ fn: () => void; delay: number }> = []
    let repairs = 0
    const info = { sessionId: 'sid', engine: 'codex' } as any
    scheduleCodexSurfaceRepairs('sid', {
      get: () => info,
      ensure: () => { repairs++; return true },
      schedule: (fn, delay) => { scheduled.push({ fn, delay }); return 0 as any },
    })

    expect(scheduled.map(item => item.delay)).toEqual([...CODEX_SURFACE_REPAIR_DELAYS_MS])
    for (const item of scheduled) item.fn()
    expect(repairs).toBe(2)
  })

  test('does not resurrect a session killed before the delayed check', () => {
    const scheduled: Array<() => void> = []
    let repairs = 0
    scheduleCodexSurfaceRepairs('sid', {
      get: () => ({ sessionId: 'sid', engine: 'codex', deadAt: 1 } as any),
      ensure: () => { repairs++; return true },
      schedule: fn => { scheduled.push(fn); return 0 as any },
    })
    for (const fn of scheduled) fn()
    expect(repairs).toBe(0)
  })
})
