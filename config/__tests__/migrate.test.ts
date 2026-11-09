import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { accessStep, applyMigrate, finishMigrate, mergeDocs, planMigrate, specialistsStep, toToml, type MigrateInput } from '../migrate.js'
import { loadHydraConfig } from '../load.js'
import type { LoadEnv } from '../types.js'

const env: LoadEnv = { home: '/home/op', isDir: () => true, isCommand: () => true, sessionNames: ['spark'] }
let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function state(files: Record<string, unknown>): MigrateInput {
  dir = mkdtempSync(join(tmpdir(), 'hydra-migrate-'))
  for (const [f, v] of Object.entries(files)) writeFileSync(join(dir, f), typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  return { stateDir: dir, env, spawnCwd: '/home/op/work', platform: 'discord' }
}
const read = (f: string) => readFileSync(join(dir, f), 'utf8')

const ACCESS = { dmPolicy: 'pairing', allowFrom: ['100000000000000001', '100000000000000002'], groups: { '300': { requireMention: true, allowFrom: [] } }, pending: {} }
const SPECIALISTS = {
  ops: { threadId: '900', channel: '555', kickoffFile: '/home/op/ops.md', kickoff: 'ignored', model: 'm1', idle: '4h', updatedAt: 7 },
  desk: { channel: '556', kickoff: 'be the desk' },
  '123': { channel: '557', kickoff: 'all digits' },
}

describe('hydra migrate', () => {
  test('access.json and specialists.json become one hydra.toml that loads, with pointers and backups', () => {
    const input = state({ 'access.json': ACCESS, 'specialists.json': SPECIALISTS })
    const plan = planMigrate(input)
    if (!plan.ok) throw new Error(plan.errors.join('\n'))
    const loaded = loadHydraConfig(plan.text, env)
    if (!loaded.ok) throw new Error('migrated text must load')
    expect(loaded.config.operator).toBe('operator')
    expect(loaded.config.people.operator.ids).toEqual(['discord:100000000000000001'])
    expect(loaded.config.people['person-2'].ids).toEqual(['discord:100000000000000002'])
    expect(loaded.config.specialists.ops).toMatchObject({ workdir: '/home/op/work', promptFile: '/home/op/ops.md', model: 'm1', idleMs: 4 * 3_600_000, home: '555' })
    expect(loaded.config.specialists.ops.prompt).toBeUndefined()
    expect(loaded.config.specialists.desk).toMatchObject({ prompt: 'be the desk', home: '556' })
    expect(Object.keys(loaded.config.specialists)).toEqual(['ops', 'desk'])
    expect(plan.notes.join('\n')).toContain('discord:100000000000000002 (now people.person-2) was in allowFrom but isn\'t the operator')
    expect(plan.notes.join('\n')).toContain('specialist "123" left out')

    applyMigrate(dir, plan)
    expect(read('hydra.toml')).toBe(plan.text)
    expect(existsSync(join(dir, 'specialists.json'))).toBe(false)
    expect(JSON.parse(read('specialists.json.migrated'))).toEqual(SPECIALISTS)
    expect(JSON.parse(read('specialist-threads.json'))).toEqual({ ops: { threadId: '900', updatedAt: 7 } })
    // Only allowFrom leaves access.json; the original is kept.
    const { allowFrom: _a, ...rest } = ACCESS
    expect(JSON.parse(read('access.json'))).toEqual(rest)
    expect(JSON.parse(read('access.json.migrated'))).toEqual(ACCESS)
    // Run again: it refuses, hydra.toml is written once.
    const again = planMigrate(input)
    expect(again.ok).toBe(false)
  })

  test('refuses, writing nothing, when hydra.toml has content, slack-watch.json has no step yet, or there is nothing to do', () => {
    expect(planMigrate(state({ 'hydra.toml': 'operator = "x"\n', 'specialists.json': SPECIALISTS }))).toMatchObject({ ok: false, errors: [expect.stringContaining('already has content')] })
    expect(planMigrate(state({ 'slack-watch.json': '{}', 'specialists.json': SPECIALISTS }))).toMatchObject({ ok: false, errors: [expect.stringContaining('slack-watch.json')] })
    expect(planMigrate(state({ 'access.json': { allowFrom: [] } }))).toMatchObject({ ok: false, errors: [expect.stringContaining('nothing to migrate')] })
    expect(planMigrate(state({ 'specialists.json': SPECIALISTS, 'specialists.json.migrated': '{}', 'access.json': ACCESS }))).toMatchObject({ ok: false, errors: [expect.stringContaining('already exists')] })
  })

  test('a result that doesn\'t load is refused: specialists with no allowFrom have no operator', () => {
    const plan = planMigrate(state({ 'specialists.json': SPECIALISTS }))
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.errors[0]).toContain('no operator')
    expect(existsSync(join(dir, 'hydra.toml'))).toBe(false)
    expect(existsSync(join(dir, 'specialists.json'))).toBe(true)
  })

  test('a Slack channel becomes a place; pending says which old state is still here', () => {
    const input = state({ 'access.json': { allowFrom: ['U0OP'] }, 'specialists.json': { ops: { channel: 'C0OPS', kickoff: 'k' } } })
    const plan = planMigrate({ ...input, platform: 'slack' })
    if (!plan.ok) throw new Error(plan.errors.join('\n'))
    expect(plan.text).toContain('home = "slack:C0OPS"')
    expect(plan.text).toContain('ids = ["slack:U0OP"]')
    expect(accessStep.pending(dir)).toBe(true)
    expect(specialistsStep.pending(dir)).toBe(true)
    applyMigrate(dir, plan)
    expect(accessStep.pending(dir)).toBe(false)
    expect(specialistsStep.pending(dir)).toBe(false)
  })
})

