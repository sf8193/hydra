// daemon/engines/engine-adapter.ts
//
// Provider-neutral interface for engine adapters. Each engine (Claude, Codex)
// implements this interface. The adapter instance lives on SessionInfo so
// callers just call info.adapter.deliver(...) — no dispatch logic needed.

import type { SessionInfo } from '../sessions.js'
import type { BlockingState } from '../pane-probe.js'
export type { BlockingState } from '../pane-probe.js'

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

export type ProviderId = 'claude' | 'codex'

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type DeliveryMode = 'steer-active' | 'next-turn'

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

export type EngineSnapshot = {
  readonly provider: ProviderId
  readonly execution: 'running' | 'idle' | 'dead' | 'unknown'
  readonly connection: 'connected' | 'disconnected' | 'connecting'
  readonly surface: 'present' | 'absent' | 'repairable'
  readonly context: ContextUsage | null
  readonly turnActive: boolean
}

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
}

// ---------------------------------------------------------------------------
// Engine adapter interface
// ---------------------------------------------------------------------------

export interface EngineAdapter {
  readonly provider: ProviderId

  // Lifecycle
  launch(input: LaunchInput): Promise<LaunchResult>
  deliver(info: SessionInfo, text: string, mode?: DeliveryMode, meta?: Record<string, string>): Promise<DeliveryResult>
  retire(info: SessionInfo, reason: string): Promise<ExecutionRetirementResult>
  stop(info: SessionInfo): Promise<StopResult>

  // Observation
  isAlive(info: SessionInfo): Promise<boolean>
  peek(info: SessionInfo, lines?: number): string
  usage(info: SessionInfo): ContextUsage | null
  status(info: SessionInfo): Promise<EngineSnapshot>

  // Surface
  uiTarget(info: SessionInfo): string
  ensureSurface(info: SessionInfo): boolean
  sendKeys(info: SessionInfo, keys: string): Promise<void>
  interrupt(info: SessionInfo): Promise<void>

  // Probe — detect and resolve blocking TUI states
  detectBlockingState(info: SessionInfo, tailText: string): BlockingState | null

  // Boot — reconnect to surviving execution after daemon restart
  reconnect(info: SessionInfo): Promise<boolean>
}

/** Format context usage as "N%" or "?" for display. */
export function formatContextPercent(adapter: EngineAdapter, info: SessionInfo): string {
  const u = adapter.usage(info)
  return u ? `${u.percent}%` : '?'
}
