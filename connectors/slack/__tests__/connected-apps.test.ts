import { describe, test, expect } from 'bun:test'
import { ConnectedApps, MEMBER_TTL_MS, NOT_MEMBER_TTL_MS, PROBE_RETRY_MS, PROBE_CONCURRENCY, TAG_REPROBE_MS } from '../apps.js'

const ID = (n: string) => ({ botUserId: `U${n}` })

function make() {
  let now = 1_000_000
  const alerts: string[] = []
  const apps = new ConnectedApps({ now: () => now, alert: t => alerts.push(t) })
  const probes = { a: [] as string[], b: [] as string[] }
  const answers: Record<string, Record<string, boolean | Error>> = { a: {}, b: {} }
  const probe = (app: 'a' | 'b') => async (ch: string) => { probes[app].push(ch); const r = answers[app][ch] ?? true; if (r instanceof Error) throw r; return r }
  apps.join('a', ID('A'), probe('a'))
  apps.join('b', ID('B'), probe('b'))
  return { apps, alerts, probes, answers, tick: (ms: number) => { now += ms } }
}

describe('what a failed read leaves of what is known', () => {
  test('an error after a good answer keeps it, and Slack is asked again after the retry time, not before', async () => {
    const t = make()
    await t.apps.ensure('C1', 'a')
    expect(t.apps.heardBy('C1', 'a')).toEqual(['a', 'b'])
    t.tick(MEMBER_TTL_MS + 1)
    t.answers.b.C1 = new Error('ratelimited')
    await t.apps.ensure('C1', 'a')
    expect(t.probes.b).toHaveLength(2)
    expect(t.apps.heardBy('C1', 'a')).toEqual(['a', 'b'])   // not turned into "not a member"
    expect(t.apps.settled('C1', 'a')).toBe(true)
    await t.apps.ensure('C1', 'a')
    expect(t.probes.b).toHaveLength(2)                      // not before the retry
    t.tick(PROBE_RETRY_MS + 1)
    t.answers.b.C1 = true
    await t.apps.ensure('C1', 'a')
    expect(t.probes.b).toHaveLength(3)
    expect(t.alerts).toEqual([])
  })

  test('an error with nothing known is "unknown": the app is not counted, and the operator is told once, naming the app and the scopes', async () => {
    const t = make()
    t.answers.b.C1 = new Error('missing_scope: the token needs groups:read')
    await t.apps.ensure('C1', 'a')
    await t.apps.ensure('C2', 'a')
    t.answers.b.C2 = new Error('missing_scope: the token needs groups:read')
    expect(t.apps.heardBy('C1', 'a')).toEqual(['a'])
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toContain('`b`')
    expect(t.alerts[0]).toContain('channels:read (public channels) and groups:read (private ones)')
  })

  test('"not a member" is believed for 30 seconds, a member for ten minutes', async () => {
    const t = make()
    t.answers.b.C1 = false
    await t.apps.ensure('C1', 'a')
    expect(t.apps.heardBy('C1', 'a')).toEqual(['a'])
    t.tick(NOT_MEMBER_TTL_MS - 1)
    expect(t.apps.settled('C1', 'a')).toBe(true)
    t.tick(2)
    expect(t.apps.settled('C1', 'a')).toBe(false)
    t.answers.b.C1 = true
    await t.apps.ensure('C1', 'a')
    t.tick(NOT_MEMBER_TTL_MS + 1)
    expect(t.apps.settled('C1', 'a')).toBe(true)
    t.tick(MEMBER_TTL_MS)
    expect(t.apps.settled('C1', 'a')).toBe(false)
  })
})

