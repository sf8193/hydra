/** Native launch boundary. Registry/thread transactions belong to SessionRuntime. */
export type ProviderId = 'claude' | 'codex'

export type NativeIdentity =
  | { provider: 'claude'; sessionId: string }
  | { provider: 'codex'; threadId: string; homeName: string }

export type LaunchMode<P extends ProviderId> =
  | { kind: 'fresh' }
  | { kind: 'resume'; source: Extract<NativeIdentity, { provider: P }> }
  | { kind: 'fork'; source: Extract<NativeIdentity, { provider: P }> }

export type EngineSpawnInput<P extends ProviderId> = {
  sessionId: string
  tmuxName: string
  cwd: string
  originalCwd: string
  model: P extends 'claude' ? string : string | undefined
  prompt: string
  mode: LaunchMode<P>
  worktreePath?: string
  forkFromOriginalCwd?: boolean
  tools?: string[]
  disallowedTools?: string[]
}

export type EngineSpawnResult<P extends ProviderId> = {
  provider: P
  model?: string
  spawnLogPath?: string
  nativeIdentity?: Extract<NativeIdentity, { provider: P }>
  exitFilePath?: string
  stderrLogPath?: string
  debugLogPath?: string
}

export interface EngineAdapter<P extends ProviderId = ProviderId> {
  readonly id: P
  spawn(input: EngineSpawnInput<P>): Promise<EngineSpawnResult<P>>
}
