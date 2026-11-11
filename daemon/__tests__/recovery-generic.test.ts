// Pins which dead records the neutral recoverOne cascade may act on: Claude
// yes, Codex no (it would be relaunched as Claude). Manual `recover` and
// boot auto-recover both apply it.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { gateway } from '../config.js'
import { registry, threadRegistry, type SessionInfo } from '../sessions.js'
import { engines } from '../engines/instances.js'
import { handleRecoverIntercept, autoRecoverAfterBoot, _setRecoveryDeps, _resetRecoveryDeps } from '../recovery.js'
import { _setTmuxForTesting, TMUX_HOLD_MS } from '../tmux.js'
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

test('manual recover: a record stamped dead whose tmux still runs is an orphan, not a candidate', async () => {
  const msg = { channelId: 'ch', id: 'm1' } as any
  dead('rg-orphan', 'claude')
  fake.alive('rg-orphan')
  await handleRecoverIntercept(msg, 'rg-none')
  expect(sent).toEqual(['No dead sessions found.'])
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

function autoRecoverEnv() {
  const env = { a: process.env.HYDRA_AUTO_RECOVER, s: process.env.SPAWN_CWD }
  process.env.HYDRA_AUTO_RECOVER = '1'
  process.env.SPAWN_CWD = fake.dir
  const lines: string[] = [], write = process.stderr.write
  process.stderr.write = ((l: string) => { lines.push(String(l)); return true }) as any
  const armed: Array<() => Promise<void>> = []
  _setRecoveryDeps({ later: fn => { armed.push(fn) } })
  return {
    lines: () => lines.filter(l => l.includes('auto-recover')), armed,
    /** tmux times out for the names in `slow`, and says "no such session" for the rest. */
    tmux: (slow: string[]) => _setTmuxForTesting({ exec: ((_f: string, args: string[]) => {
      throw Object.assign(new Error('tmux'), slow.includes(args[2]!.replace(/^=/, '')) ? { code: 'ETIMEDOUT' } : { status: 1 })
    }) as any }),
    done: () => {
      _setTmuxForTesting()
      _resetRecoveryDeps()
      process.stderr.write = write
      for (const [k, v] of [['HYDRA_AUTO_RECOVER', env.a], ['SPAWN_CWD', env.s]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
    },
  }
}

test('auto-recover at boot on a tmux that does not answer: the record is deferred, and one more pass revives only it', async () => {
  const t = autoRecoverEnv()
  try {
    dead('rg-first', 'claude')
    dead('rg-slow', 'claude')
    t.tmux(['rg-slow'])
    await autoRecoverAfterBoot()
    expect(t.lines()).toEqual([
      'daemon: auto-recover: 1 dead session(s) to revive\n',
      `daemon: auto-recover: tmux not responding; 1 dead record(s) deferred to one more pass in ${TMUX_HOLD_MS / 1000}s\n`,
    ])
    expect(t.armed).toHaveLength(1)
    t.tmux([])                       // tmux answers again: both read dead, but only the deferred one is retried
    await t.armed[0]!()
    expect(t.lines()[2]).toBe('daemon: auto-recover: 1 dead session(s) to revive\n')
    expect(t.armed).toHaveLength(1)
  } finally { t.done() }
})

test('the extra pass on a tmux still silent leaves the record dead and arms nothing', async () => {
  const t = autoRecoverEnv()
  try {
    dead('rg-still', 'claude')
    t.tmux(['rg-still'])
    await autoRecoverAfterBoot(undefined, new Set(['rg-still']))
    expect(t.lines()).toEqual(['daemon: auto-recover: tmux still not responding; 1 dead record(s) left dead; `recover` or the next boot retries them\n'])
    expect(t.armed).toEqual([])
  } finally { t.done() }
})

test('an extra pass that finds a recovery in progress says so, and where its records wait', async () => {
  const t = autoRecoverEnv()
  let release = () => {}
  _setRecoveryDeps({ later: fn => { t.armed.push(fn) }, tryResume: (() => new Promise<never>((_r, reject) => { release = () => reject(new Error('released')) })) as any })
  try {
    dead('rg-busy', 'claude')
    const info = registry.get('rg-busy')!
    delete info.worktreeRepo; delete info.worktreePath; delete info.worktreeBranch   // so recoverOne reaches the (held) resume
    t.tmux([])
    const first = autoRecoverAfterBoot()
    for (let i = 0; i < 100 && !t.lines().some(l => l.includes('to revive')); i++) await Bun.sleep(10)
    await autoRecoverAfterBoot(undefined, new Set(['rg-other']))
    expect(t.lines()).toContain('daemon: auto-recover: deferred pass skipped, a recovery is in progress; its records wait for `recover` or the next boot\n')
    release()
    await first.catch(() => {})
  } finally { t.done() }
})
