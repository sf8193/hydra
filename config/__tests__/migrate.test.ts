import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { accessStep, appendOnly, applyMigrate, bootRefusal, finishMigrate, mergeDocs, planMigrate, specialistsStep, toToml, type MigrateInput } from '../migrate.js'
import { loadHydraConfig } from '../load.js'
import type { LoadEnv } from '../types.js'
import { testLoadEnv } from './load-env.js'

const env: LoadEnv = testLoadEnv({ home: '/home/op', sessionNames: ['spark'] })
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

  test('refuses, writing nothing, when a step refuses (slack-watch.json unreadable), or there is nothing to do', () => {
    expect(planMigrate(state({ 'slack-watch.json': '{ nope', 'specialists.json': SPECIALISTS }))).toMatchObject({ ok: false, errors: [expect.stringContaining('slack-watch.json')] })
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

describe('bootRefusal: hydra.toml beside the old state it replaces', () => {
  const TOML = 'operator = "op"\n[people.op]\nids = ["discord:1"]\n'
  test('refuses, naming each old state, only while hydra.toml has content', () => {
    expect(bootRefusal(state({ 'specialists.json': SPECIALISTS, 'access.json': ACCESS }).stateDir)).toBeUndefined()
    expect(bootRefusal(state({ 'hydra.toml': '\n', 'specialists.json': SPECIALISTS }).stateDir)).toBeUndefined()
    // The daemon's test for "in use": a comment-only file isn't; one that doesn't parse is.
    expect(bootRefusal(state({ 'hydra.toml': '# nothing yet\n', 'specialists.json': SPECIALISTS }).stateDir)).toBeUndefined()
    expect(bootRefusal(state({ 'hydra.toml': 'operator = \n', 'specialists.json': SPECIALISTS }).stateDir)).toContain('specialists.json')
    expect(bootRefusal(state({ 'hydra.toml': TOML, 'access.json': { allowFrom: [] } }).stateDir)).toBeUndefined()
    const r = bootRefusal(state({ 'hydra.toml': TOML, 'specialists.json': SPECIALISTS, 'access.json': ACCESS, 'slack-watch.json': '{}' }).stateDir)
    expect(r).toContain('old state it replaces is still in')
    expect(r).toContain('access.json allowFrom, specialists.json, slack-watch.json')
    expect(r).toContain("Run 'hydra migrate'")
  })
  test('refuses while a migration is half committed, until hydra migrate finishes it', () => {
    const input = state({ 'access.json': ACCESS, 'specialists.json': SPECIALISTS })
    const plan = planMigrate(input)
    if (!plan.ok) throw new Error(plan.errors.join('\n'))
    applyMigrate(dir, plan, { stopAfter: 'journal' })
    expect(bootRefusal(dir)).toContain("was interrupted after it committed; run 'hydra migrate' to finish it")
    finishMigrate(dir)
    expect(bootRefusal(dir)).toBeUndefined()
  })

  test('after hydra migrate, nothing is pending', () => {
    const input = state({ 'access.json': ACCESS, 'specialists.json': SPECIALISTS })
    const plan = planMigrate(input)
    if (!plan.ok) throw new Error(plan.errors.join('\n'))
    applyMigrate(dir, plan)
    expect(bootRefusal(dir)).toBeUndefined()
  })
})

describe('incremental migrate: what\'s pending is appended to an existing hydra.toml', () => {
  const HAND = '# my config\noperator = "dan"\n\n[people.dan]\nname = "Dan"\nids = ["discord:100000000000000001"]\n\n[specialists.chief]\nworkdir = "/w"\n'
  test('pending specialists are appended; the operator\'s file stays byte for byte, and allowFrom\'s person merges into theirs', () => {
    const input = state({ 'hydra.toml': HAND, 'access.json': ACCESS, 'specialists.json': { ops: { channel: '555', kickoff: 'be ops', threadId: '900' } } })
    const plan = planMigrate(input)
    if (!plan.ok) throw new Error(plan.errors.join('\n'))
    expect(plan.text.startsWith(HAND.trimEnd())).toBe(true)
    expect(plan.notes[0]).toBe('appends to the existing hydra.toml, leaving what\'s there as it is: [people.person-2], [specialists.ops]')
    // allowFrom's operator is hydra.toml's dan already: the note names dan, not the step's own id.
    expect(plan.notes[1]).toStartWith('discord:100000000000000001 is the operator, as people.dan')
    const loaded = loadHydraConfig(plan.text, env)
    if (!loaded.ok) throw new Error('must load')
    expect(loaded.config.operator).toBe('dan')
    expect(Object.keys(loaded.config.specialists)).toEqual(['chief', 'ops'])
    applyMigrate(dir, plan)
    expect(read('hydra.toml')).toBe(plan.text)
    expect(existsSync(join(dir, 'specialists.json'))).toBe(false)
    expect(bootRefusal(dir)).toBeUndefined()
  })

  test('a change to what hydra.toml already says is refused, naming it', () => {
    const input = state({ 'hydra.toml': HAND, 'specialists.json': { chief: { channel: '555', kickoff: 'k' } } })
    expect(planMigrate(input)).toMatchObject({ ok: false, errors: [expect.stringContaining('two sources disagree on specialists.chief.workdir')] })
    expect(appendOnly({ people: { a: { ids: ['x'] } } }, { people: { a: { ids: ['x'], roles: ['staff'] } } })).toEqual({ refusal: expect.stringContaining('[people.a]') })
    expect(appendOnly({ people: { a: { name: 'A', ids: ['x'] } } }, { people: { a: { ids: ['x'], name: 'A' } } })).toEqual({ doc: {}, tables: [] })
  })

  test('a hydra.toml with only comments is kept above the migrated content', () => {
    const plan = planMigrate(state({ 'hydra.toml': '# notes to self\n', 'access.json': ACCESS }))
    if (!plan.ok) throw new Error(plan.errors.join('\n'))
    expect(plan.text.startsWith('# notes to self\n\n# Written by `hydra migrate`')).toBe(true)
    expect(loadHydraConfig(plan.text, env).ok).toBe(true)
  })

  test('the existing text is an exact prefix: CRLF and trailing blank lines kept, new lines in the file\'s style', () => {
    const CRLF = '# c\r\noperator = "dan"\r\n\r\n[people.dan]\r\nids = ["discord:100000000000000001"]  \r\n\r\n\r\n'
    const plan = planMigrate(state({ 'hydra.toml': CRLF, 'specialists.json': { ops: { kickoff: 'k' } }, 'access.json': { allowFrom: ['100000000000000001'] } }))
    if (!plan.ok) throw new Error(plan.errors.join('\n'))
    expect(plan.text.startsWith(CRLF)).toBe(true)
    expect(/[^\r]\n/.test(plan.text)).toBe(false)
    expect(loadHydraConfig(plan.text, env).ok).toBe(true)
  })

  test('nothing to add: hydra.toml is left exactly as it is, with no header, and the old state is still retired', () => {
    const MINE = 'operator = "dan"\n[people.dan]\nids = ["discord:100000000000000001"]\n'
    const plan = planMigrate(state({ 'hydra.toml': MINE, 'access.json': { allowFrom: ['100000000000000001'], dmPolicy: 'pairing' } }))
    if (!plan.ok) throw new Error(plan.errors.join('\n'))
    expect(plan.text).toBe(MINE)
    expect(plan.notes[0]).toBe('nothing to add to hydra.toml; it is left as it is')
    expect(JSON.parse(plan.writes['access.json'])).toEqual({ dmPolicy: 'pairing' })
  })

  test('a table set inline at the top is refused by name, not by a parse error', () => {
    const INLINE = 'operator = "dan"\npeople = { dan = { ids = ["discord:100000000000000001"] } }\n'
    expect(planMigrate(state({ 'hydra.toml': INLINE, 'access.json': { allowFrom: ['100000000000000001', '100000000000000002'] } })))
      .toMatchObject({ ok: false, errors: [expect.stringContaining('hydra.toml sets people inline or with dotted keys at the top of the file')] })
  })

  test('a change to an existing table lists the exact edits to make by hand', () => {
    const MINE = 'operator = "dan"\n[people.dan]\nids = ["discord:100000000000000001"]\n[specialists.ops]\nworkdir = "/w"\n'
    const input = state({ 'hydra.toml': MINE, 'specialists.json': { ops: { kickoff: 'be ops', channel: '555' } } })
    const plan = planMigrate({ ...input, spawnCwd: '/w' })
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.errors[0]).toContain('Make these edits by hand, then run hydra migrate again:')
      expect(plan.errors[0]).toContain('- under [specialists.ops]: add prompt = "be ops"')
      expect(plan.errors[0]).toContain('- under [specialists.ops]: add home = "555"')
    }
  })

  test('nothing pending beside an existing hydra.toml: migrated', () => {
    expect(planMigrate(state({ 'hydra.toml': HAND }))).toMatchObject({ ok: false, errors: [expect.stringContaining('nothing is left to migrate')] })
  })
})
