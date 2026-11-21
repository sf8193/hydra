// daemon/engines/agy-engine.ts
//
// agy (Google Antigravity CLI) engine adapter — Claude's model: `agy` runs as a TUI in tmux, and the tmux and
// bridge mechanics are Claude's, so this delegates them; only launch, observation and recovery differ.
// Not built yet: launch refuses, so no agy session exists to observe or recover.

import type { SessionInfo } from '../sessions.js'
import { ENGINE_CAPABILITIES } from '../../shared/engine-capabilities.js'
import type {
  EngineAdapter, LaunchInput, LaunchResult, DeliveryResult, Notification, StopResult,
  ContextUsage, RecoveryPlan, Turn, UsageReading,
} from './engine-adapter.js'
import type { BlockingState } from '../pane-probe.js'
import type { ClaudeEngine } from './claude-engine.js'

export class AgyEngine implements EngineAdapter {
  readonly limitsAccess = ENGINE_CAPABILITIES.agy.limitsAccess
  readonly provider = 'agy' as const
  readonly channel = 'engine' as const
  constructor(private readonly claude: ClaudeEngine) {}

  async start(): Promise<void> {}
  async launch(_input: LaunchInput): Promise<LaunchResult> { throw new Error('the agy engine is not built yet') }

  deliver(info: SessionInfo, msg: Notification): Promise<DeliveryResult> { return this.claude.deliver(info, msg) }
  isConnected(info: SessionInfo): boolean { return this.claude.isConnected(info) }
  stop(info: SessionInfo): Promise<StopResult> { return this.claude.stop(info) }
  isAlive(info: SessionInfo): boolean { return this.claude.isAlive(info) }
  peek(info: SessionInfo, lines?: number): string { return this.claude.peek(info, lines) }
  surface(info: SessionInfo): string | null { return this.claude.surface(info) }
  sendKeys(info: SessionInfo, keys: string, opts?: { raw?: boolean; trailingKey?: string }) { return this.claude.sendKeys(info, keys, opts) }
  interrupt(info: SessionInfo): Promise<void> { return this.claude.interrupt(info) }

  turn(): Turn { return { confirmedComplete: false, answer: () => null, activityAt: null, live: null } }
  usage(): ContextUsage | null { return null }
  usageTotals(): UsageReading | null { return null }
  detectBlockingState(): BlockingState | null { return null }
  recoveryPlan(): RecoveryPlan { return { generic: false, resume: null, fork: null } }
}
