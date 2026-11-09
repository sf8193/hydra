import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyAddPerson, planAddPerson } from '../people.js'
import { loadHydraConfig } from '../load.js'
import type { LoadEnv } from '../types.js'

const env: LoadEnv = { home: '/h', isDir: () => true, isCommand: () => true, sessionNames: [] }
const MINE = '# mine\noperator = "op"\n\n[people.op]\nids = ["discord:100000000000000001"]\n\n[people.ana]\nids = ["slack:U0ANA"]\nroles = ["staff"]\n'
let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
const at = (text?: string) => {
  dir = mkdtempSync(join(tmpdir(), 'people-'))
  if (text !== undefined) writeFileSync(join(dir, 'hydra.toml'), text, { mode: 0o640 })
  return dir
}

describe('hydra people add', () => {
  test('appends a [people.<id>] table after the operator\'s text, which stays exact, and keeps the file\'s mode', () => {
    const d = at(MINE)
    const plan = planAddPerson(d, env, { id: 'bob', address: 'discord:100000000000000002', roles: ['staff'] })
    if (!plan.ok) throw new Error(plan.error)
    expect(plan.text.startsWith(MINE)).toBe(true)
    applyAddPerson(d, plan.text)
    const loaded = loadHydraConfig(readFileSync(join(d, 'hydra.toml'), 'utf8'), env)
    expect(loaded.ok && loaded.config.people.bob).toEqual({ id: 'bob', ids: ['discord:100000000000000002'], roles: ['staff'], name: 'bob' })
    expect(statSync(join(d, 'hydra.toml')).mode & 0o777).toBe(0o640)
  })

  test('refuses, changing nothing: an address someone has, an id that exists, a role no allow could use, no hydra.toml', () => {
    expect(planAddPerson(at(MINE), env, { id: 'x', address: 'discord:100000000000000001' })).toEqual({ ok: false, error: 'discord:100000000000000001 already belongs to people.op' })
    expect(planAddPerson(at(MINE), env, { id: 'ana', address: 'discord:3' })).toMatchObject({ ok: false, error: expect.stringContaining('people.ana already exists: add discord:3 to its ids') })
    expect(planAddPerson(at(MINE), env, { id: 'eve', address: 'discord:3', roles: ['anyone'] })).toMatchObject({ ok: false, error: expect.stringContaining('"anyone" is built in') })
    expect(planAddPerson(at(), env, { id: 'eve', address: 'discord:3' })).toMatchObject({ ok: false, error: expect.stringContaining('isn\'t in use yet') })
    expect(planAddPerson(at(MINE), env, { id: 'Eve', address: 'discord:3' })).toMatchObject({ ok: false })
    expect(planAddPerson(at(MINE), env, { id: 'eve', address: 'U0EVE' })).toMatchObject({ ok: false, error: expect.stringContaining('is not an address') })
  })
})