describe('hydra migrate: found in review', () => {
  const okPlan = (input: MigrateInput) => { const p = planMigrate(input); if (!p.ok) throw new Error(p.errors.join('\n')); return p }
  const endState = () => Object.fromEntries(readdirSync(dir).sort().map(f => [f, read(f)]))

  test('never writes a hydra.toml without an operator', () => {
    expect(planMigrate(state({ 'access.json': { allowFrom: ['U012ABCDEF'] } }))).toMatchObject({ ok: false, errors: [expect.stringContaining('no allowFrom id is a discord user id')] })
    expect(existsSync(join(dir, 'hydra.toml'))).toBe(false)
    expect(planMigrate(state({ 'access.json': { allowFrom: [] }, 'specialists.json': { ops: { kickoff: 'k' } } }))).toMatchObject({ ok: false, errors: [expect.stringContaining('no operator')] })
  })

  test('allowFrom ids are trimmed and deduplicated, numbers taken as ids; no false note', () => {
    const plan = okPlan(state({ 'access.json': { allowFrom: [' 100000000000000001', '100000000000000001', 100000000000000002] } }))
    expect(plan.text).toContain('[people.operator]\nids = ["discord:100000000000000001"]')
    expect(plan.notes.filter(n => n.includes('isn\'t the operator'))).toHaveLength(1)
  })

  test('a crash before the commit point leaves the old state working; running again completes it', () => {
    const input = state({ 'access.json': ACCESS, 'specialists.json': SPECIALISTS })
    applyMigrate(dir, okPlan(input), { stopAfter: 'stage' })
    expect(existsSync(join(dir, 'hydra.toml'))).toBe(false)
    expect(JSON.parse(read('access.json'))).toEqual(ACCESS)
    applyMigrate(dir, okPlan(input))
    const once = endState()
    expect(Object.keys(once)).toEqual(['access.json', 'access.json.migrated', 'hydra.toml', 'specialist-threads.json', 'specialists.json.migrated'])
  })

  test('a crash after the commit point is finished, not planned again, and ends the same', () => {
    const clean = state({ 'access.json': ACCESS, 'specialists.json': SPECIALISTS })
    applyMigrate(dir, okPlan(clean))
    const want = endState()
    const input = state({ 'access.json': ACCESS, 'specialists.json': SPECIALISTS })
    applyMigrate(dir, okPlan(input), { stopAfter: 'journal' })
    expect(planMigrate(input)).toMatchObject({ ok: false, errors: [expect.stringContaining('interrupted after it committed')] })
    expect(finishMigrate(dir)).toBe(true)
    expect(endState()).toEqual(want)
    expect(finishMigrate(dir)).toBe(false)
  })

  test('the operator note names the id chosen, not allowFrom\'s first', () => {
    const plan = planMigrate(state({ 'access.json': { allowFrom: ['U0XYZ', '222'] } }))
    if (!plan.ok) throw new Error(plan.errors.join('\n'))
    expect(plan.notes[0]).toStartWith('discord:222 is the operator')
  })

  test('a clashing backup says exactly how to start over', () => {
    const input = state({ 'access.json': ACCESS, 'access.json.migrated': '{"older":true}' })
    const plan = planMigrate(input)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.errors[0]).toContain(`mv '${join(dir, 'access.json.migrated')}' '${join(dir, 'access.json.migrated')}.old'`)
  })

  test('state files are written 0600, as the daemon writes them', () => {
    const input = state({ 'access.json': ACCESS, 'specialists.json': SPECIALISTS })
    applyMigrate(dir, okPlan(input))
    for (const f of readdirSync(dir)) expect((statSync(join(dir, f)).mode & 0o777).toString(8)).toBe('600')
  })

  test('existing pointers are merged (newer wins) and backed up; a different backup is never overwritten', () => {
    const input = state({ 'access.json': ACCESS, 'specialists.json': SPECIALISTS, 'specialist-threads.json': { ops: { threadId: '1234', updatedAt: 99 }, desk: { threadId: '777', updatedAt: 1 } } })
    const plan = okPlan(input)
    expect(JSON.parse(plan.writes['specialist-threads.json'])).toEqual({ ops: { threadId: '1234', updatedAt: 99 }, desk: { threadId: '777', updatedAt: 1 } })
    expect(plan.writes['specialist-threads.json.migrated']).toBeDefined()
    writeFileSync(join(dir, 'access.json.migrated'), '{"older":true}')
    expect(planMigrate(input)).toMatchObject({ ok: false, errors: [expect.stringContaining('access.json.migrated already exists with other content')] })
  })

  test('a relative kickoffFile is made absolute from the old daemon\'s folder; an unnameable channel is left out, both with a note', () => {
    const input = state({ 'access.json': { allowFrom: ['U0OP'] }, 'specialists.json': { ops: { kickoffFile: 'prompts/k.md', channel: 'D0123ABC' } } })
    const plan = okPlan({ ...input, platform: 'slack', daemonCwd: '/opt/hydra' })
    expect(plan.text).toContain('prompt_file = "/opt/hydra/prompts/k.md"')
    expect(plan.text).not.toContain('home =')
    expect(plan.notes.join('\n')).toContain('was relative to the daemon\'s folder')
    expect(plan.notes.join('\n')).toContain('channel D0123ABC isn\'t a channel hydra.toml can name')
  })

  test('kickoffs with DEL or a lone surrogate still write TOML that loads', () => {
    const plan = okPlan(state({ 'access.json': ACCESS, 'specialists.json': { ops: { kickoff: 'a\u007fb\ud800c' } } }))
    const loaded = loadHydraConfig(plan.text, env)
    expect(loaded.ok && loaded.config.specialists.ops.prompt).toBe('a\u007fb\ufffdc')
  })
})

