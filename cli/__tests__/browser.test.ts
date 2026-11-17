// `hydra specialist browser <name>`: refusals, the plan, and what it prints. The spawn itself is injected: no test opens a browser.
import { describe, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LOGIN_MARKER, UNTRUSTED_NOTE, browserCommand, lstatPresent, nearestReal, planBrowser, realMark, realMkdir, realProfileState, type BrowserProbes } from '../browser.js'
import { EMPTY_CONFIG } from '../../config/load.js'
import type { HydraConfig, Specialist } from '../../config/types.js'

const WORK = '/home/op/agents/gem'
const spec = (over: Partial<Specialist> = {}): Specialist => ({ id: 'gem', workdir: WORK, reachableBy: [], sessions: 'shared', maxSessions: 20, renamedFrom: [], restricted: false, canOnlyWriteTo: 'workdir', cannotRead: [], mcpServerNames: ['browser'], ...over })
const server = (over: object = {}) => ({ name: 'browser', command: '/bin/b-mcp', tokenEnv: [], tools: [], profileArgs: ['--dir={profile_dir}'], loginCommand: ['/opt/b/browser', '--user-data-dir={profile_dir}', '--no-first-run'], profileLocks: ['SingletonLock', 'lockfile'], ...over })
const cfg = (s: Specialist = spec(), servers: Record<string, any> = { browser: server() }, extra: Specialist[] = []): HydraConfig => ({ ...EMPTY_CONFIG, specialists: Object.fromEntries([s, ...extra].map(x => [x.id, x])), mcpServers: servers })
const probes = (over: Partial<BrowserProbes> = {}): BrowserProbes => ({ present: () => false, isSession: false, ...over })

describe('what it refuses', () => {
  test('an unknown specialist, naming the ones that qualify', () => {
    const r = planBrowser(cfg(), 'nope', {}, probes())
    expect(r).toEqual({ ok: false, error: 'no specialist nope in hydra.toml (write-confined ones with a browser: gem)' })
  })
  test('a specialist without can_only_write_to: the profile is the one that level gives it', () => {
    expect(planBrowser(cfg(spec({ canOnlyWriteTo: undefined })), 'gem', {}, probes())).toMatchObject({ ok: false, error: expect.stringContaining('has no can_only_write_to') })
  })
  test('a specialist that lists no server declaring login_command, and one that lists several (it asks for --server)', () => {
    expect(planBrowser(cfg(spec({ mcpServerNames: [] })), 'gem', {}, probes())).toMatchObject({ ok: false, error: expect.stringContaining('lists no server that declares login_command') })
    expect(planBrowser(cfg(spec(), { browser: server() }), 'gem', {}, probes())).toMatchObject({ ok: true })
    const two = cfg(spec({ mcpServerNames: ['a', 'b'] }), { a: server({ name: 'a' }), b: server({ name: 'b' }) })
    expect(planBrowser(two, 'gem', {}, probes())).toMatchObject({ ok: false, error: expect.stringContaining('--server') })
    expect(planBrowser(two, 'gem', { server: 'b' }, probes())).toMatchObject({ ok: true, server: 'b' })
    expect(planBrowser(two, 'gem', { server: 'zzz' }, probes())).toMatchObject({ ok: false })
  })
  test('a session (this is the operator\'s command, never a session\'s)', () => {
    expect(planBrowser(cfg(), 'gem', {}, probes({ isSession: true }))).toEqual({ ok: false, error: 'hydra specialist browser is for the operator at their own terminal; it is not run from a hydra session' })
  })
  test('a profile in use: a declared lock file is there; says which and how it knows, and to hydra kill first', () => {
    const r = planBrowser(cfg(), 'gem', {}, probes({ present: p => p === `${WORK}/.browser/profile/SingletonLock` }))
    expect(r).toMatchObject({ ok: false })
    expect((r as any).error).toContain(`${WORK}/.browser/profile/SingletonLock exists`)
    expect((r as any).error).toContain('a browser using that profile leaves')
    expect((r as any).error).toContain('`hydra kill')
  })
})

