// The operator hears a refused boot in a DM, once, even though the daemon is not running: the web API with the bot token, no gateway.
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { alertOperator, alertOperatorOnce, operatorId } from '../boot-refusal-alert.js'
import { noteBootRefusal } from '../boot-refusal.js'

let dir: string
const state = (files: Record<string, string>) => {
  dir = mkdtempSync(join(tmpdir(), 'hydra-alert-'))
  for (const [f, v] of Object.entries(files)) writeFileSync(join(dir, f), v)
  return dir
}
const calls: { url: string; body: any; auth: string }[] = []
const fetchSpy = (replies: object[]) => spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: any) => {
  calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization })
  return { json: async () => replies.shift() }
}) as any)
afterEach(() => { calls.length = 0; if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('operatorId', () => {
  const TOML = 'operator = "me"\n[people.me]\naddresses = ["discord:7", "slack:U9"]\n'
  test('the operator\'s address in hydra.toml; else the first allowFrom of access.json', () => {
    expect(operatorId(state({ 'hydra.toml': TOML }), 'slack')).toBe('U9')
    expect(operatorId(state({ 'access.json': '{"allowFrom":["U1","U2"]}' }), 'slack')).toBe('U1')
    expect(operatorId(state({}), 'slack')).toBeUndefined()
  })
  test('hydra.toml wins over a stale access.json, and a corrupt access.json does not hide hydra.toml', () => {
    expect(operatorId(state({ 'hydra.toml': TOML, 'access.json': '{"allowFrom":["U1"]}' }), 'slack')).toBe('U9')
    expect(operatorId(state({ 'hydra.toml': TOML, 'access.json': '{ nope' }), 'slack')).toBe('U9')
  })
})

describe('alertOperator', () => {
  test('slack: opens the operator\'s DM, then posts the text', async () => {
    const f = fetchSpy([{ ok: true, channel: { id: 'D1' } }, { ok: true }])
    const d = state({ 'access.json': '{"allowFrom":["U1"]}', '.env': 'SLACK_BOT_TOKEN=xoxb-abc\n' })
    expect(await alertOperator(d, 'slack', 'run hydra migrate')).toBeUndefined()
    f.mockRestore()
    expect(calls.map(c => c.url)).toEqual(['https://slack.com/api/conversations.open', 'https://slack.com/api/chat.postMessage'])
    expect(calls[0].body).toEqual({ users: 'U1' })
    expect(calls[1].body).toEqual({ channel: 'D1', text: 'run hydra migrate' })
    expect(calls[1].auth).toBe('Bearer xoxb-abc')
  })
  test('discord: opens a DM with the recipient, then sends the message', async () => {
    const f = fetchSpy([{ id: 'C1' }, { id: 'M1' }])
    const d = state({ 'access.json': '{"allowFrom":["77"]}', '.env': 'DISCORD_BOT_TOKEN=tok\n' })
    expect(await alertOperator(d, 'discord', 'run hydra migrate')).toBeUndefined()
    f.mockRestore()
    expect(calls[0].body).toEqual({ recipient_id: '77' })
    expect(calls[1].url).toBe('https://discord.com/api/v10/channels/C1/messages')
    expect(calls[1].auth).toBe('Bot tok')
  })
  test('a token written as `export KEY=value` is read, as the daemon reads it', async () => {
    const f = fetchSpy([{ ok: true, channel: { id: 'D1' } }, { ok: true }])
    const d = state({ 'access.json': '{"allowFrom":["U1"]}', '.env': 'export SLACK_BOT_TOKEN="xoxb-abc"\n' })
    expect(await alertOperator(d, 'slack', 'x')).toBeUndefined()
    f.mockRestore()
    expect(calls[0].auth).toBe('Bearer xoxb-abc')
  })
  test('a failure is returned as a reason, never thrown', async () => {
    const f = fetchSpy([{ ok: false, error: 'not_authed' }])
    const d = state({ 'access.json': '{"allowFrom":["U1"]}', '.env': 'SLACK_BOT_TOKEN=xoxb-abc\n' })
    expect(await alertOperator(d, 'slack', 'x')).toBe('conversations.open: not_authed')
    f.mockRestore()
    expect(await alertOperator(state({ 'access.json': '{"allowFrom":["U1"]}' }), 'slack', 'x')).toContain('no SLACK_BOT_TOKEN')
  })
})

describe('alertOperatorOnce (the watchdog tick)', () => {
  const tick = async (d: string, send: () => Promise<string | undefined>, log: string[] = []) => {
    noteBootRefusal(d, 'why', 1)
    await alertOperatorOnce(d, 'slack', 'why', 'text', m => log.push(m), send as any)
  }
  test('a sent DM is not sent again on the next tick', async () => {
    const d = state({}); let sends = 0
    await tick(d, async () => { sends++; return undefined })
    await tick(d, async () => { sends++; return undefined })
    expect(sends).toBe(1)
  })
  test('a failed DM is logged and tried again, five times in all', async () => {
    const d = state({}); let sends = 0; const log: string[] = []
    for (let i = 0; i < 8; i++) await tick(d, async () => { sends++; return 'not_authed' }, log)
    expect(sends).toBe(5)
    expect(log[0]).toBe('could not tell the operator: not_authed')
  })
  test('a new reason is a new DM', async () => {
    const d = state({}); let sends = 0
    await alertOperatorOnce(d, 'slack', 'one', 't', () => {}, (async () => { sends++; return undefined }) as any)
    noteBootRefusal(d, 'two', 2)
    await alertOperatorOnce(d, 'slack', 'two', 't', () => {}, (async () => { sends++; return undefined }) as any)
    expect(sends).toBe(2)
  })
})