describe('merging steps', () => {
  test('people merge by address, unioning roles; the first id wins and a later step\'s references follow it', () => {
    const { doc, conflicts, notes } = mergeDocs([
      { operator: 'operator', people: { operator: { ids: ['slack:U0OP'] } } },
      { people: { dan: { ids: ['slack:U0OP'], roles: ['staff'], name: 'Dan' }, ana: { ids: ['slack:U0ANA'], roles: ['staff'] } }, rules: [{ at: 'slack:#help', from: 'dan', to: 'ops' }] },
    ])
    expect(conflicts).toEqual([])
    expect(doc.people).toEqual({ operator: { ids: ['slack:U0OP'], roles: ['staff'], name: 'Dan' }, ana: { ids: ['slack:U0ANA'], roles: ['staff'] } })
    expect(doc.rules).toEqual([{ at: 'slack:#help', from: 'operator', to: 'ops' }])
    expect(notes).toEqual([])
  })

  test('specialists merge key by key; the same key with different values conflicts', () => {
    expect(mergeDocs([{ specialists: { ops: { workdir: '/w', prompt: 'p' } } }, { specialists: { ops: { listens: ['slack:#a'], allow: ['staff'] } } }]).doc.specialists)
      .toEqual({ ops: { workdir: '/w', prompt: 'p', listens: ['slack:#a'], allow: ['staff'] } })
    expect(mergeDocs([{ specialists: { ops: { workdir: '/w' } } }, { specialists: { ops: { workdir: '/x' } } }]).conflicts).toEqual(['specialists.ops.workdir: "/w" vs "/x"'])
  })

  test('people whose names read alike are listed for the operator to merge', () => {
    expect(mergeDocs([{ people: { dan: { ids: ['slack:U01'], name: 'Dan C' }, 'dan-c': { ids: ['discord:1'], name: 'dan-c' } } }]).notes)
      .toEqual(['people.dan and people.dan-c may be the same human: to merge, move every address into one and drop the other'])
  })
})

describe('toToml', () => {
  test('writes what Bun.TOML reads back: nested tables, quoted keys, [[rules]], top-level values', () => {
    const doc = {
      operator: 'op',
      connectors: { slack: { bot_token_env: 'T' } },
      people: { op: { ids: ['slack:U0OP'], roles: ['staff'] } },
      specialists: { ops: { workdir: '/w', prompt: 'line one\n"quoted"', max: 5 } },
      places: { 'slack:#help': { listen: 'all', files: true } },
      rules: [{ at: 'slack:#help', from: 'staff', to: 'ops' }],
      guard: { command: '/bin/g', timeout: '2s' },
    }
    expect(Bun.TOML.parse(toToml(doc))).toEqual(doc)
  })
})
