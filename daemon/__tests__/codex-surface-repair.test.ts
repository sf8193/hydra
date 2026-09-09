import { describe, expect, test } from 'bun:test'
import { CODEX_SURFACE_REPAIR_DELAYS_MS, reconnectCodexAfterDisconnect, scheduleCodexSurfaceRepairs } from '../codex-bootstrap.js'

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

describe('Codex app-server reconnect', () => {
  test('keeps the session alive after a transient transport close', async () => {
    const info = { sessionId: 'sid', engine: 'codex', tmuxName: 'ember', codexHomeName: 'ember', codexThreadId: 'thread-1', deadAt: 1 } as any
    let attempts = 0
    let ensured = 0
    let failed = 0
    const restored = await reconnectCodexAfterDisconnect('sid', {
      get: () => info,
      resume: async () => { attempts++; if (attempts === 1) throw new Error('transient close') },
      wait: async () => {},
      ensure: () => { ensured++; return true },
      persist: () => {},
      failed: () => { failed++ },
    })

    expect(restored).toBe(true)
    expect(attempts).toBe(2)
    expect(info.deadAt).toBeUndefined()
    expect(ensured).toBe(1)
    expect(failed).toBe(0)
  })

  test('classifies death only after bounded reconnect attempts fail', async () => {
    const info = { sessionId: 'sid', engine: 'codex', tmuxName: 'ember', codexHomeName: 'ember', codexThreadId: 'thread-1' } as any
    let attempts = 0
    let failed = 0
    const restored = await reconnectCodexAfterDisconnect('sid', {
      get: () => info,
      resume: async () => { attempts++; throw new Error('server gone') },
      wait: async () => {},
      ensure: () => true,
      persist: () => {},
      failed: () => { failed++ },
    })

    expect(restored).toBe(false)
    expect(attempts).toBe(3)
    expect(info.deadAt).toBeNumber()
    expect(failed).toBe(1)
  })
})
