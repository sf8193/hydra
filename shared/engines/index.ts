// The engines hydra runs, one profile each (shared/engines/<engine>.ts). The engine type, the config's accepted `engine` values and every per-engine table derive
// from this list, so adding an engine means a profile file, an adapter and one entry here. The loader reads it (config cannot import the adapters) to refuse a
// specialist that asks for what its engine cannot give; the launch asks `engineLimitsAccess` (the engine comes from thread history, and `handoff <model>` can
// change it). The spawn and respawn paths read the rest, so no caller names an engine to decide one of these.
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
