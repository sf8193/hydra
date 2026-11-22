import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const script = join(import.meta.dir, '..', '..', 'engines', 'agy-hook.ts')
const event = { conversationId: 'c-1', transcriptPath: '/t/transcript.jsonl', workspacePaths: ['/w'], modelName: 'gemini-4-neon-high' }

// agy runs the hook with the event on stdin and the session's environment.
function hook(name: string, input: object, state?: string) {
  const r = Bun.spawnSync([process.execPath, script, name], { stdin: Buffer.from(JSON.stringify(input)), env: { PATH: process.env.PATH!, ...(state ? { HYDRA_AGY_STATE: state } : {}) } })
  return { out: r.stdout.toString(), code: r.exitCode, state: state && existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : null }
}
const stateFile = () => join(mkdtempSync(join(tmpdir(), 'hydra-agy-hook-')), 'sess.json')

test('a session start and a model call say working, with the conversation and its transcript', () => {
  for (const name of ['SessionStart', 'PreInvocation']) {
    const r = hook(name, event, stateFile())
    expect(r).toMatchObject({ out: '{}', code: 0, state: { conversationId: 'c-1', transcriptPath: '/t/transcript.jsonl', live: 'working', backgroundWork: false } })
  }
})

test('a stop says idle, and says so when a command agy started still runs; agy is told to stop', () => {
  expect(hook('Stop', { ...event, fullyIdle: true }, stateFile())).toMatchObject({ out: '{"decision":"stop"}', state: { live: 'idle', backgroundWork: false } })
  expect(hook('Stop', { ...event, fullyIdle: false }, stateFile()).state).toMatchObject({ live: 'idle', backgroundWork: true })
})

test('a stop is answered even when the state cannot be written', () => {
  const r = hook('Stop', { ...event, fullyIdle: true }, join(tmpdir(), 'hydra-agy-no-such-folder', 'sess.json'))
  expect(r.out).toBe('{"decision":"stop"}')
})

test('a stop is answered even when its input is not JSON', () => {
  const r = Bun.spawnSync([process.execPath, script, 'Stop'], { stdin: Buffer.from('not json'), env: { PATH: process.env.PATH!, HYDRA_AGY_STATE: stateFile() } })
  expect(r.stdout.toString()).toBe('{"decision":"stop"}')
})

test('an agy outside a hydra session records nothing, and still answers a stop', () => {
  expect(hook('Stop', event)).toMatchObject({ out: '{"decision":"stop"}', code: 0 })
  expect(hook('PreInvocation', event)).toMatchObject({ out: '{}', code: 0 })
})

// One `sh` is one agy process: it is the hook's parent, as agy is in a real run.
function hooksFrom(one: Array<[string, object]>, state: string) {
  const cmd = one.map(([name]) => `${process.execPath} ${script} ${name} < $IN${one.findIndex(([n]) => n === name)}`).join('; ')
  const env: Record<string, string> = { PATH: process.env.PATH!, HYDRA_AGY_STATE: state }
  one.forEach(([, input], i) => { const f = join(mkdtempSync(join(tmpdir(), 'hydra-agy-in-')), 'in.json'); writeFileSync(f, JSON.stringify(input)); env[`IN${i}`] = f })
  Bun.spawnSync(['sh', '-c', `${cmd}; true`], { env })
}

test('an agy run started by a session (another process) does not overwrite the session\'s file; the session\'s own later events still do', () => {
  const state = stateFile()
  hooksFrom([['SessionStart', event], ['PreInvocation', event]], state)
  hooksFrom([['SessionStart', { ...event, conversationId: 'child' }], ['Stop', { ...event, conversationId: 'child', fullyIdle: true }]], state)
  expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ conversationId: 'c-1', live: 'working' })
})
