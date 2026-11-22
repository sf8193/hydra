// The operator tagging the bot in a new channel writes it into hydra.toml, and the same message goes on.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { gateway } from '../config.js'
import { admitTaggedChannel, channelAllowed, gate } from '../access.js'
import { _setHydraConfigForTesting, hydraConfigPath, startHydraConfig, stopHydraConfig } from '../hydra-config.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'
import type { InboundMessage } from '../../gateways/gateway.js'

// The suite runs as the discord platform (CHAT_PLATFORM unset).
const BASE = '# mine\noperator = "op"\n[people.op]\naddresses = ["discord:100"]\n'
const msg = (over: Partial<InboundMessage> = {}) => ({ id: 'm1', isDM: false, authorId: '100', channelId: '300000000000000009', parentChannelId: null, content: 'hi', ...over }) as unknown as InboundMessage
// The once-per-channel memory outlives a test, so the busy-lock test uses a channel of its own.
const BUSY_CH = '300000000000000011'
const sent: string[] = []
let tagged = true
const spies: Array<{ mockRestore(): void }> = []

beforeEach(() => {
  sent.length = 0
  tagged = true
  spies.push(spyOn(gateway, 'isMentioned').mockImplementation((async () => tagged) as any))
  spies.push(spyOn(gateway, 'send').mockImplementation((async (_c: string, text: string) => { sent.push(text); return { id: 'x' } }) as any))
})
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
  _setHydraConfigForTesting(undefined); stopHydraConfig(); rmSync(hydraConfigPath(), { force: true })
})
const start = (toml: string) => { writeFileSync(hydraConfigPath(), toml); startHydraConfig({ env: { ...testLoadEnv({ home: '/h', sessionNames: [] }), isDir: () => true } }) }

describe('tag to admit, where hydra.toml governs', () => {
  test('the operator\'s tag writes the channel into hydra.toml, keeps the file\'s text, and the same message is then delivered', async () => {
    start(BASE)
    expect(channelAllowed(msg())).toBe(false)
    expect(await admitTaggedChannel(msg())).toBe(true)
    const text = readFileSync(hydraConfigPath(), 'utf8')
    expect(text.startsWith(BASE)).toBe(true)
    expect(text).toContain('[places."discord:300000000000000009".access]')
    expect(text).toContain('allow = ["op"]')
    expect(channelAllowed(msg())).toBe(true)
    expect((await gate(msg())).action).toBe('deliver')
    expect(existsSync(join(dirname(hydraConfigPath()), 'access.json'))).toBe(false)
  })
  test('what is written is exactly: tag required, the operator only, session threads listen', async () => {
    start(BASE)
    await admitTaggedChannel(msg())
    expect(readFileSync(hydraConfigPath(), 'utf8').slice(BASE.length)).toBe('\n[places."discord:300000000000000009".access]\nmention = true\nallow = ["op"]\nlisten = true\n')
  })
  test('a hydra.toml that has gone missing is told as a refusal, not thrown', async () => {
    start(BASE)
    rmSync(hydraConfigPath())
    expect(await admitTaggedChannel(msg())).toBe(false)
    expect(sent[0]).toContain("can't be read")
  })
  test('a busy lock is not told, does not use up the channel\'s one telling, and the next tag admits', async () => {
    start(BASE)
    const lock = join(dirname(hydraConfigPath()), 'hydra.toml.lock')
    writeFileSync(lock, '')
    try {
      expect(await admitTaggedChannel(msg({ channelId: BUSY_CH }))).toBe(false)
      expect(await admitTaggedChannel(msg({ id: 'm2', channelId: BUSY_CH }))).toBe(false)
    } finally { rmSync(lock, { force: true }) }
    expect(sent).toHaveLength(0)
    expect(await admitTaggedChannel(msg({ id: 'm3', channelId: BUSY_CH }))).toBe(true)
  })
  test('two tags in a new channel at once admit it once; the second is delivered, not refused', async () => {
    start(BASE)
    const [a, b] = await Promise.all([admitTaggedChannel(msg()), admitTaggedChannel(msg({ id: 'm2' }))])
    expect([a, b]).toEqual([true, true])
    expect(readFileSync(hydraConfigPath(), 'utf8').split('.access]').length).toBe(2)
    expect(sent).toEqual([])
  })
  test('a tag in a thread admits the parent channel', async () => {
    start(BASE)
    expect(await admitTaggedChannel(msg({ channelId: '300000000000000010', parentChannelId: '300000000000000009' }))).toBe(true)
    expect(readFileSync(hydraConfigPath(), 'utf8')).toContain('[places."discord:300000000000000009".access]')
  })
  test('no tag, or a tag from someone else, writes nothing', async () => {
    start(BASE)
    tagged = false
    expect(await admitTaggedChannel(msg())).toBe(false)
    tagged = true
    expect(await admitTaggedChannel(msg({ authorId: '999' }))).toBe(false)
    expect(readFileSync(hydraConfigPath(), 'utf8')).toBe(BASE)
  })
  test('a write hydra.toml cannot take is told to the operator once per channel, and admits nothing', async () => {
    // an inline place cannot grow a sub-table
    const inline = `${BASE}[places]\n"discord:300000000000000009" = { ack = "eyes" }\n`
    start(inline)
    expect(await admitTaggedChannel(msg())).toBe(false)
    expect(await admitTaggedChannel(msg({ id: 'm2' }))).toBe(false)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain("can't add this channel to hydra.toml")
    expect(readFileSync(hydraConfigPath(), 'utf8')).toBe(inline)
    expect(channelAllowed(msg())).toBe(false)
  })
})
