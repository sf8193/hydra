// hydra migrate retires access.json whole: allowFrom becomes people, groups become admitted channels, the settings become [gateways.<platform>].
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { accessStep, applyMigrate, bootRefusal, planMigrate, type MigrateInput } from '../../infra/migrate.js'
import { loadHydraConfig } from '../load.js'
import { testLoadEnv } from './load-env.js'

const env = { ...testLoadEnv({ home: '/home/op', sessionNames: [] }), isDir: () => true }
let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
function state(files: Record<string, unknown>, platform: 'discord' | 'slack' = 'discord'): MigrateInput {
  dir = mkdtempSync(join(tmpdir(), 'hydra-migrate-access-'))
  for (const [f, v] of Object.entries(files)) writeFileSync(join(dir, f), typeof v === 'string' ? v : JSON.stringify(v))
  return { stateDir: dir, env, spawnCwd: '/home/op/work', platform }
}
const errors = (p: ReturnType<typeof planMigrate>) => p.ok ? [] : p.errors
const loaded = (p: ReturnType<typeof planMigrate>) => {
  if (!p.ok) throw new Error(p.errors.join('\n'))
  const l = loadHydraConfig(p.text, env)
  if (!l.ok) throw new Error(`migrated text must load:\n${p.text}`)
  return l.config
}
const OP = '100000000000000001', PAL = '100000000000000002'
const ACCESS = {
  dmPolicy: 'disabled', allowFrom: [OP, PAL], pending: {}, defaultListen: false, ackReaction: '👀', mentionPatterns: ['hey bot'],
  groups: {
    '300000000000000001': { requireMention: true, allowFrom: [OP], threadReply: true, defaultListen: true },
    '300000000000000002': { requireMention: false, allowFrom: [] },
  },
}

describe('channels and settings', () => {
  test('groups become admitted channels and the settings become the gateway\'s', () => {
    const c = loaded(planMigrate(state({ 'access.json': ACCESS })))
    expect(c.channels?.['discord:300000000000000001']).toEqual({ threadReply: true, access: { mention: true, allow: ['operator'], listen: true } })
    expect(c.channels?.['discord:300000000000000002']).toEqual({ access: { mention: false, allow: 'anyone' } })
    expect(c.gateSettings?.discord).toEqual({ off: true, ackReaction: '👀', listen: false, mentionPatterns: ['hey bot'] })
    expect(c.places).toEqual({})
  })
  test('on Slack the keys and ids are slack ones', () => {
    const c = loaded(planMigrate(state({ 'access.json': { allowFrom: ['U0OP'], groups: { C0123ABC: { requireMention: true, allowFrom: ['U0OP'] } } } }, 'slack')))
    expect(c.channels?.['slack:C0123ABC']?.access).toEqual({ mention: true, allow: ['operator'] })
  })
  test('the file is retired whole and kept as a backup; applying it leaves no access.json', () => {
    const input = state({ 'access.json': ACCESS })
    const plan = planMigrate(input)
    if (!plan.ok) throw new Error(plan.errors.join('\n'))
    expect(plan.consumed).toEqual(['access.json'])
    applyMigrate(dir, plan)
    expect(JSON.parse(plan.writes['access.json.migrated'])).toEqual(ACCESS)
  })
})

describe('what stops the migration', () => {
  test('someone in a group\'s allowFrom who is not in hydra.toml\'s people is named, with the channel and the command', () => {
    const [e] = errors(planMigrate(state({ 'access.json': { allowFrom: [OP], groups: { '300000000000000001': { allowFrom: [OP, '999'] } } } })))
    expect(e).toContain('groups.300000000000000001.allowFrom has 999')
    expect(e).toContain('hydra people add <name> discord:999')
  })
  test('an id hydra.toml already has as a person is that person, even after allowFrom was migrated earlier', () => {
    const toml = `operator = "me"\n[people.me]\naddresses = ["discord:${OP}"]\n`
    const c = loaded(planMigrate(state({ 'hydra.toml': toml, 'access.json': { allowFrom: [], groups: { '300000000000000001': { allowFrom: [OP] } } }, 'access.json.migrated': '{"allowFrom":["x"]}' })))
    expect(c.channels?.['discord:300000000000000001']?.access.allow).toEqual(['me'])
  })
  test('a setting hydra.toml no longer has stops it, naming the setting', () => {
    expect(errors(planMigrate(state({ 'access.json': { allowFrom: [OP], replyToMode: 'all' } })))[0]).toContain('access.json sets replyToMode')
    expect(errors(planMigrate(state({ 'access.json': { allowFrom: [OP], groups: { '300000000000000001': { threadArchiveMinutes: 60 } } } })))[0]).toContain('groups.300000000000000001.threadArchiveMinutes')
  })
  test('a place hydra.toml already has cannot take the access table appended: it is refused with the edit to make', () => {
    const toml = `operator = "me"\n[people.me]\naddresses = ["discord:${OP}"]\n[places."discord:300000000000000001"]\nbots = true\n`
    const [e] = errors(planMigrate(state({ 'hydra.toml': toml, 'access.json': { allowFrom: [], groups: { '300000000000000001': { allowFrom: [OP] } } } })))
    expect(e).toContain('by hand')
  })
})

