import { test, expect } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { join } from 'path'
import {
  SCRUBBED_SPAWN_VARS, SWEEP_ARGV, TMUX_PANE_FD_LIMIT,
  captureSpawnVars, codexSpawnEnv, scrubbedSpawnEnv, tmuxNewSession, withRaisedFdLimit,
} from '../spawn-env.js'

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try { fn() } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
// Line-anchored: an unanchored // also eats a URL inside a string literal,
// which would hide a real tmux call on the same line.
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('scrubbedSpawnEnv drops every scrubbed var, keeps the rest, and does not mutate its input', () => {
  const base = { PATH: '/bin', UNRELATED: 'keep' } as NodeJS.ProcessEnv
  for (const v of SCRUBBED_SPAWN_VARS) base[v] = 'seeded'
  const out = scrubbedSpawnEnv(base)
  for (const v of SCRUBBED_SPAWN_VARS) expect(out[v]).toBeUndefined()
  expect(out.PATH).toBe('/bin')
  expect(out.UNRELATED).toBe('keep')
  expect(base.RAINDROP_WRITE_KEY).toBe('seeded')
})

test('called with no argument it scrubs the live environment, not an empty one', () => {
  withEnv({ RAINDROP_WRITE_KEY: 'rk_seeded' }, () => {
    const out = scrubbedSpawnEnv()
    expect(out.RAINDROP_WRITE_KEY).toBeUndefined()
    expect(out.PATH).toBe(process.env.PATH)
  })
})

test('captureSpawnVars returns the values and removes them from the environment', () => {
  const env: NodeJS.ProcessEnv = { PATH: '/bin', RAINDROP_WRITE_KEY: 'rk_x', RAINDROP_MODE: 'live' }
  const captured = captureSpawnVars(env)
  expect(captured.RAINDROP_WRITE_KEY).toBe('rk_x')
  expect(captured.RAINDROP_MODE).toBe('live')
  for (const v of SCRUBBED_SPAWN_VARS) expect(env[v]).toBeUndefined()
  expect(env.PATH).toBe('/bin')
  // Nothing may hand the values back to process.env later.
  expect(Object.isFrozen(captured)).toBe(true)
  expect(captureSpawnVars(env)).toEqual({})
})

test('a captured key is absent from a real forked child', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-cap-'))
  const script = join(dir, 'cap.ts')
  writeFileSync(script, [
    'import { captureSpawnVars } from ' + JSON.stringify(join(ROOT, 'shared/spawn-env.ts')),
    "process.env.RAINDROP_WRITE_KEY = 'rk_forked'",
    'const captured = captureSpawnVars()',
    "const out = Bun.spawnSync(['sh', '-c', " + JSON.stringify("echo ${RAINDROP_WRITE_KEY:-absent}") + '])',
    'console.log(captured.RAINDROP_WRITE_KEY, out.stdout.toString().trim())',
  ].join('\n'))
  const proc = Bun.spawnSync([process.execPath, script])
  expect(new TextDecoder().decode(proc.stdout).trim()).toBe('rk_forked absent')
})

test('the fd-limit prefix runs before the command and tolerates a shell that rejects it', () => {
  expect(withRaisedFdLimit('exec claude')).toBe(`ulimit -n ${TMUX_PANE_FD_LIMIT} 2>/dev/null; exec claude`)
  expect(TMUX_PANE_FD_LIMIT).toBeGreaterThan(256)
})

test('the scrubbed set is exactly these four', () => {
  expect([...SCRUBBED_SPAWN_VARS]).toEqual(
    ['RAINDROP_WRITE_KEY', 'RAINDROP_MODE', 'RAINDROP_USER_ID', 'RAINDROP_OMIT_REPO'],
  )
})

function capture() {
  const calls: Array<{ argv: string[]; opts: any }> = []
  const exec = ((_bin: string, argv: string[], opts: any) => { calls.push({ argv, opts }); return '' }) as any
  return { calls, exec }
}

