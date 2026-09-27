// S10-lite A: a dying Codex session's final usage read. killSession clears the
// registry entry first, so the read resolves the rollout only from what the
// death event carries (engine, codexThreadId, codexHomeName) through the real
// Codex adapter, which reads under os.homedir(). Bun fixes homedir at process
// start, so the body runs in a child `bun test` with HOME pointed at a temp dir.

import { expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

const CHILD = process.env.S10_DEATH_CHILD === '1'

const tc = (input: number, cached: number, output: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
  total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0 } } } }) + '\n'

test.skipIf(CHILD)('the death-path test runs in a child with its own HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 's10-home-'))
  try {
    const r = Bun.spawnSync(['bun', 'test', join(import.meta.dir, 'codex-death-usage.test.ts')], {
      env: { ...process.env, HOME: home, S10_DEATH_CHILD: '1' }, stdout: 'pipe', stderr: 'pipe',
    })
    const out = r.stdout.toString() + r.stderr.toString()
    expect(out, out).toMatch(/\b1 pass\b/)
    expect(r.exitCode, out).toBe(0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test.skipIf(!CHILD)('a dying Codex session reports its final growth under providerSessionId', async () => {
  const { emit } = await import('../event-bus.js')
  const { registry } = await import('../sessions.js')
  const { emitSessionDeath } = await import('../session-lifecycle.js')
  const rd = await import('../raindrop.js')
  expect(homedir().startsWith(tmpdir()) || homedir().includes('s10-home-'), 'HOME must be the temp dir').toBe(true)

  const dir = join(homedir(), '.codex', 'hydra-deadhome', 'sessions', '2026', '09', '26')
  mkdirSync(dir, { recursive: true })
  const rollout = join(dir, 'rollout-2026-09-26T23-13-59-thread-d.jsonl')
  writeFileSync(rollout, tc(1000, 600, 50))

  const id = 'cx-death'
  const info: any = {
    sessionId: id, threadId: 'T-death', tmuxName: 'deadtmux', engine: 'codex', sessionType: 'thread_owner', originType: 'spawn',
    createdAt: 1, lastActive: 1, listening: true, topic: '', codexThreadId: 'thread-d', codexHomeName: 'deadhome',
  }
  registry.set(id, info)

  const sent: any[] = []
  process.env.RAINDROP_MODE = 'dryrun'
  rd._setDeps({
    liveSessionIds: () => (registry.get(id) ? [id] : []),
    knownSessionIds: () => [id],
    factsFor: rd.factsFromRegistry,
    usageFor: rd.defaultUsageFor,
    recordDryRun: (_e: string, body: any) => { sent.push(...body) },
    allowedUsers: () => new Set(['U1']),
    projectFor: () => undefined,
    env: () => process.env,
  })
  const real = globalThis.setInterval
  const fns: Array<() => void> = []
  globalThis.setInterval = ((fn: () => void) => { fns.push(fn); return { unref() {} } }) as any
  let dispose: () => void
  try { dispose = rd.register() } finally { globalThis.setInterval = real }
  const tick = () => new Promise(r => setTimeout(r, 0))

  emit('session:bridge-registered', { sessionId: id, threadId: 'T-death' } as any)
  await tick()
  fns[0]()  // the usage tick: delivers the baseline
  await tick()
  expect(sent.filter(e => e.event === 'hydra.session.usage').at(-1)?.properties.coldStart).toBe(1)

  appendFileSync(rollout, tc(1500, 1000, 80))
  registry.delete(id)  // as killSession does, before emitting
  info.deadAt = 5
  emitSessionDeath(info)
  await tick(); await tick()
  dispose!()

  const final = sent.find(e => e.event_id === `${id}:usage:final`)
  expect(final, 'no final usage event').toBeTruthy()
  expect(final.properties.providerSessionId).toBe('thread-d')
  expect(final.properties.claudeSessionId).toBeUndefined()
  expect([final.properties.deltaInputTokens, final.properties.deltaCacheReadTokens, final.properties.deltaOutputTokens, final.properties.coldStart])
    .toEqual([100, 400, 30, 0])
})