describe('the plan', () => {
  test('the command is the server\'s own login_command with the specialist\'s profile and download folders filled in', () => {
    expect(planBrowser(cfg(), 'gem', {}, probes())).toEqual({ ok: true, server: 'browser', profile: `${WORK}/.browser/profile`, downloads: `${WORK}/.browser/downloads`, state: 'missing', argv: ['/opt/b/browser', `--user-data-dir=${WORK}/.browser/profile`, '--no-first-run'] })
  })
  test('a named browser_profile is the folder, with its downloads beside it', () => {
    const r = planBrowser(cfg(spec({ browserProfile: `${WORK}/chrome-a` })), 'gem', {}, probes())
    expect(r).toMatchObject({ ok: true, profile: `${WORK}/chrome-a`, downloads: `${WORK}/chrome-a-downloads`, argv: ['/opt/b/browser', `--user-data-dir=${WORK}/chrome-a`, '--no-first-run'] })
  })
  test('lock files are looked up by name inside the profile folder, nothing else is read', () => {
    const looked: string[] = []
    planBrowser(cfg(), 'gem', {}, probes({ present: p => { looked.push(p); return false } }))
    expect(looked).toEqual([`${WORK}/.browser/profile/SingletonLock`, `${WORK}/.browser/profile/lockfile`])
  })
})

describe('the command', () => {
  const run = async (args: string[], over: Partial<Parameters<typeof browserCommand>[1]> = {}) => {
    const out: string[] = [], err: string[] = [], spawned: string[][] = [], made: string[] = [], marked: string[] = []
    const code = await browserCommand(args, { config: cfg(), probes: probes(), mkdir: d => made.push(d), mark: d => marked.push(d), spawn: async a => { spawned.push(a) }, log: l => out.push(l), error: l => err.push(l), ...over })
    return { code, out, err, spawned, made, marked }
  }
  test('opens it: makes the profile folders, marks the one it made, spawns exactly the planned command, and prints exactly what it opened, with the untrusted-profile note', async () => {
    const r = await run(['gem'])
    expect(r.code).toBe(0)
    expect(r.made).toEqual([`${WORK}/.browser/profile`, `${WORK}/.browser/downloads`])
    expect(r.marked).toEqual([`${WORK}/.browser/profile`])
    expect(r.spawned).toEqual([['/opt/b/browser', `--user-data-dir=${WORK}/.browser/profile`, '--no-first-run']])
    expect(r.out.join('\n')).toBe(`opened: /opt/b/browser --user-data-dir=${WORK}/.browser/profile --no-first-run\nprofile folder: ${WORK}/.browser/profile (downloads: ${WORK}/.browser/downloads)\nnote: ${UNTRUSTED_NOTE}\nlog in to what gem should have, then close the browser window; hydra did not read the profile`)
  })
  test('--dry-run prints the command and the note and spawns nothing, makes nothing', async () => {
    const r = await run(['gem', '--dry-run'])
    expect(r.code).toBe(0)
    expect(r.spawned).toEqual([]); expect(r.made).toEqual([])
    expect(r.out[0]).toContain('would open: /opt/b/browser')
  })
  test('a refusal exits 1, prints the cause, and spawns nothing', async () => {
    const r = await run(['gem'], { probes: probes({ present: () => true }) })
    expect(r.code).toBe(1); expect(r.spawned).toEqual([]); expect(r.made).toEqual([])
    expect(r.err.join('\n')).toContain('in use')
  })
  test('usage: no specialist, an unknown option', async () => {
    const none = await run([])
    expect(none.code).toBe(1)
    expect(none.err.join('\n')).toBe('usage: hydra [--state-dir <dir>] specialist browser <name> [--server <name>] [--trust-existing] [--dry-run]')
    expect((await run(['gem', '--nope'])).err.join('\n')).toContain('unknown option --nope')
  })
})

