import { describe, test, expect } from 'bun:test'
import { SlackGateway, slackSessionStatus, slackSessionTitles } from '../../slack-gateway.js'
import type { SessionVisualOpts } from '../../gateway.js'

const THREAD = 'D0BE3RB4Y00:1792779646.816639'
const SESSION = { channel_id: 'D0BE3RB4Y00', thread_ts: '1792779646.816639' }
const base: SessionVisualOpts = { state: 'live', emoji: '🔭', sessionName: 'scout', description: 'Slack thread titles' }

type Call = { method: string; args: Record<string, unknown> }

function platformError(error: string): Error {
  return Object.assign(new Error(`An API error occurred: ${error}`), { data: { ok: false, error } })
}

function gatewayWithStub(fail: (method: string, args: Record<string, unknown>) => string | undefined = () => undefined) {
  const calls: Call[] = []
  const gw = new SlackGateway('xapp-dummy')
  ;(gw as any).visualApi = {
    apiCall: async (method: string, args: Record<string, unknown>) => {
      calls.push({ method, args })
      const error = fail(method, args)
      if (error) throw platformError(error)
      return { ok: true }
    },
  }
  const apply = (opts: SessionVisualOpts, threadId = THREAD): Promise<void> => (gw as any).applySessionVisual(threadId, opts)
  const renames = () => calls.filter(c => c.method === 'agents.sessions.rename').map(c => c.args.title)
  return { gw, calls, apply, renames }
}

describe('slackSessionTitles', () => {
  test('leads with emoji, session name and description', () => {
    expect(slackSessionTitles(base)).toEqual(['🔭 scout - Slack thread titles', 'scout - Slack thread titles', 'scout'])
  })

  test('prefers the description over the topic, then falls back to the bare name', () => {
    expect(slackSessionTitles({ ...base, topic: 'triage' })[0]).toBe('🔭 scout - Slack thread titles')
    expect(slackSessionTitles({ ...base, description: undefined, topic: 'triage' })[0]).toBe('🔭 scout - triage')
    expect(slackSessionTitles({ ...base, description: undefined })).toEqual(['🔭 scout', 'scout'])
  })

  test('replaces characters Slack rejects and keeps the ones it accepts', () => {
    expect(slackSessionTitles({ ...base, description: 'fix: auth/login · #42 → done 🔥' })[1]).toBe('scout - fix auth login 42 done')
    expect(slackSessionTitles({ ...base, description: "v1.2, (ok)'s! ? & a_b = c | d-e" })[1]).toBe("scout - v1.2, (ok)'s! ? & a_b = c | d-e")
  })

  test('keeps combining marks after NFC normalisation', () => {
    expect(slackSessionTitles({ ...base, description: 'हिन्दी काम' })[1]).toBe('scout - हिन्दी काम')
    expect(slackSessionTitles({ ...base, description: 'café' })[1]).toBe('scout - café')
  })

  test('drops the separator when the description cleans down to nothing', () => {
    expect(slackSessionTitles({ ...base, description: '🔥 → ·' })).toEqual(['🔭 scout', 'scout'])
  })

  test('dead sessions swap the emoji for their state', () => {
    expect(slackSessionTitles({ ...base, state: 'killed' })[0]).toBe('☠️ scout - Slack thread titles')
    expect(slackSessionTitles({ ...base, state: 'crashed' })[0]).toBe('💥 scout - Slack thread titles')
  })

  test('marks paused only while alive', () => {
    expect(slackSessionTitles({ ...base, paused: true })[0]).toBe('🔭 scout - Slack thread titles (paused)')
    expect(slackSessionTitles({ ...base, state: 'zombie', paused: true })[0]).toBe('🔭 scout - Slack thread titles (paused)')
    expect(slackSessionTitles({ ...base, state: 'killed', paused: true })[0]).toBe('☠️ scout - Slack thread titles')
    expect(slackSessionTitles({ ...base, state: 'crashed', paused: true })[0]).toBe('💥 scout - Slack thread titles')
  })

  test('never offers an empty title', () => {
    expect(slackSessionTitles({ ...base, emoji: '', sessionName: '', description: undefined })).toEqual([])
  })

  test('caps every title at 200 UTF-16 units without splitting an emoji', () => {
    const titles = slackSessionTitles({ ...base, description: 'x'.repeat(300) })
    for (const title of titles) expect(title.length).toBeLessThanOrEqual(200)
    expect(titles[0]).toBe('🔭 scout - ' + 'x'.repeat(189))
    expect(slackSessionTitles({ ...base, description: 'x'.repeat(188) + '𠀀y' })[0]).toBe('🔭 scout - ' + 'x'.repeat(188))
  })
})

describe('slackSessionStatus', () => {
  test('maps lifecycle states', () => {
    expect(slackSessionStatus('live')).toBe('active')
    expect(slackSessionStatus('zombie')).toBe('active')
    expect(slackSessionStatus('crashed')).toBe('suspended')
    expect(slackSessionStatus('killed')).toBe('closed')
  })
})