test('tmuxNewSession sweeps every var in one call, before it creates the session', () => {
  const { calls, exec } = capture()
  tmuxNewSession(['-d', '-s', 'probe'], {}, exec)
  expect(calls).toHaveLength(2)
  expect(calls[0].argv).toEqual([
    'set-environment', '-gr', 'RAINDROP_WRITE_KEY',
    ';', 'set-environment', '-gr', 'RAINDROP_MODE',
    ';', 'set-environment', '-gr', 'RAINDROP_USER_ID',
    ';', 'set-environment', '-gr', 'RAINDROP_OMIT_REPO',
  ])
  expect(calls[0].argv).toEqual([...SWEEP_ARGV])
  expect(calls[1].argv).toEqual(['new-session', '-d', '-s', 'probe'])
})

test('the sweep is bounded well under the spawn budget it shares', () => {
  const { calls, exec } = capture()
  tmuxNewSession(['-d', '-s', 'probe'], { encoding: 'utf8', timeout: 2000 }, exec)
  const [sweep, spawn] = calls
  expect(sweep.opts.timeout).toBeGreaterThan(0)
  expect(sweep.opts.timeout).toBeLessThanOrEqual(500)
  expect(sweep.opts.encoding).toBe('utf8')
  expect(spawn.opts.timeout).toBe(2000)
})

test('a caller asking for less than the sweep bound still gets its own bound', () => {
  const { calls, exec } = capture()
  tmuxNewSession(['-d', '-s', 'probe'], { timeout: 50 }, exec)
  for (const c of calls) expect(c.opts.timeout).toBe(50)
})

test('timeout 0 bounds the sweep rather than making it a no-timeout call', () => {
  const { calls, exec } = capture()
  tmuxNewSession(['-d', '-s', 'probe'], { timeout: 0 }, exec)
  expect(calls[0].opts.timeout).toBe(500)
  expect(calls[1].opts.timeout).toBe(0)
})

test('tmuxNewSession hands tmux an environment with no scrubbed var in it', () => {
  const { calls, exec } = capture()
  const seeded = Object.fromEntries(SCRUBBED_SPAWN_VARS.map(v => [v, 'seeded'])) as NodeJS.ProcessEnv
  tmuxNewSession(['-d', '-s', 'probe'], { env: { ...seeded, PATH: '/bin' } }, exec)
  for (const c of calls) {
    for (const v of SCRUBBED_SPAWN_VARS) expect(c.opts.env[v]).toBeUndefined()
  }
  expect(calls[calls.length - 1].opts.env.PATH).toBe('/bin')
})


function sweepFailing(stderr: string): { warned: string[]; spawned: boolean } {
  const warned: string[] = []
  let spawned = false
  const exec = ((_b: string, argv: string[]) => {
    if (argv[0] === 'new-session') { spawned = true; return '' }
    throw Object.assign(new Error('Command failed'), { status: 1, stderr })
  }) as any
  const real = process.stderr.write
  process.stderr.write = ((c: string) => { warned.push(String(c)); return true }) as typeof process.stderr.write
  try { tmuxNewSession(['-d', '-s', 'probe'], {}, exec) } finally { process.stderr.write = real }
  return { warned, spawned }
}

test.each([
  'no server running on /private/tmp/tmux-501/default',
  'error connecting to /private/tmp/tmux-501/default (No such file or directory)',
])('no tmux server yet is a cold start, not a failure to report: %p', (stderr) => {
  const { warned, spawned } = sweepFailing(stderr)
  expect(warned.join('')).toBe('')
  expect(spawned).toBe(true)
})

test('a sweep that fails against a running server is reported, naming every var', () => {
  const { warned, spawned } = sweepFailing('unknown command: set-environment')
  for (const v of SCRUBBED_SPAWN_VARS) expect(warned.join('')).toContain(v)
  expect(warned.join('')).toContain('may inherit')
  expect(spawned).toBe(true)
})

