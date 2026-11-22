// What each engine can do or is called, one row per engine. The loader reads it (config cannot import the adapters) to refuse a specialist that asks for what
// its engine cannot give; the launch asks `engineLimitsAccess` (the engine comes from thread history, and
// `handoff <model>` can change it). The spawn and respawn paths read the rest, so no caller names an engine to decide one of these.

export type EngineCapabilities = {
  /** How a notice about one of the engine's sessions names it. */
  label: string
  /** Can run a session with less than the operator's access: restricted (`restricted = true`) or write-confined (`can_only_write_to`). */
  limitsAccess: boolean
  /** A new session can start as a fork of another session's conversation (`fork_from`). */
  forkable: boolean
  /** A `read_only` spawn really blocks writes. */
  enforcesReadOnly: boolean
  /** `respawn +f` can layer a template's tools and session type onto the session. */
  takesTemplates: boolean
}

/** The engines hydra runs are the rows of this table: the engine type, the config's accepted `engine` values and every per-engine table derive from it. */
export const ENGINE_CAPABILITIES = {
  claude: { label: 'Claude', limitsAccess: true, forkable: true, enforcesReadOnly: true, takesTemplates: true },
  codex: { label: 'Codex', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: true },
  omp: { label: 'omp', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: false },
  agy: { label: 'agy', limitsAccess: false, forkable: false, enforcesReadOnly: false, takesTemplates: false },
} as const satisfies Record<string, EngineCapabilities>

export type EngineName = keyof typeof ENGINE_CAPABILITIES
export const ENGINES = Object.keys(ENGINE_CAPABILITIES) as readonly EngineName[]

/** Whether a session started on this engine (absent: the default, claude) can be restricted or write-confined. */
export const engineLimitsAccess = (engine: EngineName | undefined): boolean => ENGINE_CAPABILITIES[engine ?? 'claude'].limitsAccess

/** The engine as a person reads it (absent: the default, claude). */
export const engineLabel = (engine: EngineName | undefined): string => ENGINE_CAPABILITIES[engine ?? 'claude'].label
