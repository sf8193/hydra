import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const script = join(import.meta.dir, '..', 'agy-hook.ts')
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