describe('SlackGateway session visuals', () => {
  test('creates the session with a status before renaming it', async () => {
    const { calls, apply } = gatewayWithStub()
    await apply(base)
    expect(calls).toEqual([
      { method: 'agents.sessions.setStatus', args: { ...SESSION, status: 'active' } },
      { method: 'agents.sessions.rename', args: { ...SESSION, title: '🔭 scout - Slack thread titles' } },
    ])
  })

  test('walks the fallbacks while Slack rejects titles', async () => {
    const { apply, renames } = gatewayWithStub((m, a) => m === 'agents.sessions.rename' && a.title !== 'scout' ? 'invalid_name' : undefined)
    await apply(base)
    expect(renames()).toEqual(['🔭 scout - Slack thread titles', 'scout - Slack thread titles', 'scout'])
  })

  test('does not throw or cache when Slack rejects every title', async () => {
    const { apply, renames } = gatewayWithStub(m => m === 'agents.sessions.rename' ? 'invalid_name' : undefined)
    await apply(base)
    expect(renames()).toHaveLength(3)
    await apply(base)
    expect(renames()).toHaveLength(6)
  })

  test('rethrows rename errors other than invalid_name', async () => {
    const { apply, renames } = gatewayWithStub(m => m === 'agents.sessions.rename' ? 'ratelimited' : undefined)
    await expect(apply(base)).rejects.toThrow('ratelimited')
    expect(renames()).toEqual(['🔭 scout - Slack thread titles'])
  })

  test('skips the calls when nothing changed', async () => {
    const { calls, apply } = gatewayWithStub()
    await apply(base)
    await apply({ ...base, anchorMessageId: 'irrelevant' })
    expect(calls).toHaveLength(2)
    await apply({ ...base, state: 'killed' })
    expect(calls).toHaveLength(4)
    expect(calls[2].args.status).toBe('closed')
    await apply({ ...base, state: 'killed', description: 'new focus' })
    expect(calls).toHaveLength(6)
  })

  test('forgets the last update once a later one has touched Slack', async () => {
    let failing = false
    const { calls, apply } = gatewayWithStub(m => failing && m === 'agents.sessions.rename' ? 'ratelimited' : undefined)
    await apply(base)
    failing = true
    await expect(apply({ ...base, state: 'crashed' })).rejects.toThrow()
    failing = false
    await apply(base)
    expect(calls.slice(-2).map(c => c.method)).toEqual(['agents.sessions.setStatus', 'agents.sessions.rename'])
    expect(calls).toHaveLength(6)
  })

  test('retries an update that failed', async () => {
    let failing = true
    const { calls, apply } = gatewayWithStub(m => failing && m === 'agents.sessions.rename' ? 'ratelimited' : undefined)
    await expect(apply(base)).rejects.toThrow()
    failing = false
    await apply(base)
    expect(calls).toHaveLength(4)
  })

  for (const error of ['missing_scope', 'feature_disabled']) {
    test(`turns titles off for the process on ${error}`, async () => {
      const { gw, calls, apply } = gatewayWithStub(m => m === 'agents.sessions.setStatus' ? error : undefined)
      await apply(base)
      await apply({ ...base, state: 'killed' })
      await gw.updateSessionVisual(THREAD, base)
      expect(calls).toHaveLength(1)
    })
  }

  test('rethrows other setStatus errors without turning titles off', async () => {
    const { apply, calls } = gatewayWithStub(m => m === 'agents.sessions.setStatus' && calls.length === 1 ? 'not_authorized' : undefined)
    await expect(apply(base)).rejects.toThrow('not_authorized')
    await apply(base)
    expect(calls.map(c => c.method)).toEqual(['agents.sessions.setStatus', 'agents.sessions.setStatus', 'agents.sessions.rename'])
  })

  test('does not queue non-thread ids or updates once titles are off', async () => {
    const { gw } = gatewayWithStub()
    const queue = (gw as any).visualQueue
    queue.draining = true
    await gw.updateSessionVisual('D0BE3RB4Y00', base)
    expect(queue.queue.size).toBe(0)
    ;(gw as any).visualsUnavailable = true
    await gw.updateSessionVisual(THREAD, base)
    expect(queue.queue.size).toBe(0)
  })

  test('skips ids that are not threads and a disconnected gateway', async () => {
    const { gw, calls, apply } = gatewayWithStub()
    await gw.updateSessionVisual('D0BE3RB4Y00', base)
    ;(gw as any).visualApi = null
    await apply(base)
    expect(calls).toEqual([])
  })

  test('updateSessionVisual applies the first update and holds later ones for the drain interval', async () => {
    const { gw, renames } = gatewayWithStub()
    await gw.updateSessionVisual(THREAD, { ...base, description: 'first' })
    await gw.updateSessionVisual(THREAD, { ...base, description: 'second' })
    await gw.updateSessionVisual(THREAD, { ...base, description: 'third' })
    await new Promise(r => setTimeout(r, 20))
    expect(renames()).toEqual(['🔭 scout - first'])
    expect((gw as any).visualQueue.queue.get(THREAD).value.description).toBe('third')
  })

  test('queues killed, crashed and paused updates ahead of the rest', async () => {
    const { gw } = gatewayWithStub()
    await gw.updateSessionVisual(THREAD, base)
    const priority = async (thread: string, opts: SessionVisualOpts) => {
      await gw.updateSessionVisual(thread, opts)
      return (gw as any).visualQueue.queue.get(thread).priority
    }
    expect(await priority('D1:1.1', base)).toBe('normal')
    expect(await priority('D1:1.2', { ...base, state: 'zombie' })).toBe('normal')
    expect(await priority('D1:1.3', { ...base, state: 'killed' })).toBe('high')
    expect(await priority('D1:1.4', { ...base, state: 'crashed' })).toBe('high')
    expect(await priority('D1:1.5', { ...base, paused: true })).toBe('high')
  })
})
