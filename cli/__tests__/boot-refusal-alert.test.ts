// The operator hears a refused boot in a DM, once, even though the daemon is not running: the web API with the bot token, no gateway.
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { alertOperator, operatorId } from '../boot-refusal-alert.js'

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
  test('the first allowFrom of access.json; else the operator\'s address in hydra.toml', () => {
    expect(operatorId(state({ 'access.json': '{"allowFrom":["U1","U2"]}' }), 'slack')).toBe('U1')
    expect(operatorId(state({ 'hydra.toml': 'operator = "me"\n[people.me]\naddresses = ["discord:7", "slack:U9"]\n' }), 'slack')).toBe('U9')
    expect(operatorId(state({}), 'slack')).toBeUndefined()
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
  test('a failure is returned as a reason, never thrown', async () => {
    const f = fetchSpy([{ ok: false, error: 'not_authed' }])
    const d = state({ 'access.json': '{"allowFrom":["U1"]}', '.env': 'SLACK_BOT_TOKEN=xoxb-abc\n' })
    expect(await alertOperator(d, 'slack', 'x')).toBe('conversations.open: not_authed')
    f.mockRestore()
    expect(await alertOperator(state({ 'access.json': '{"allowFrom":["U1"]}' }), 'slack', 'x')).toContain('no such file')
  })
})
