import { describe, test, expect } from 'bun:test'
import { createMainBridgeCycle, formatReconnectLine, mainCloseRecordsReason, type ConnectResult } from '../main-bridge-cycle.js'

// Narrow a ConnectResult to the reconnect variant (throws if it was 'first').
function recon(r: ConnectResult) {
  if (r.kind !== 'reconnect') throw new Error(`expected reconnect, got ${r.kind}`)
  return r
}

describe('mainBridgeCycle — first connect', () => {
  test('cycle 1 is a plain first connect, no uptime/reason to report', () => {
    const c = createMainBridgeCycle()
    expect(c.connect(false, 1000)).toEqual({ kind: 'first' })
  })
})

describe('mainBridgeCycle — true per-cycle uptime', () => {
  test('uptime is the lifetime of the cycle that just ended, not the gap since disconnect', () => {
    const c = createMainBridgeCycle()
    c.connect(false, 1000)          // cycle 1 connects at t=1000
    c.disconnect('end', 6000)       // ...lives 5s, closes at t=6000
    const r = recon(c.connect(false, 9000)) // reconnects at t=9000
    expect(r.uptimeMs).toBe(5000)   // 5s lifetime — NOT the 3s idle gap
    expect(r.reason).toBe('end')
    expect(r.cycle).toBe(2)
  })

  test('error reason is carried through verbatim', () => {
    const c = createMainBridgeCycle()
    c.connect(false, 0)
    c.disconnect('error: ECONNRESET', 2000)
    expect(recon(c.connect(false, 2000)).reason).toBe('error: ECONNRESET')
  })
})

describe('mainBridgeCycle — replace reason precedence (the flagged false alarm)', () => {
  test("a replaced cycle reports 'replaced', and a later 'end' cannot corrupt it", () => {
    const c = createMainBridgeCycle()
    c.connect(false, 1000)               // cycle 1
    c.notifyReplaced(4000)               // daemon evicts incumbent (lived 3s)
    const r = recon(c.connect(true, 4000)) // newcomer registers, logs synchronously
    expect(r.reason).toBe('replaced by newcomer registration')
    expect(r.uptimeMs).toBe(3000)
    expect(r.hadOtherIncumbent).toBe(true)

    // The evicted socket's async 'end' arrives *after* the line above was already
    // produced. It updates internal state for the NEXT cycle but cannot retro-
    // actively change the value already returned — reason precedence holds.
    c.disconnect('end', 9000)
    expect(r.reason).toBe('replaced by newcomer registration')
    // And the following cycle correctly reports that later 'end'.
    expect(recon(c.connect(false, 9000)).reason).toBe('end')
  })
})

describe('mainBridgeCycle — log throttle', () => {
  test('cycles 2 and 3 always log; later rapid cycles are throttled to once per window', () => {
    const c = createMainBridgeCycle()
    c.connect(false, 0)
    expect(recon(c.connect(false, 100)).throttled).toBe(false) // cycle 2
    expect(recon(c.connect(false, 200)).throttled).toBe(false) // cycle 3
    expect(recon(c.connect(false, 300)).throttled).toBe(true)  // cycle 4, <60s since last log
  })

  test('a cycle past the throttle window logs again', () => {
    const c = createMainBridgeCycle()
    c.connect(false, 0)
    c.connect(false, 100) // 2
    c.connect(false, 200) // 3, logs at t=200
    expect(recon(c.connect(false, 300)).throttled).toBe(true)         // 4, throttled
    expect(recon(c.connect(false, 200 + 60_001)).throttled).toBe(false) // 5, past window
  })
})

describe('mainCloseRecordsReason — the guard that protects reason precedence', () => {
  test("the current owner's main close records its reason", () => {
    expect(mainCloseRecordsReason('main', true)).toBe(true)
  })

  test("a replaced/evicted main socket (no longer owner) does NOT record — this is what keeps a late 'end' from clobbering 'replaced'", () => {
    expect(mainCloseRecordsReason('main', false)).toBe(false)
  })

  test('non-main sessions never record a main-cycle reason', () => {
    expect(mainCloseRecordsReason('ember', true)).toBe(false)
    expect(mainCloseRecordsReason(undefined, true)).toBe(false)
  })
})

describe('formatReconnectLine', () => {
  test('renders second-resolution uptime and the incumbent-fight flag', () => {
    const line = formatReconnectLine({ kind: 'reconnect', cycle: 7, uptimeMs: 5000, reason: 'end', hadOtherIncumbent: true, throttled: false })
    expect(line).toContain('cycle 7')
    expect(line).toContain('last uptime 5s')
    expect(line).toContain('last disconnect: end')
    expect(line).toContain('duplicate incumbent socket was live at registration')
  })

  test('omits the incumbent-fight clause when there was no other incumbent', () => {
    const line = formatReconnectLine({ kind: 'reconnect', cycle: 2, uptimeMs: 0, reason: 'end', hadOtherIncumbent: false, throttled: false })
    expect(line).not.toContain('duplicate incumbent')
    expect(line).toContain('last uptime 0s')
  })
})
