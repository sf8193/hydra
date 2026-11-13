// Where the operator can be tagged: their address on one platform. One place, so the loader (which checks it before escalate needs it)
// and escalate itself agree on what "the operator has an address there" means.

import type { HydraConfig } from './types.js'

/** The operator's id on `platform` (the part after `slack:` or `discord:`), or undefined when hydra.toml gives them none there. */
export function operatorAddress(h: Pick<HydraConfig, 'operator' | 'people'>, platform: 'slack' | 'discord'): string | undefined {
  return h.operator ? h.people[h.operator]?.ids.find(a => a.startsWith(`${platform}:`))?.slice(platform.length + 1) : undefined
}