test('tmuxNewSession defaults to the live environment, scrubbed', () => {
  withEnv({ RAINDROP_WRITE_KEY: 'rk_seeded' }, () => {
    const { calls, exec } = capture()
    tmuxNewSession(['-d', '-s', 'probe'], {}, exec)
    expect(calls[0].opts.env.RAINDROP_WRITE_KEY).toBeUndefined()
    expect(calls[0].opts.env.PATH).toBe(process.env.PATH)
  })
})

test('codexSpawnEnv scrubs, keeps the rest, and cannot be overridden by its caller', () => {
  const seeded = Object.fromEntries(SCRUBBED_SPAWN_VARS.map(v => [v, 'seeded'])) as NodeJS.ProcessEnv
  const out = codexSpawnEnv({ ...seeded, CODEX_HOME: '/tmp/ch' })
  for (const v of SCRUBBED_SPAWN_VARS) expect(out[v]).toBeUndefined()
  expect(out.CODEX_HOME).toBe('/tmp/ch')
  expect(out.PATH).toBe(process.env.PATH)
})

test('codexSpawnEnv with no argument still scrubs the live environment', () => {
  withEnv({ RAINDROP_WRITE_KEY: 'rk_seeded' }, () => {
    expect(codexSpawnEnv().RAINDROP_WRITE_KEY).toBeUndefined()
    expect(codexSpawnEnv().PATH).toBe(process.env.PATH)
  })
})

// zsh is absent on ubuntu-latest, and Bun.spawnSync throws on a missing binary.
const SHELLS = ['bash', 'sh', ...(Bun.which('zsh') ? ['zsh'] : [])]

