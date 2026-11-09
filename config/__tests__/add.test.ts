import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { addFragment, planAddFragment } from '../add.js'
import { loadHydraConfig } from '../load.js'
import type { LoadEnv } from '../types.js'

const env: LoadEnv = { home: '/h', isDir: () => true, isCommand: () => true, sessionNames: [] }

// The live hydra.toml's shape after its migrate (2026-11-09), with the operator's address made up.
const LIVE = `# Written by \`hydra migrate\`. Edit freely: hydra re-reads this file when it changes.
# Every key, explained: hydra.example.toml in the hydra repo; where each kind of setting lives: README › Configuration.

operator = "operator"

[people.operator]
ids = ["discord:100000000000000001"]

[specialists.ledger-review]
workdir = "~/Documents/ledger-agent-system"
home = "1551794455227404370"
sessions = "per-conversation"
idle = "4d"
prompt = "💰 Ledger Review. Read the instructions."

[schedules.ledger-review]
cron = "0 11 * * FRI"
check = "~/Documents/ledger-agent-system/jobs/review-check.sh"
runner = "daemon"
needs = ["internet"]
to = "ledger-review"

[schedules.ledger-review-nudge]
cron = "0 11,19 * * 0-4,6"
check = "~/Documents/ledger-agent-system/jobs/review-nudge.sh"
runner = "launchd"

[schedules.machine-health]
cron = "*/5 * * * *"
prompt = "🩺 Machine health check found something."
check = "~/Workstreams/MachineHealth/check.sh"
runner = "launchd"
to = "main"
`

// What an outside repo ships: the same tables, written its own way (comments, key order, a default left out).
const LEDGER = `# ledger-agent-system's hydra fragment
[specialists.ledger-review]
workdir = "~/Documents/ledger-agent-system"
home = "1551794455227404370"
prompt = "💰 Ledger Review. Read the instructions."
sessions = "per-conversation"
idle = "4d"

[schedules.ledger-review]
cron = "0 11 * * FRI"   # owed until done
to = "ledger-review"
runner = "daemon"
needs = ["internet"]
check = "~/Documents/ledger-agent-system/jobs/review-check.sh"

[schedules.ledger-review-nudge]
cron = "0 11,19 * * 0-4,6"
check = "~/Documents/ledger-agent-system/jobs/review-nudge.sh"
`

const BACKUP = `
[schedules.ledger-backup-pull]
cron = "23 * * * *"
runner = "daemon"
needs = ["internet"]
alert_after = "2d"
check = "~/Documents/ledger-agent-system/jobs/backup-pull.sh"
`

const NEW_SPECIALIST = `
[specialists.books]
workdir = "~/Workstreams/Books"
home = "1551794455227404371"

[schedules.nightly-books]
cron = "0 3 * * *"
to = "books"
prompt = "Nightly run."
`

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
const at = (text?: string) => {
  dir = mkdtempSync(join(tmpdir(), 'config-add-'))
  if (text !== undefined) writeFileSync(join(dir, 'hydra.toml'), text, { mode: 0o600 })
  return dir
}
const file = () => readFileSync(join(dir, 'hydra.toml'), 'utf8')
const loaded = () => { const r = loadHydraConfig(file(), env); if (!r.ok) throw new Error('hydra.toml must load'); return r.config }

