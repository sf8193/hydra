// The engines hydra runs, one profile each (shared/engines/<engine>.ts). The engine type and the config's accepted `engine` values derive from this list, and the
// adapter list (daemon/engines/instances.ts) must have a row for each. A profile holds an engine's label, what its sessions can be asked, and the aliases and id prefix that name its models: the loader reads it
// (config cannot import the adapters) to refuse a specialist that asks for what its engine cannot give; the launch asks `engineLimitsAccess` (the engine comes from
// thread history, and `handoff <model>` can change it); the spawn and respawn paths read the rest.

import { agy } from './agy.js'
import { claude } from './claude.js'
import { codex } from './codex.js'
import { omp } from './omp.js'
import type { EngineProfile } from './profile.js'

export type { EngineProfile } from './profile.js'

export const ENGINE_PROFILES = { claude, codex, omp, agy } as const satisfies Record<string, EngineProfile>

export type EngineName = keyof typeof ENGINE_PROFILES
export const ENGINES = Object.keys(ENGINE_PROFILES) as readonly EngineName[]

/** Whether a session started on this engine (absent: the default, claude) can be restricted or write-confined. */
export const engineLimitsAccess = (engine: EngineName | undefined): boolean => ENGINE_PROFILES[engine ?? 'claude'].limitsAccess

/** The engine as a person reads it (absent: the default, claude). */
export const engineLabel = (engine: EngineName | undefined): string => ENGINE_PROFILES[engine ?? 'claude'].label