function runScrub(sh: string, withTmuxShim: boolean): { out: string; code: number | null; swept: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rd-scrub-'))
  copyFileSync(join(ROOT, 'scrub-raindrop.sh'), join(dir, 'scrub.sh'))
  const log = join(dir, 'tmux.log')
  let path = '/usr/bin:/bin'
  if (withTmuxShim) {
    writeFileSync(join(dir, 'tmux'), `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 })
    path = `${dir}:${path}`
  }
  const seeded = Object.fromEntries(SCRUBBED_SPAWN_VARS.map(v => [v, 'seeded']))
  const proc = Bun.spawnSync([sh, '-c', '. ./scrub.sh; env'], { cwd: dir, env: { PATH: path, ...seeded } })
  let swept = ''
  try { swept = readFileSync(log, 'utf8') } catch {}
  return { out: new TextDecoder().decode(proc.stdout), code: proc.exitCode, swept }
}

test.each(SHELLS)('scrub-raindrop.sh unsets under %s, with tmux absent', (sh) => {
  const { out, code } = runScrub(sh, false)
  expect(code, `${sh} exit`).toBe(0)
  expect(out, `${sh} produced no env`).toContain('PATH=')
  for (const v of SCRUBBED_SPAWN_VARS) expect(out, `${sh}/${v}`).not.toContain(`${v}=`)
})

test.each(SHELLS)('scrub-raindrop.sh sweeps an already-running server under %s', (sh) => {
  const { swept } = runScrub(sh, true)
  const lines = swept.trim().split('\n').filter(Boolean).sort()
  expect(lines).toEqual(SCRUBBED_SPAWN_VARS.map(v => `set-environment -gr ${v}`).sort())
})

function walk(dir: string, keep: (f: string) => boolean, acc: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const rel = dir === '.' ? e : join(dir, e)
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, keep, acc)
    else if (keep(e)) acc.push(rel)
  }
  return acc
}

const flat = (f: string) => strip(read(f)).replace(/\s+/g, ' ')
const CREATES_SESSION = /[`'"]new-session[`'"]|\btmux\b[^;|&]{0,80}?\bnew\b(?!-window)/

const TS_SOURCES = () => walk('.', f => /\.(m|c)?tsx?$/.test(f) && !/\.test\.[mc]?tsx?$/.test(f))

test('only shared/spawn-env.ts creates a tmux session', () => {
  const offenders = TS_SOURCES()
    .filter(f => f !== 'shared/spawn-env.ts')
    .filter(f => CREATES_SESSION.test(flat(f)))
  expect(offenders).toEqual([])
})

// `spawn\w*\(` also matches a declaration whose params mention the 'codex' literal.
const CALL_OPENER = /\b(?:Bun\.)?(?:execFileSync|execFile|execSync|exec|spawnSync|spawn)\(/g
const MENTIONS_CODEX = /['"`]codex['"`]|\bcodex (?:mcp|resume|exec)\b/

function codexCalls(src: string): { call: string; opaque: boolean; codex: boolean }[] {
  const calls: { call: string; opaque: boolean; codex: boolean }[] = []
  for (const m of src.matchAll(CALL_OPENER)) {
    const open = m.index + m[0].length - 1
    let depth = 0
    let end = -1
    let quote = ''
    for (let i = open; i < src.length; i++) {
      const c = src[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = ''
        continue
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue }
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) { end = i; break }
    }
    if (end < 0) continue
    const call = src.slice(m.index, end + 1)
    // A binary passed as a variable hides which program is being run.
    const opaque = /^[\w.]+\(\s*[A-Za-z_$][\w$]*\s*[,)]/.test(call)
    calls.push({ call, opaque, codex: MENTIONS_CODEX.test(call) })
  }
  return calls
}

test('every call that spawns codex builds its env through codexSpawnEnv', () => {
  const byFile = new Map(TS_SOURCES().map(f => [f, codexCalls(flat(f))]))
  const matched = [...byFile].filter(([, c]) => c.some(x => x.codex)).map(([f]) => f)
  expect(matched.sort(), 'an exact set, not a floor — a fourth site needs a human').toEqual([
    'cli/hydra.ts', 'daemon/codex-process.ts', 'daemon/engines/codex-engine-adapter.ts',
  ])
  const codexOnly = matched.flatMap(f => byFile.get(f)!.filter(x => x.codex))
  expect(codexOnly, 'a mis-parsed paren balance would merge or drop calls').toHaveLength(3)
  for (const { call } of codexOnly) {
    expect(call).toContain('codexSpawnEnv(')
    expect(call).not.toMatch(/process\.env/)
    expect(call).not.toMatch(/execEnv\(\)/)
  }
  // Inside these files a hoisted binary would make the scan above blind.
  for (const f of matched) {
    const hidden = byFile.get(f)!.filter(x => x.opaque).map(x => x.call.slice(0, 60))
    expect(hidden, `${f} spawns a variable binary this scan cannot resolve`).toEqual([])
  }
})

const shellSpawners = () => walk('.', f => /\.(sh|bash|zsh)$/.test(f)).filter(f => CREATES_SESSION.test(flat(f)))

test('every shell entrypoint that creates a tmux server scrubs both halves first', () => {
  expect(shellSpawners().sort()).toEqual(['start-byte.sh', 'start-daemon.sh', 'start-transcribe.sh'])
  for (const f of shellSpawners()) {
    // Every offset below must index this one string, or the window goes empty.
    const src = read(f).replace(/\\\n\s*/g, ' ')
    const at = src.search(/^\s*(source|\.)\s+\S*(scrub-raindrop|env-setup)\.sh/m)
    expect(at, `${f} sources neither scrub-raindrop.sh nor env-setup.sh`).toBeGreaterThanOrEqual(0)
    const creates = src.search(/\bnew-session\b|\btmux\s+new\b/)
    expect(creates, `${f} no longer creates a session`).toBeGreaterThanOrEqual(0)
    expect(at, `${f} scrubs after it creates the session`).toBeLessThan(creates)
    const last = Math.max(src.lastIndexOf('scrub-raindrop'), src.lastIndexOf('env-setup'))
    const between = src.slice(last, creates)
    expect(between.length, `${f} scrub/spawn window is empty — offsets disagree`).toBeGreaterThan(0)
    expect(between, `${f} re-reads a .env after scrubbing`).not.toMatch(/\.env\b/)
    expect(between, `${f} re-exports a RAINDROP_ var after scrubbing`)
      .not.toMatch(/RAINDROP_\w*=|export\s+RAINDROP_/)
  }
})

test('the shared scrub covers exactly the scrubbed set', () => {
  const loop = /^for _rd_v in ([^;]+); do/m.exec(read('scrub-raindrop.sh'))
  expect(loop, 'scrub loop not found').toBeTruthy()
  expect(loop![1].trim().split(/\s+/).sort()).toEqual([...SCRUBBED_SPAWN_VARS].sort())
})

// Vacuous where no .env exists (CI); the point is the machine that holds the
// secret, which is also the machine the pre-push gate runs on.
test('no real credential from a state-dir .env appears anywhere in the repo', () => {
  const homes = ['slack', 'discord']
    .map(p => join(homedir(), '.claude', 'channels', p, '.env'))
    .filter(p => existsSync(p))
  const secrets: Array<{ name: string; value: string }> = []
  for (const envPath of homes) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET))\s*=\s*(.*)$/.exec(line)
      if (!m) continue
      const value = m[2].trim().replace(/^["']|["']$/g, '')
      if (value.length >= 12) secrets.push({ name: m[1], value })
    }
  }
  const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: ROOT, stdout: 'pipe' })
    .stdout.toString().split('\n').filter(Boolean)
  const offenders: string[] = []
  for (const f of tracked) {
    let body: string
    try { body = readFileSync(join(ROOT, f), 'utf8') } catch { continue }
    for (const { name, value } of secrets) {
      if (body.includes(value)) offenders.push(`${f} contains the live value of ${name}`)
    }
  }
  expect(offenders).toEqual([])
})

