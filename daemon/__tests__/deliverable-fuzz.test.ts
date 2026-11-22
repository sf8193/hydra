// The change to who gets a message, fuzzed against its parent. Generated session states go through `transport.deliver` with the real
// adapters; the outcome of each is recorded. With FUZZ_OUT set the run writes them to that file (run it on the parent build to get the
// old answers); with FUZZ_BASE set it reads them back and compares. Without either it checks the rule directly: a message is refused,
// and not queued, exactly when the session is orphaned or dead, and every other state does what it did.
import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { transport } from '../../sessions/bridge-transport.js'
import { registry } from '../../sessions/registry.js'
import { engines } from '../../sessions/engine-instances.js'
import { ORPHAN_GRACE_MS, _setDaemonStartedAtForTesting } from '../../sessions/occupancy.js'
import { fakeCodexAdapter } from './test-harness.js'
import '../../app/restricted.js'

process.stderr.write = (() => true) as any
_setDaemonStartedAtForTesting(0)

type State = { id: string; engine: 'claude' | 'codex'; kind: 'thread_owner' | 'thread_guest' | 'specialist'; running: boolean; bridge: boolean; ageMs: number; deadAt: boolean; nameHeld: boolean; text: boolean }
type Outcome = { status: string; queued: number }

let seed = 20261122
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
const states: State[] = Array.from({ length: 6000 }, (_, i) => ({
  id: `fz-${i}`, engine: pick(['claude', 'codex'] as const), kind: pick(['thread_owner', 'thread_guest', 'specialist'] as const),
  running: rnd() < 0.7, bridge: rnd() < 0.4, ageMs: pick([10, 1000, ORPHAN_GRACE_MS - 1, ORPHAN_GRACE_MS * 2]), deadAt: rnd() < 0.25, nameHeld: rnd() < 0.15, text: rnd() < 0.9,
}))

function seedState(s: State): void {
  const common = { sessionId: s.id, tmuxName: `${s.id}-tmux`, topic: 't', threadId: `th-${s.id}`, createdAt: Date.now() - s.ageMs, lastActive: Date.now(), listening: false, sessionType: s.kind, ...(s.deadAt && { deadAt: Date.now() - 5 }) }
  if (s.engine === 'claude') registry.set(s.id, { ...common, engine: 'claude', adapter: Object.assign(Object.create(engines.claude), { isAlive: () => s.running }) } as any)
  // Codex has no bridge: its app-server socket is both "connected" and "alive".
  else registry.set(s.id, { ...common, engine: 'codex', adapter: fakeCodexAdapter({ isConnected: () => s.running, isSocketLive: async () => s.running }) } as any)
  if (s.nameHeld) registry.set(`${s.id}-succ`, { ...common, sessionId: `${s.id}-succ`, deadAt: undefined, engine: 'claude', adapter: engines.claude } as any)
  if (s.engine === 'claude' && s.bridge) transport.bridges.set(s.id, { sessionId: s.id, buf: '', socket: { write: () => true, end() {}, destroyed: false } as any })
}
function clear(s: State): void { registry.delete(s.id); registry.delete(`${s.id}-succ`); transport.bridges.delete(s.id); transport.messageQueues.delete(s.id) }

async function run(s: State): Promise<Outcome> {
  seedState(s)
  const r = await transport.deliver(s.id, { type: 'notification', ...(s.text ? { content: 'hi', meta: { message_id: 'm' } } : { content: undefined }) })
  const queued = transport.messageQueues.get(s.id)?.length ?? 0
  clear(s)
  return { status: r.status, queued }
}

const results = new Map<string, Outcome>()
describe('who gets a message: every generated state', () => {
  test('runs', async () => { for (const s of states) results.set(s.id, await run(s)); expect(results.size).toBe(states.length) })

  test('compared with the parent build, or with the rule', () => {
    const base: Record<string, Outcome> | undefined = process.env.FUZZ_BASE ? JSON.parse(readFileSync(process.env.FUZZ_BASE, 'utf8')) : undefined
    let agree = 0, differ = 0, differClaudeOrphan = 0, differClaudeDead = 0, differOther = 0, orphanRefused = 0
    for (const s of states) {
      const o = results.get(s.id)!
      const refusedByRule = s.engine === 'claude' && !s.bridge && !(s.running && !s.deadAt && s.ageMs <= ORPHAN_GRACE_MS)
      if (refusedByRule) expect(o, JSON.stringify(s)).toEqual({ status: 'rejected', queued: 0 })
      if (!base) continue
      const old = base[s.id]!
      if (old.status === o.status && old.queued === o.queued) { agree++; continue }
      differ++
      // The only intended difference: a Claude session with no bridge that is orphaned or dead went from "accepted, queued" to refused.
      const intended = s.engine === 'claude' && !s.bridge && old.status === 'accepted' && o.status === 'rejected' && o.queued === 0 && old.queued > 0
      if (intended && s.running) differClaudeOrphan++
      else if (intended) differClaudeDead++
      else differOther++
      if (!intended) throw new Error(`unintended difference for ${JSON.stringify(s)}: old ${JSON.stringify(old)} new ${JSON.stringify(o)}`)
    }
    if (base) {
      orphanRefused = differClaudeOrphan
      process.stdout.write(`deliverable fuzz vs parent: ${JSON.stringify({ states: states.length, agree, differ, differClaudeOrphan: orphanRefused, differClaudeDead, differOther })}\n`)
      expect(differOther).toBe(0)
    }
  })

  afterAll(() => { if (process.env.FUZZ_OUT) writeFileSync(process.env.FUZZ_OUT, JSON.stringify(Object.fromEntries(results))) })
})
