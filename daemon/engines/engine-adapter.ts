// daemon/engines/engine-adapter.ts
//
// Provider-neutral interface for engine adapters. Each engine (Claude, Codex)
// implements this interface. The adapter instance lives on SessionInfo so
// callers just call info.adapter.deliver(...) — no dispatch logic needed.

import type { SessionInfo, SpawnOpts } from '../sessions.js'
import type { BlockingState } from '../pane-probe.js'
import type { TurnOutcome } from '../observability.js'
export type { BlockingState } from '../pane-probe.js'

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

export type ProviderId = 'claude' | 'codex'

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type DeliveryMode = 'steer-active' | 'next-turn'

/** The envelope every delivery carries. Claude writes it to the bridge verbatim
 *  (bridge.ts forwards meta to the model); Codex reads content/meta/defer. */
export type Notification = Record<string, unknown> & {
  type: 'notification'; content?: unknown; meta?: Record<string, string>
  allowPiggyback?: boolean; deferUntilTurnComplete?: boolean
}

export type DeliveryResult =
  | { readonly status: 'accepted'; readonly via?: string }
  | { readonly status: 'rejected'; readonly retryable: boolean; readonly reason: string }
  | { readonly status: 'unknown'; readonly reason: string }

// ---------------------------------------------------------------------------
// Retirement and stop
// ---------------------------------------------------------------------------

export type ExecutionRetirementResult =
  | { readonly status: 'terminal' }
  | { readonly status: 'unknown'; readonly reason: string }

export type StopResult =
  | { readonly status: 'stopped' }
  | { readonly status: 'uncertain'; readonly reason: string }

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

export type ContextUsage = {
  readonly usedTokens: number
  readonly contextWindow: number
  readonly percent: number
}

/** A tmux keystroke action: raw key names, or literal text plus an optional trailing key. */
export type TmuxKeyAction =
  | { target: string; mode: 'raw'; keys: string[] }
  | { target: string; mode: 'literal'; text: string; trailingKey?: string }

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export type LaunchInput = {
  readonly sessionId: string
  readonly tmuxName: string
  readonly cwd: string
  readonly originalCwd: string
  readonly model: string
  readonly prompt: string
  readonly worktreePath?: string
  readonly forkFromOriginalCwd?: boolean
  readonly tools?: string[]
  readonly disallowedTools?: string[]
  readonly forkFrom?: { claudeSessionId?: string; codexThreadId?: string }
  readonly resumeFrom?: string
  readonly resumeCodex?: { threadId: string; homeName: string }  // Codex: resume this thread in its original CODEX_HOME
  readonly threadId?: string
}

export type LaunchResult = {
  readonly provider: ProviderId
  readonly model: string
  readonly spawnLogPath?: string
  readonly exitFilePath?: string
  readonly stderrLogPath?: string
  readonly debugLogPath?: string
  readonly claudeSessionId?: string
  readonly codexThreadId?: string
  readonly codexHomeName?: string
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export type RecoverySource = { tmuxName: string; claudeSessionId?: string; codexThreadId?: string; codexHomeName?: string }
export type RecoveryPlan = {
  resume:
    | { kind: 'await-bridge'; resumeFrom: string }                                // relaunch takes no prompt; confirmed when its bridge registers
    | { kind: 'at-launch'; resumeCodex: { threadId: string; homeName: string } }  // launch resumes and takes the prompt
    | null
  fork: NonNullable<SpawnOpts['forkFrom']> | null
}

// ---------------------------------------------------------------------------
// Engine adapter interface
// ---------------------------------------------------------------------------

export interface EngineAdapter {
  readonly provider: ProviderId
  // true when a delivery just sits in the engine's own buffer (Claude's tmux
  // pane) at no extra cost; false when every delivery is a priced turn
  // (Codex). Callers deciding whether to buffer/piggyback low-priority
  // notifications should ask this, not special-case a provider name.
  readonly deliveryIsFree: boolean
  // How the session's tools and traffic reach it: 'bridge' = the daemon bridge
  // socket (Claude); 'engine' = the engine's own protocol, where any daemon-socket
  // registration is a control-plane MCP sidecar with its own tools (Codex).
  readonly channel: 'bridge' | 'engine'

  // Lifecycle
  launch(input: LaunchInput): Promise<LaunchResult>
  // Deliver one notification. Claude: write to the owning transport's session
  // bridge, else enqueue there; the write is synchronous (no await before it).
  // Codex: steer, or queue a turn when msg.deferUntilTurnComplete.
  deliver(info: SessionInfo, msg: Notification): Promise<DeliveryResult>
  retire(info: SessionInfo, reason: string): Promise<ExecutionRetirementResult>
  stop(info: SessionInfo): Promise<StopResult>

  // Observation
  // Is a delivery channel connected? Backs transport.has().
  isConnected(info: SessionInfo): boolean
  // If the record lacks its native id and the provider can learn it from the
  // running execution: learn it, set it on the record and return it; else null.
  // Claude: pane discovery. Codex: null (launch and reconnect assign its id).
  refreshIdentity(info: SessionInfo): string | null
  // Epoch seconds of the last observable activity, or null when it can't be
  // read (the reply-guard poller then skips the session this tick).
  activityAt(info: SessionInfo): number | null
  // Did the turn that answers a message delivered at sinceMs end, and what did it say?
  turnOutcome(info: SessionInfo, sinceMs: number): TurnOutcome
  isAlive(info: SessionInfo): Promise<boolean>
  peek(info: SessionInfo, lines?: number): string
  usage(info: SessionInfo): ContextUsage | null

  // Surface
  uiTarget(info: SessionInfo): string
  ensureSurface(info: SessionInfo): boolean
  sendKeys(info: SessionInfo, keys: string, opts?: { raw?: boolean; trailingKey?: string }): Promise<{ queued: boolean }>
  interrupt(info: SessionInfo): Promise<void>

  // Probe — detect and resolve blocking TUI states
  detectBlockingState(info: SessionInfo, tailText: string): BlockingState | null

  // Boot — reconnect to surviving execution after daemon restart
  reconnect(info: SessionInfo): Promise<boolean>

  // Native continuation of a gone session. Pure: spawns nothing; respawn is the
  // neutral last tier. resume.kind says how a resume is confirmed, so callers
  // pick the executor from the plan, not from the provider.
  recoveryPlan(src: RecoverySource): RecoveryPlan
}

// Compat — flat serializable ref used by retirement journal persistence
export type ProviderExecutionRef = {
  provider: ProviderId
  sessionId: string
  claudeSessionId?: string
  codexThreadId?: string
  codexHomeName?: string
  ownershipGeneration?: string
}

/** Format context usage as "N%" or "?" for display. */
export function formatContextPercent(adapter: EngineAdapter, info: SessionInfo): string {
  const u = adapter.usage(info)
  return u ? `${u.percent}%` : '?'
}
