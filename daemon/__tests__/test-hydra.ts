// A test's stand-in for hydra.toml: who the operator is on this platform, and which channels the daemon admits.
import { PLATFORM } from '../../infra/config.js'
import { _setHydraConfigForTesting } from '../../infra/hydra-config.js'
import { loadHydraConfig } from '../../config/load.js'
import { testLoadEnv } from '../../config/__tests__/load-env.js'
import type { Address, ChannelGate, GateSettings, HydraConfig } from '../../config/types.js'

/** `allow`: people (ids in `people`) the channel hears, instead of anyone. */
type Channel = { requireMention?: boolean; threadReply?: boolean; listen?: boolean; onlyOperators?: boolean; allow?: string[] }
/** `specialists` is hydra.toml text declaring them (`[specialists.x]` tables): the config is then loaded, as the daemon does. */
/** `people`: each person's ids on this platform, besides the operator. */
export type TestHydra = { operators?: string[]; channels?: Record<string, Channel>; gate?: GateSettings; specialists?: string; people?: Record<string, string[]> }

/** Installs the config; the returned handle restores the file's own (as a spy's mockRestore does). */
export function setHydra({ operators = [], channels = {}, gate, specialists, people: others = {} }: TestHydra = {}): { mockRestore(): void } {
  const gates: Record<string, ChannelGate> = Object.fromEntries(Object.entries(channels).map(([id, c]) => [`${PLATFORM}:${id}`, {
    access: { mention: c.requireMention ?? true, allow: c.allow ?? (c.onlyOperators ? ['operator'] : 'anyone' as 'anyone' | string[]), ...(c.listen !== undefined && { listen: c.listen }) },
    ...(c.threadReply !== undefined && { threadReply: c.threadReply }),
  }]))
  const people: HydraConfig['people'] = {
    ...(operators.length && { operator: { id: 'operator', addresses: operators.map(o => `${PLATFORM}:${o}` as Address), roles: [], name: 'operator' } }),
    ...Object.fromEntries(Object.entries(others).map(([id, ids]) => [id, { id, addresses: ids.map(o => `${PLATFORM}:${o}` as Address), roles: [], name: id }])),
  }
  const base: HydraConfig = {
    ...(operators.length && { operator: 'operator' }),
    connectors: {}, gateways: {}, slackApps: {}, specialists: {}, schedules: {}, rules: [], places: {}, channels: gates,
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
