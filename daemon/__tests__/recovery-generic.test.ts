// Pins which dead records the neutral recoverOne cascade may act on: Claude
// yes, Codex no (it would be relaunched as Claude). Manual `recover` and
// boot auto-recover both apply it.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { gateway } from '../config.js'
import { registry, threadRegistry, type SessionInfo } from '../sessions.js'
import { engines } from '../engines/instances.js'
import { handleRecoverIntercept, autoRecoverAfterBoot } from '../recovery.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'

let fake: FakeTmux
let others: SessionInfo[] = []
const ids: string[] = []
const sent: string[] = []
const orig = { send: gateway.send, react: gateway.react }

function dead(sessionId: string, engine: 'claude' | 'codex'): void {
  const info = {
    sessionId, topic: 't', threadId: `th-${sessionId}`, createdAt: 1, lastActive: 1, tmuxName: sessionId,
    listening: false, sessionType: 'thread_owner', engine, adapter: engines[engine], deadAt: 1,
    // A worktree that can't be reattached ends recoverOne before any spawn.
    worktreeRepo: '/nonexistent/rg-repo', worktreePath: `/nonexistent/rg-wt-${sessionId}`, worktreeBranch: 'wt/none',
  } as SessionInfo
  registry.set(sessionId, info)
  threadRegistry.set(info.threadId, { threadId: info.threadId, topic: 't', respawnCount: 0, createdAt: 1, lastActive: 1, totalMessages: 0, sessionHistory: [] } as any)
  ids.push(sessionId)
}

beforeEach(() => {
  fake = withFakeTmux()
  // The filters read the shared registry: hide what other files left there.
  others = [...registry.values()]
  for (const i of others) registry.delete(i.sessionId)
  sent.length = 0
  ;(gateway as any).send = async (c: string, text: string) => { sent.push(text); return { id: 'x', channelId: c } }
  ;(gateway as any).react = async () => {}
})
afterEach(() => {
  for (const id of ids.splice(0)) { threadRegistry.delete(`th-${id}`); registry.delete(id) }
  for (const i of others) registry.set(i.sessionId, i)
  Object.assign(gateway, orig)
  fake.restore()
})

test('manual recover: a dead Codex record is not a candidate; a dead Claude one is', async () => {
  const msg = { channelId: 'ch', id: 'm1' } as any
  dead('rg-codex', 'codex')
  await handleRecoverIntercept(msg, 'rg-none')
  expect(sent).toEqual(['No dead sessions found.'])
  sent.length = 0
  dead('rg-claude', 'claude')
  await handleRecoverIntercept(msg, 'rg-none')
  expect(sent).toEqual(['"rg-none" not found in dead sessions.'])
})

test('auto-recover at boot: skips a dead Codex record, takes a dead Claude one', async () => {
  const env = { a: process.env.HYDRA_AUTO_RECOVER, s: process.env.SPAWN_CWD }
  process.env.HYDRA_AUTO_RECOVER = '1'
  process.env.SPAWN_CWD = fake.dir
  const lines: string[] = [], write = process.stderr.write
  process.stderr.write = ((l: string) => { lines.push(String(l)); return true }) as any
  const revive = () => lines.filter(l => l.includes('dead session(s) to revive'))
  try {
    dead('rg-auto-codex', 'codex')
    await autoRecoverAfterBoot()
    expect(revive()).toEqual([])
    dead('rg-auto-claude', 'claude')
    await autoRecoverAfterBoot()
    expect(revive()).toEqual(['daemon: auto-recover: 1 dead session(s) to revive\n'])
  } finally {
    process.stderr.write = write
    for (const [k, v] of [['HYDRA_AUTO_RECOVER', env.a], ['SPAWN_CWD', env.s]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})