describe('people in a group\'s allowFrom', () => {
  test('an address hydra.toml already gives a person stays theirs, though allowFrom would have named it operator', () => {
    const toml = `operator = "me"\n[people.me]\naddresses = ["discord:${OP}"]\n`
    const c = loaded(planMigrate(state({ 'hydra.toml': toml, 'access.json': { allowFrom: [OP], groups: { '300000000000000001': { allowFrom: [OP] } } } })))
    expect(c.channels?.['discord:300000000000000001']?.access.allow).toEqual(['me'])
  })
  test('the same id twice, or with spaces, is one person', () => {
    const c = loaded(planMigrate(state({ 'access.json': { allowFrom: [OP], groups: { '300000000000000001': { allowFrom: [OP, ` ${OP} `] } } } })))
    expect(c.channels?.['discord:300000000000000001']?.access.allow).toEqual(['operator'])
  })
  test('an allowFrom that is not a list stops it: reading it as "anyone" would open the channel', () => {
    expect(errors(planMigrate(state({ 'access.json': { allowFrom: [OP], groups: { '300000000000000001': { allowFrom: OP } } } })))[0]).toContain('must be a list of ids')
  })
})

describe('what is said, not lost', () => {
  const notes = (a: object) => { const p = planMigrate(state({ 'access.json': { allowFrom: [OP], ...a } })); if (!p.ok) throw new Error(p.errors.join('\n')); return p.notes.join('\n') }
  test('a group that is not a channel id hydra.toml can name, or not an object, is left out with a note', () => {
    expect(notes({ groups: { C045AHA7WFQ: { allowFrom: [OP] }, '300000000000000001': true } })).toContain('group "C045AHA7WFQ" left out')
    expect(notes({ groups: { '300000000000000001': true } })).toContain('group "300000000000000001" left out: not an object')
  })
  test('pairing codes waiting, and the pairing policy, are said to be gone', () => {
    expect(notes({ dmPolicy: 'pairing', pending: { abc: { senderId: '1' } } })).toContain('pairing codes waiting')
    expect(notes({ dmPolicy: 'pairing' })).toContain('dmPolicy "pairing" is gone')
  })
  test('dmPolicy disabled says it is now off = true', () => {
    expect(notes({ dmPolicy: 'disabled' })).toContain('off = true')
  })
})

describe('an access.json that does not parse', () => {
  test('refuses to start with or without hydra.toml: nothing else reads it, so a silent boot would have nobody in charge', () => {
    expect(bootRefusal(state({ 'access.json': '{ nope' }).stateDir)).toContain("Run 'hydra migrate'")
    expect(bootRefusal(state({ 'access.json': '{ nope' }).stateDir)).toContain('ACCESS.md, "Upgrading from access.json"')
    expect(bootRefusal(state({ 'hydra.toml': `operator = "me"\n[people.me]\naddresses = ["discord:${OP}"]\n`, 'access.json': '{ nope' }).stateDir)).toContain("Run 'hydra migrate'")
  })
})

describe('groups and --operator', () => {
  test('a group whose id this platform cannot name is left out without needing its people', () => {
    const plan = planMigrate(state({ 'access.json': { allowFrom: [OP], groups: { C0123ABC: { allowFrom: ['U0X'] } } } }))
    expect(errors(plan).join('\n')).not.toContain('people add')
    expect(plan.ok && plan.notes.join('\n')).toContain('left out')
  })
  test('a group may list the person --operator adds in the same run', () => {
    const plan = planMigrate({ ...state({ 'access.json': { groups: { '300000000000000001': { allowFrom: [OP] } } } }), operator: OP })
    expect(loaded(plan).channels?.['discord:300000000000000001']).toBeDefined()
  })
})

describe('merging into a hydra.toml that has people already', () => {
  test('a migrated channel admits the person it named, not the existing person whose id it collided with', () => {
    const toml = `operator = "sam"\n[people.sam]\naddresses = ["discord:${OP}"]\n[people.person-2]\naddresses = ["discord:999"]\n`
    const plan = planMigrate(state({ 'hydra.toml': toml, 'access.json': { allowFrom: [OP, PAL], groups: { '300000000000000001': { allowFrom: [PAL] } } } }))
    const config = loaded(plan)
    expect(config.channels?.['discord:300000000000000001']?.access.allow).toEqual(['person-2-2'])
    expect(config.people['person-2-2'].addresses).toEqual([`discord:${PAL}`])
  })
})

describe('what is still to migrate', () => {
  test('a backup from an earlier migration is kept; this one takes the next name', () => {
    const toml = `operator = "me"\n[people.me]\naddresses = ["discord:${OP}"]\n`
    const plan = planMigrate(state({ 'hydra.toml': toml, 'access.json': { allowFrom: [], groups: { '300000000000000001': { allowFrom: [OP] } } }, 'access.json.migrated': '{"older":true}' }))
    if (!plan.ok) throw new Error(plan.errors.join('\n'))
    expect(plan.writes['access.json.migrated']).toBeUndefined()
    expect(plan.writes['access.json.2.migrated']).toBeDefined()
  })
  test('only an access.json that says something is pending: groups, a kill switch, an ack, listen, patterns', () => {
    const pending = (a: object) => accessStep.pending(state({ 'access.json': a }).stateDir)
    expect(pending({ dmPolicy: 'pairing', pending: {}, groups: {} })).toBe(false)
    expect(pending({ dmPolicy: 'allowlist', allowFrom: [] })).toBe(false)
    for (const a of [{ groups: { c: {} } }, { dmPolicy: 'disabled' }, { ackReaction: '👀' }, { defaultListen: false }, { mentionPatterns: ['x'] }, { chunkMode: 'newline' }]) expect(pending(a)).toBe(true)
  })
})