describe('hydra config add', () => {
  test('appends the new tables after the live file, which stays exact, keeps its mode, and loads', () => {
    const d = at(LIVE)
    const r = addFragment(d, env, LEDGER + BACKUP + NEW_SPECIALIST, '/repo/hydra.fragment.toml')
    expect(r).toMatchObject({ ok: true, added: ['[specialists.books]', '[schedules.ledger-backup-pull]', '[schedules.nightly-books]'], already: ['[specialists.ledger-review]', '[schedules.ledger-review]', '[schedules.ledger-review-nudge]'] })
    expect(file().startsWith(LIVE)).toBe(true)
    expect(file()).toContain('# Added by `hydra config add` from /repo/hydra.fragment.toml.')
    expect(statSync(join(d, 'hydra.toml')).mode & 0o777).toBe(0o600)
    const cfg = loaded()
    expect(cfg.schedules['ledger-backup-pull']).toMatchObject({ runner: 'daemon', needs: ['internet'], alertAfterMs: 2 * 24 * 60 * 60_000 })
    expect(cfg.schedules['nightly-books'].to).toBe('books')
    expect(cfg.specialists.books.workdir).toBe('/h/Workstreams/Books')
  })

  test('adding it again is a no-op: every table is already there, and the file is not written', () => {
    const d = at(LIVE)
    expect(addFragment(d, env, LEDGER + BACKUP, '/f').ok).toBe(true)
    const once = file()
    const mtime = statSync(join(d, 'hydra.toml')).mtimeMs
    const again = addFragment(d, env, LEDGER + BACKUP, '/f')
    expect(again).toMatchObject({ ok: true, added: [], already: ['[specialists.ledger-review]', '[schedules.ledger-review]', '[schedules.ledger-review-nudge]', '[schedules.ledger-backup-pull]'] })
    expect(file()).toBe(once)
    expect(statSync(join(d, 'hydra.toml')).mtimeMs).toBe(mtime)
  })

  test('a table hydra.toml has with different values is refused, naming the exact edits; nothing is written, not even the new tables', () => {
    const d = at(LIVE)
    const changed = LEDGER.replace('cron = "0 11 * * FRI"', 'cron = "0 10 * * FRI"').replace('needs = ["internet"]\n', '') + BACKUP
    const r = planAddFragment(d, env, changed, '/f')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('- under [schedules.ledger-review]: set cron = "0 10 * * FRI"')
    expect(r.error).toContain('- under [schedules.ledger-review]: remove needs')
    expect(addFragment(d, env, changed, '/f').ok).toBe(false)
    expect(file()).toBe(LIVE)
  })

  test('refuses, changing nothing: no hydra.toml, other tables, a fragment that does not load with hydra.toml', () => {
    expect(planAddFragment(at(), env, BACKUP, '/f')).toMatchObject({ ok: false, error: expect.stringContaining('hydra migrate') })
    expect(planAddFragment(at(LIVE), env, 'operator = "x"\n[people.x]\nids = ["discord:3"]\n', '/f')).toMatchObject({ ok: false, error: expect.stringContaining('sets operator, people') })
    expect(planAddFragment(at(LIVE), env, 'schedules = 3\n', '/f')).toMatchObject({ ok: false, error: expect.stringContaining('must be [schedules.<id>] tables') })
    expect(planAddFragment(at(LIVE), env, '# nothing\n', '/f')).toMatchObject({ ok: false, error: expect.stringContaining('no [specialists.<id>]') })
    expect(planAddFragment(at(LIVE), env, '[schedules.x]\ncron = "0 3 * * *"\nto = "nobody"\nprompt = "p"\n', '/f')).toMatchObject({ ok: false, error: expect.stringContaining('wouldn\'t load with [schedules.x]') })
    expect(file()).toBe(LIVE)
  })

  test('a hand edit between planning and writing is never overwritten', () => {
    const d = at(LIVE)
    const plan = planAddFragment(d, env, BACKUP, '/f')
    if (!plan.ok) throw new Error(plan.error)
    writeFileSync(join(d, 'hydra.toml'), LIVE + '# edited by hand\n')
    // addFragment plans again under the lock, so it sees the edit and keeps it.
    expect(addFragment(d, env, BACKUP, '/f').ok).toBe(true)
    expect(file().startsWith(LIVE + '# edited by hand\n')).toBe(true)
  })
})

describe('hydra config add, concurrently', () => {
  test('six setups at once, beside a people add: every one that says added is in the file, the same fragment twice lands once', async () => {
    const d = at(LIVE)
    const root = join(import.meta.dir, '..', '..')
    const frags = [2, 3, 4, 5, 5, 6].map((n, i) => { const f = join(d, `frag${i}.toml`); writeFileSync(f, `[schedules.s${n}]\ncron = "${n} * * * *"\ncheck = "/bin/true"\n`); return { n, f } })
    const run = (args: string[]) => Bun.spawn(['bun', join(root, 'cli', 'hydra.ts'), '--state-dir', d, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HYDRA_NO_LAUNCHD: '1' } })
    const runs = await Promise.all([
      ...frags.map(async ({ n, f }) => { const p = run(['config', 'add', f]); return { n, code: await p.exited, err: await new Response(p.stderr).text() } }),
      (async () => { const p = run(['people', 'add', 'bob', 'discord:100000000000000002']); return { n: 0, code: await p.exited, err: await new Response(p.stderr).text() } })(),
    ])
    const cfg = loaded()
    for (const r of runs) {
      expect(r.err).not.toContain('ENOENT')
      if (r.code !== 0) { expect(r.err).toContain('run it again'); continue }
      if (r.n) expect(cfg.schedules[`s${r.n}`]).toBeDefined()
      else expect(cfg.people.bob).toBeDefined()
    }
    expect(file().match(/\[schedules\.s5\]/g)?.length ?? 0).toBeLessThanOrEqual(1)
    expect(runs.some(r => r.code === 0)).toBe(true)
  })
})
