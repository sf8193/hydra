import type { SessionInfo, SpawnOpts, SpawnResult, ThreadSessionEntry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { codexSocketPath } from './codex-engine.js'
import { getContextPercent, tmuxHasSession } from './util.js'

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

export type ProviderId = 'claude' | 'codex'

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

type ProviderDependencies = {
  spawn: (topic: string, chatId?: string, messageId?: string, opts?: SpawnOpts) => Promise<SpawnResult>
  resumeClaude: (input: {
    topic: string; threadId: string; claudeSessionId?: string; threadUrl?: string; model?: string;
    worktree?: { repo: string; path: string; branch: string }; preserveWorktree?: boolean;
  }) => Promise<(SpawnResult & { bridgeOrphan?: boolean }) | null>
  disconnectCodex: (sessionId: string) => void
  isCodexConnected: (sessionId: string) => boolean
}

let dependencies: ProviderDependencies | undefined
export function configureSessionProviders(next: ProviderDependencies): void { dependencies = next }
function deps(): ProviderDependencies {
  if (!dependencies) throw new Error('session providers are not configured')
  return dependencies
}

export function codexForkSpawnOptions(identity: { threadId: string; homeName: string }, parentName: string): SpawnOpts {
  return {
    forkFrom: { codexThreadId: identity.threadId, codexHomeName: identity.homeName, parentName },
    engine: 'codex',
  }
}

export interface SessionProvider {
  readonly id: ProviderId
  readonly capabilities: ProviderCapabilities
  uiTarget(info: Pick<SessionInfo, 'tmuxName'>): string
  ensureInteractiveSurface(info: SessionInfo): boolean
  contextPercent(info: SessionInfo): string
  disconnect(info: SessionInfo): void
  resume(input: ProviderRecoveryInput): Promise<(SpawnResult & { bridgeOrphan?: boolean }) | null>
  fork(input: ProviderRecoveryInput): Promise<SpawnResult | null>
}

type CodexSurfaceIo = {
  isConnected: (sessionId: string) => boolean
  hasSession: (name: string) => boolean
  tmux: (args: string[]) => string
}

/** Keep the daemon-owned Codex engine and its replaceable tmux UI separate. */
export function ensureCodexInteractiveSurface(info: SessionInfo, io: CodexSurfaceIo): boolean {
  if (!info.codexThreadId) return false
  try {
    // A remote Codex TUI can take its tmux session down when the attached turn
    // finishes even though the daemon-owned app-server and socket remain live.
    // Recreate a durable container around that live engine instead of treating
    // the missing presentation layer as a dead agent.
    if (!io.hasSession(info.tmuxName)) {
      if (!io.isConnected(info.sessionId)) return false
      try {
        io.tmux([
          'new-session', '-d', '-s', info.tmuxName, '-n', 'hydra-anchor',
          'while :; do sleep 3600; done',
        ])
        process.stderr.write(`daemon: codex provider recreated tmux container for ${info.tmuxName}\n`)
      } catch (err) {
        // Another concurrent health/key path may have won the repair race.
        if (!io.hasSession(info.tmuxName)) throw err
      }
    }
    const windows = io.tmux(['list-windows', '-t', info.tmuxName, '-F', '#{window_name}'])
    if (windows.split('\n').includes('hydra-chat')) return true
    const homeName = info.codexHomeName ?? info.tmuxName
    const codexHome = join(homedir(), '.codex', `hydra-${homeName}`)
    const socket = codexSocketPath(homeName)
    const command = `export CODEX_HOME=${shq(codexHome)} && codex resume ${shq(info.codexThreadId)} --remote ${shq(`unix://${socket}`)}`
    io.tmux(['new-window', '-d', '-n', 'hydra-chat', '-t', info.tmuxName, command])
    process.stderr.write(`daemon: codex provider recreated TUI for ${info.tmuxName}\n`)
    return true
  } catch (err) {
    process.stderr.write(`daemon: codex provider could not ensure TUI for ${info.tmuxName}: ${err}\n`)
    return false
  }
}

class ClaudeSessionProvider implements SessionProvider {
  readonly id = 'claude' as const
  readonly capabilities: ProviderCapabilities = {
    nativeFork: true, nativeResume: true, steerDuringTurn: false, dynamicTools: true,
    structuredUsage: false, interactiveTui: true, paneProbe: true, queueKeysWhileWorking: false,
  }

  uiTarget(info: Pick<SessionInfo, 'tmuxName'>): string { return info.tmuxName }
  ensureInteractiveSurface(info: SessionInfo): boolean { return tmuxHasSession(info.tmuxName) }
  contextPercent(info: SessionInfo): string { return getContextPercent(info.tmuxName) }
  disconnect(_info: SessionInfo): void {}

  async resume(input: ProviderRecoveryInput) {
    const claudeSessionId = input.entry?.claudeSessionId ?? input.live?.claudeSessionId
    return deps().resumeClaude({
      topic: input.topic, threadId: input.threadId, threadUrl: input.threadUrl,
      claudeSessionId, model: input.model, worktree: input.worktree,
      preserveWorktree: input.preserveWorktree,
    })
  }

  async fork(input: ProviderRecoveryInput): Promise<SpawnResult | null> {
    const claudeSessionId = input.entry?.claudeSessionId ?? input.live?.claudeSessionId
    if (!claudeSessionId) return null
    return deps().spawn(input.topic, undefined, undefined, {
      existingThreadId: input.threadId,
      ...input.spawnOptions,
      forkFrom: { claudeSessionId, parentName: input.lastName },
      model: input.model,
      engine: 'claude',
    })
  }
}

class CodexSessionProvider implements SessionProvider {
  readonly id = 'codex' as const
  readonly capabilities: ProviderCapabilities = {
    nativeFork: true, nativeResume: true, steerDuringTurn: true, dynamicTools: true,
    structuredUsage: true, interactiveTui: true, paneProbe: false, queueKeysWhileWorking: true,
  }

  uiTarget(info: Pick<SessionInfo, 'tmuxName'>): string { return `${info.tmuxName}:hydra-chat` }

  ensureInteractiveSurface(info: SessionInfo): boolean {
    return ensureCodexInteractiveSurface(info, {
      isConnected: sessionId => deps().isCodexConnected(sessionId),
      hasSession: tmuxHasSession,
      tmux: args => execFileSync('tmux', args, { encoding: 'utf8', timeout: 2000, stdio: 'pipe' }).toString(),
    })
  }
  contextPercent(info: SessionInfo): string {
    return info.contextUsage ? `${info.contextUsage.percent}%` : '?'
  }
  disconnect(info: SessionInfo): void { deps().disconnectCodex(info.sessionId) }

  private identity(input: ProviderRecoveryInput): { threadId: string; homeName: string } | null {
    const threadId = input.entry?.codexThreadId ?? input.live?.codexThreadId
    const homeName = input.entry?.codexHomeName ?? input.live?.codexHomeName ?? input.lastName
    return threadId ? { threadId, homeName } : null
  }

  async resume(input: ProviderRecoveryInput): Promise<SpawnResult | null> {
    const identity = this.identity(input)
    if (!identity) return null
    try {
      const result = await deps().spawn(input.topic, undefined, undefined, {
        existingThreadId: input.threadId,
        ...input.spawnOptions,
        resumeCodex: identity,
        model: input.model,
        engine: 'codex',
        preserveWorktree: input.preserveWorktree,
        reuseWorktree: input.preserveWorktree ? input.worktree : undefined,
      } as SpawnOpts)
      transport.sendOrQueue(result.sessionId, {
        type: 'notification',
        content: input.recoveryNotice,
        meta: { chat_id: input.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString() },
      })
      return result
    } catch (err) {
      process.stderr.write(`daemon: codex provider resume failed for ${input.lastName}: ${err}\n`)
      return null
    }
  }

  async fork(input: ProviderRecoveryInput): Promise<SpawnResult | null> {
    const identity = this.identity(input)
    if (!identity) return null
    try {
      return await deps().spawn(input.topic, undefined, undefined, {
        existingThreadId: input.threadId,
        ...input.spawnOptions,
        ...codexForkSpawnOptions(identity, input.lastName),
        model: input.model,
      })
    } catch (err) {
      process.stderr.write(`daemon: codex provider fork failed for ${input.lastName}: ${err}\n`)
      return null
    }
  }
}

const providers: Record<ProviderId, SessionProvider> = {
  claude: new ClaudeSessionProvider(),
  codex: new CodexSessionProvider(),
}

export function providerFor(engine?: ProviderId): SessionProvider {
  return providers[engine ?? 'claude']
}

export function providerForEntry(entry?: ThreadSessionEntry): SessionProvider {
  return providerFor(entry?.engine ?? (entry?.codexThreadId ? 'codex' : 'claude'))
}