function runGuard(dir: string, env: Record<string, string>): { out: string; code: number | null } {
  const frag = /if \[ -f "\$SCRIPT_DIR\/scrub-raindrop\.sh" \][\s\S]*?\nfi\n/.exec(read('env-setup.sh'))
  if (!frag) throw new Error('guard block not found in env-setup.sh')
  const script = join(dir, 'guard.sh')
  writeFileSync(script, `set -euo pipefail\nSCRIPT_DIR=${dir}\n${frag[0]}echo REACHED_SPAWN\n`)
  const proc = Bun.spawnSync(['bash', script], { env: { PATH: '/usr/bin:/bin', ...env } })
  return {
    out: new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr),
    code: proc.exitCode,
  }
}

// Refusing to boot is right only when there is a key to protect: env-setup.sh
// is also watchdog.sh's preamble, and its exit leaves the fleet unsupervised.
test.each([
  ['a key is set', { RAINDROP_WRITE_KEY: 'rk_x' }, 1, false],
  ['only a mode is set', { RAINDROP_MODE: 'live' }, 1, false],
  ['no raindrop var is set', {}, 0, true],
])('a missing scrub with %s exits %p', (_label, env, code, reachesSpawn) => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-guard-'))
  const r = runGuard(dir, env as Record<string, string>)
  expect(r.code, r.out).toBe(code)
  expect(r.out.includes('REACHED_SPAWN'), r.out).toBe(reachesSpawn)
})

test('a present scrub runs and the spawn proceeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rd-guard-ok-'))
  writeFileSync(join(dir, 'scrub-raindrop.sh'), ': \n')
  const r = runGuard(dir, { RAINDROP_WRITE_KEY: 'rk_x' })
  expect(r.code, r.out).toBe(0)
  expect(r.out).toContain('REACHED_SPAWN')
})

test('env-setup.sh sources the scrub after the .env, not before', () => {
  const src = read('env-setup.sh')
  // lastIndexOf: a .env re-sourced after the scrub would restore every var.
  expect(src.search(/scrub-raindrop\.sh/)).toBeGreaterThan(src.lastIndexOf('"$STATE_DIR/.env"'))
})

