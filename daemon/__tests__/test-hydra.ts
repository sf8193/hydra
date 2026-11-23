// A test's stand-in for hydra.toml: who the operator is on this platform, and which channels the daemon admits.
import { PLATFORM } from '../../infra/config.js'
import { _setHydraConfigForTesting } from '../../infra/hydra-config.js'
import { loadHydraConfig } from '../../config/load.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'
import type { Address, ChannelGate, GateSettings, HydraConfig } from '../../config/types.js'

type Channel = { requireMention?: boolean; threadReply?: boolean; listen?: boolean; onlyOperators?: boolean }
/** `specialists` is hydra.toml text declaring them (`[specialists.x]` tables): the config is then loaded, as the daemon does. */
export type TestHydra = { operators?: string[]; channels?: Record<string, Channel>; gate?: GateSettings; specialists?: string; botChannels?: string[] }

/** Installs the config; the returned handle restores the file's own (as a spy's mockRestore does). */
export function setHydra({ operators = [], channels = {}, gate, specialists, botChannels = [] }: TestHydra = {}): { mockRestore(): void } {
  const gates: Record<string, ChannelGate> = Object.fromEntries(Object.entries(channels).map(([id, c]) => [`${PLATFORM}:${id}`, {
    access: { mention: c.requireMention ?? true, allow: c.onlyOperators ? ['operator'] : 'anyone' as 'anyone' | string[], ...(c.listen !== undefined && { listen: c.listen }) },
    ...(c.threadReply !== undefined && { threadReply: c.threadReply }),
  }]))
  const people: HydraConfig['people'] = operators.length ? { operator: { id: 'operator', addresses: operators.map(o => `${PLATFORM}:${o}` as Address), roles: [], name: 'operator' } } : {}
  const base: HydraConfig = {
    ...(operators.length && { operator: 'operator' }),
    connectors: {}, gateways: {}, slackApps: {}, specialists: {}, schedules: {}, rules: [], channels: gates,
    places: Object.fromEntries(botChannels.map(id => [`${PLATFORM}:${id}`, { files: false, messages: 'addressed' as const, bots: true, reactions: 'off' as const, linkPreviews: true }])),
    ...(gate && { gateSettings: { [PLATFORM]: gate } }),
    people,
  }
  let config = base
  if (specialists) {
    const text = `operator = "operator"\n[people.operator]\naddresses = [${operators.map(o => JSON.stringify(`${PLATFORM}:${o}`)).join(', ')}]\n${specialists}`
    const loaded = loadHydraConfig(text, { ...testLoadEnv({ home: '/h', sessionNames: [] }), isDir: () => true })
    if (!loaded.ok) throw new Error(`test specialists must load: ${loaded.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`)
    config = { ...loaded.config, channels: gates, ...(gate && { gateSettings: { [PLATFORM]: gate } }) }
  }
  _setHydraConfigForTesting(config)
  return { mockRestore: () => _setHydraConfigForTesting(undefined) }
}
