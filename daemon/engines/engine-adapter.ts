import type { SessionInfo, SpawnOpts, ThreadSessionEntry } from '../sessions.js'

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

export type ExecutionRetirementResult =
  | { status: 'terminal' }
  | { status: 'unknown'; reason: string }

export type RetirementResult =
  | { status: 'terminal' }
  | { status: 'pending'; journaled: true; reason: string }

export interface EngineAdapter<P extends ProviderId = ProviderId> {
  readonly id: P
  spawn(input: EngineSpawnInput<P>): Promise<EngineSpawnResult<P>>
  readonly capabilities: ProviderCapabilities
  uiTarget(info: Pick<SessionInfo, 'tmuxName'>): string
  ensureInteractiveSurface(info: SessionInfo): boolean
  contextPercent(info: SessionInfo): string
  executionRef(info: SessionInfo): ProviderExecutionRef
  retireExecution(ref: ProviderExecutionRef): Promise<ExecutionRetirementResult>
  /** Stop native execution and verify it is terminal before releasing ownership. */
  stop(info: SessionInfo): Promise<void>
  isAlive(info: SessionInfo): Promise<boolean>
}

export type ProviderExecutionRef = {
  provider: ProviderId
  sessionId: string
  codexThreadId?: string
  codexHomeName?: string
  ownershipGeneration?: string
}

export type ProviderCapabilities = {
  nativeFork: boolean
  nativeResume: boolean
  steerDuringTurn: boolean
  dynamicTools: boolean
  structuredUsage: boolean
  interactiveTui: boolean
  paneProbe: boolean
  queueKeysWhileWorking: boolean
}

export type ProviderRecoveryInput = {
  topic: string
  threadId: string
  threadUrl?: string
  lastName: string
  model?: string
  entry?: ThreadSessionEntry
  live?: SessionInfo
  worktree?: { repo: string; path: string; branch: string }
  preserveWorktree?: boolean
  spawnOptions?: Partial<SpawnOpts>
  recoveryNotice: string
}