describe('reading is bounded, and never about the app that heard the message', () => {
  test('a pass over 200 channels has at most 5 reads in flight', async () => {
    let now = 0
    const apps = new ConnectedApps({ now: () => now })
    let inFlight = 0, peak = 0
    const slow = async () => { inFlight++; peak = Math.max(peak, inFlight); await Bun.sleep(1); inFlight--; return true }
    apps.join('a', ID('A'), async () => true)
    apps.join('b', ID('B'), slow)
    await Promise.all(Array.from({ length: 200 }, (_, i) => apps.ensure(`C${i}`, 'a')))
    expect(peak).toBeLessThanOrEqual(PROBE_CONCURRENCY)
    expect(peak).toBeGreaterThan(1)
    now += 0
  })

  test('the app that received the message is never asked about itself', async () => {
    const t = make()
    await t.apps.ensure('C1', 'a')
    expect(t.probes.a).toEqual([])
    expect(t.probes.b).toEqual(['C1'])
  })
})

describe('a tag reads the tagged app again', () => {
  test('a cached "not in" is read again when the text tags that app, and a flip with no event said is noticed once', async () => {
    const t = make()
    t.answers.b.C1 = false
    await t.apps.ensure('C1', 'a')
    expect(t.apps.settled('C1', 'a', ['b'])).toBe(true)   // read just now: nothing to read again
    t.tick(TAG_REPROBE_MS + 1)
    expect(t.apps.settled('C1', 'a', ['b'])).toBe(false)  // not a member as far as is known, and not read lately: read it
    t.answers.b.C1 = true                                  // invited meanwhile, no join event reached us
    await t.apps.ensure('C1', 'a', ['b'])
    expect(t.apps.heardBy('C1', 'a')).toEqual(['a', 'b'])
    expect(t.probes.b).toHaveLength(2)
    expect(t.alerts).toHaveLength(1)
    expect(t.alerts[0]).toContain('member_joined_channel')
    expect(t.alerts[0]).toContain('`b`')
    t.apps.changed('C1', 'b')   // it does report joins now
    t.tick(NOT_MEMBER_TTL_MS + 1)
    await t.apps.ensure('C1', 'a', ['b'])
    expect(t.alerts).toHaveLength(1)
  })

  test('a tagged app known to be in is not read again', async () => {
    const t = make()
    await t.apps.ensure('C1', 'a', ['b'])
    expect(t.apps.settled('C1', 'a', ['b'])).toBe(true)
    await t.apps.ensure('C1', 'a', ['b'])
    expect(t.probes.b).toHaveLength(1)
  })
})

describe('apps that are still joining', () => {
  test('an app taken out while it was joining no longer holds anyone up', async () => {
    const apps = new ConnectedApps()
    apps.join('a', ID('A'), async () => true)
    apps.expectJoin(['b'], 60_000)
    expect(apps.settled('C1', 'a')).toBe(false)
    let released = false
    void apps.allJoined().then(() => { released = true })
    apps.leave('b')
    await Bun.sleep(1)
    expect(released).toBe(true)
    expect(apps.isJoining()).toBe(false)
    expect(apps.settled('C1', 'a')).toBe(true)
  })

  test('an app that takes too long to join counts as not joining', async () => {
    const apps = new ConnectedApps()
    apps.join('a', ID('A'), async () => true)
    apps.expectJoin(['b'], 10)
    expect(apps.isJoining()).toBe(true)
    await Bun.sleep(30)
    expect(apps.isJoining()).toBe(false)
  })

  test('with one app and nothing joining, nothing is asked', async () => {
    const apps = new ConnectedApps()
    let asked = 0
    apps.join('a', ID('A'), async () => { asked++; return true })
    expect(apps.settled('C1', 'a')).toBe(true)
    await apps.ensure('C1', 'a')
    expect(asked).toBe(0)
  })
})

describe('the owner of a message', () => {
  test('the first decision stands for every later copy, until it is forgotten', () => {
    let now = 0
    const apps = new ConnectedApps({ now: () => now })
    expect(apps.decideOwner('C1', '1.000001', () => 'a')).toBe('a')
    expect(apps.decideOwner('C1', '1.000001', () => 'b')).toBe('a')
    expect(apps.decideOwner('C1', '2.000001', () => 'b')).toBe('b')
    now += 3 * 60_000
    expect(apps.decideOwner('C1', '1.000001', () => 'b')).toBe('b')
  })
})
