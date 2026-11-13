// What each engine can do that a specialist's `access` depends on. One table. The loader reads it (config cannot import the
// adapters) to refuse a specialist that asks for what its engine cannot give; each engine adapter reads its own row into
// `confinesAccess`, which the launch asks (the engine comes from thread history, and `handoff <model>` can change it).

export type EngineName = 'claude' | 'codex' | 'omp'

export const ENGINE_CAPABILITIES: Readonly<Record<EngineName, { /** Can run a session confined to a folder, a tool list and a server list (`access = "workdir"`). */ confinesAccess: boolean }>> = {
  claude: { confinesAccess: true },
  codex: { confinesAccess: false },
  omp: { confinesAccess: false },
}

/** Whether a session started on this engine (absent: the default, claude) can be confined. */
export const engineConfinesAccess = (engine: EngineName | undefined): boolean => ENGINE_CAPABILITIES[engine ?? 'claude'].confinesAccess
