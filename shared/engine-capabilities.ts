// What each engine can do that a specialist's `restricted` and `can_only_write_to` depend on. One table. The loader reads it (config cannot import the
// adapters) to refuse a specialist that asks for what its engine cannot give; each engine adapter reads its own row into
// `limitsAccess`, which the launch asks (the engine comes from thread history, and `handoff <model>` can change it).

export type EngineName = 'claude' | 'codex' | 'omp'

export const ENGINE_CAPABILITIES: Readonly<Record<EngineName, { /** Can run a session with less than the operator's access: restricted (`restricted = true`) or write-confined (`can_only_write_to`). */ limitsAccess: boolean }>> = {
  claude: { limitsAccess: true },
  codex: { limitsAccess: false },
  omp: { limitsAccess: false },
}

/** Whether a session started on this engine (absent: the default, claude) can be restricted or write-confined. */
export const engineLimitsAccess = (engine: EngineName | undefined): boolean => ENGINE_CAPABILITIES[engine ?? 'claude'].limitsAccess