describe('a profile that something else filled (marker, --trust-existing)', () => {
  const populated = probes({ profileState: () => 'populated' })
  test('populated without the marker: refused, naming the marker and --trust-existing; nothing made, marked or spawned', async () => {
    const out: string[] = [], err: string[] = [], spawned: string[][] = [], marked: string[] = [], made: string[] = []
    const code = await browserCommand(['gem'], { config: cfg(), probes: populated, mkdir: d => made.push(d), mark: d => marked.push(d), spawn: async a => { spawned.push(a) }, log: l => out.push(l), error: l => err.push(l) })
    expect(code).toBe(1)
    expect(err.join('\n')).toContain(`has no ${LOGIN_MARKER}`)
    expect(err.join('\n')).toContain('--trust-existing')
    expect([spawned, marked, made]).toEqual([[], [], []])
  })
  test('--trust-existing opens it and marks it', async () => {
    const spawned: string[][] = [], marked: string[] = []
    const code = await browserCommand(['gem', '--trust-existing'], { config: cfg(), probes: populated, mkdir: () => {}, mark: d => marked.push(d), spawn: async a => { spawned.push(a) }, log: () => {}, error: () => {} })
    expect(code).toBe(0); expect(spawned).toHaveLength(1); expect(marked).toEqual([`${WORK}/.browser/profile`])
  })
  test('missing, empty and already-marked open without the flag; a marked one is not marked again', async () => {
    for (const [state, marks] of [['missing', 1], ['empty', 1], ['marked', 0]] as const) {
      const marked: string[] = []
      const code = await browserCommand(['gem'], { config: cfg(), probes: probes({ profileState: () => state }), mkdir: () => {}, mark: d => marked.push(d), spawn: async () => {}, log: () => {}, error: () => {} })
      expect([state, code, marked.length]).toEqual([state, 0, marks])
    }
  })
})

describe('a spawn that fails is a failure', () => {
  test('exit 1, the cause printed, and no "opened" line', async () => {
    const out: string[] = [], err: string[] = []
    const code = await browserCommand(['gem'], { config: cfg(), probes: probes(), mkdir: () => {}, mark: () => {}, spawn: async () => { throw new Error('spawn /opt/b/browser ENOENT') }, log: l => out.push(l), error: l => err.push(l) })
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('could not start /opt/b/browser: spawn /opt/b/browser ENOENT')
    expect(out.join('\n')).not.toContain('opened:')
  })
})

describe('the real filesystem probes (a temp folder; nothing is injected)', () => {
  const root = mkdtempSync(join(tmpdir(), 'hbrowser-'))
  const outside = join(root, 'outside'); mkdirSync(outside)
  const work = join(root, 'work'); mkdirSync(work)
  const real: BrowserProbes = { present: lstatPresent, isSession: false, realpath: nearestReal, profileState: realProfileState }
  const config = () => cfg(spec({ workdir: work }))
  test('Chromium\'s SingletonLock is a symlink to nothing while the browser runs: the lock probe sees it', () => {
    const profile = join(work, '.browser', 'profile'); mkdirSync(profile, { recursive: true })
    symlinkSync('host-1234', join(profile, 'SingletonLock'))   // dangling
    expect(existsSync(join(profile, 'SingletonLock'))).toBe(false)   // what a following check would say
    expect(lstatPresent(join(profile, 'SingletonLock'))).toBe(true)
    const r = planBrowser(config(), 'gem', {}, real)
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('SingletonLock exists') })
    rmSync(join(profile, 'SingletonLock'))
  })
  test('a profile folder swapped for a link out of the workdir is refused at run time, not followed', () => {
    rmSync(join(work, '.browser'), { recursive: true, force: true })
    symlinkSync(outside, join(work, '.browser'))
    const r = planBrowser(config(), 'gem', {}, real)
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('cannot be used now') })
    expect(readdirSync(outside)).toEqual([])   // nothing was made through the link
    rmSync(join(work, '.browser'))
  })
  test('the marker is written 0600 and the folders are brought to 0700 (an existing one too); an empty folder is "empty", a marked one "marked", a filled one "populated"', () => {
    const p = join(work, 'p'); mkdirSync(p, { mode: 0o755 })
    expect(realProfileState(p)).toBe('empty')
    realMkdir(p)
    expect(statSync(p).mode & 0o777).toBe(0o700)
    realMark(p)
    expect(statSync(join(p, LOGIN_MARKER)).mode & 0o777).toBe(0o600)
    expect(realProfileState(p)).toBe('marked')
    writeFileSync(join(work, 'q'), 'x'); mkdirSync(join(work, 'r')); writeFileSync(join(work, 'r', 'Preferences'), '{}')
    expect(realProfileState(join(work, 'r'))).toBe('populated')
    expect(realProfileState(join(work, 'nope'))).toBe('missing')
  })
  test('cleanup', () => { rmSync(root, { recursive: true, force: true }) })
})
