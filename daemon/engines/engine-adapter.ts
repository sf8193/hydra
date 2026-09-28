// daemon/engines/engine-adapter.ts
//
// Provider-neutral interface for engine adapters. Each engine (Claude, Codex)
// implements this interface. The adapter instance lives on SessionInfo so
// callers just call info.adapter.deliver(...) — no dispatch logic needed.

import type { SessionInfo, SpawnOpts } from '../sessions.js'
import type { BlockingState } from '../pane-probe.js'
import type { TokenTotals } from '../usage.js'
export type { BlockingState } from '../pane-probe.js'

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

export type ProviderId = 'claude' | 'codex'

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type DeliveryMode = 'steer-active' | 'next-turn'

/** The envelope every delivery carries. Claude writes it to the bridge minus the
 *  intents below (bridge.ts forwards meta to the model); Codex reads
 *  content/meta/defer and the intents. */
export type Notification = Record<string, unknown> & {
  type: 'notification'; content?: unknown; meta?: Record<string, string>
  allowPiggyback?: boolean; deferUntilTurnComplete?: boolean
  // Intents: what the caller wants, for the adapter to map onto its mechanics.
  handoff?: boolean      // a protocol handoff: Codex queues it for the next turn
  lowPriority?: boolean  // may wait for a carrier: Codex buffers it for piggyback unless deadAt
  optional?: boolean     // droppable: Codex rejects it
}

/** The message minus the adapter-only intents — what goes on a bridge. Never mutates msg. */
export function withoutIntents<T extends Record<string, unknown>>(msg: T): T {
  if (!('handoff' in msg || 'lowPriority' in msg || 'optional' in msg)) return msg
  const { handoff: _h, lowPriority: _l, optional: _o, ...wire } = msg
  return wire as T
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

// Cumulative spend of the provider's own session. `cursor` is opaque adapter
// state the caller hands back next time; `restarted` means the totals are a new
// baseline (rotated transcript, Codex decrease or thread change): report no delta.
export type UsageSubject = Pick<SessionInfo, 'sessionId' | 'tmuxName' | 'claudeSessionId' | 'codexThreadId' | 'codexHomeName'>
export type UsageReading = { totals: TokenTotals; providerSessionId: string; cursor: unknown; restarted: boolean }

// confirmedComplete: the turn is definitely over (skip the reply guard's grace).
// answer(): the session's last clean answer given after sinceMs, or null.
export type TurnOutcome = { readonly confirmedComplete: boolean; answer(): string | null }
// activityAt: epoch seconds of the last observable activity, or null when it
// can't be read (the reply-guard poller then skips the session this tick). Read
// on access, so a caller that only wants the outcome pays for no activity read.
export type Turn = TurnOutcome & { readonly activityAt: number | null }

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
  // The native ids the launch assigned, spread onto the record. Absent keys are
  // omitted, never undefined.
  readonly identity: { readonly claudeSessionId?: string; readonly codexThreadId?: string; readonly codexHomeName?: string }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export type RecoverySource = { tmuxName: string; claudeSessionId?: string; codexThreadId?: string; codexHomeName?: string }
export type RecoveryPlan = {
  // May the neutral recoverOne cascade (manual recover, boot auto-recover) act
  // on this record? Claude: yes. Codex: no — it would relaunch it as Claude.
  generic: boolean
  // Set only when { discover } learned the source's missing native id (and
  // wrote it onto the source); absent otherwise, never undefined.
  learnedId?: string
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
  // How the session's tools and traffic reach it: 'bridge' = the daemon bridge
  // socket (Claude); 'engine' = the engine's own protocol, where any daemon-socket
  // registration is a control-plane MCP sidecar with its own tools (Codex).
  readonly channel: 'bridge' | 'engine'

  // Lifecycle
  // Boot, once, over this provider's persisted records; never rejects. Claude:
  // nothing to do. Codex: reconnect the live records to their app-servers.
  start(records: readonly SessionInfo[]): Promise<void>
  launch(input: LaunchInput): Promise<LaunchResult>
  // Deliver one notification. Claude: strip the intents, then write to the
  // owning transport's session bridge, else enqueue there; the write is
  // synchronous (no await before it). Codex: optional → rejected; lowPriority
  // (not deadAt) → piggyback buffer; else steer, or queue a turn when handoff
  // or deferUntilTurnComplete, carrying buffered content when allowPiggyback.
  deliver(info: SessionInfo, msg: Notification): Promise<DeliveryResult>
  stop(info: SessionInfo): Promise<StopResult>

  // Observation
  // Is a delivery channel connected? Backs transport.has(). Codex: same answer as isAlive.
  isConnected(info: SessionInfo): boolean
  // The session's turn as seen now: last activity, and whether the turn that
  // answers a message delivered at sinceMs ended and what it said.
  turn(info: SessionInfo, sinceMs: number): Turn
  // Is the execution alive? Claude: its tmux session. Codex: its app-server socket is
  // connected or its runtime is reconnecting it (tmux is only a replaceable anchor).
  isAlive(info: SessionInfo): boolean
  peek(info: SessionInfo, lines?: number): string
  usage(info: SessionInfo): ContextUsage | null
  // Spend so far, or null when it can't be read yet (Raindrop counts the session unresolved).
  // Claude: its transcript, drained incrementally from `prev`. Codex: the rollout's last token_count.
  usageTotals(info: UsageSubject, prev: unknown): UsageReading | null

  // Surface
  // Ensure the interactive surface exists (Codex may recreate its tmux container
  // and TUI), then return its tmux target, or null when it's unavailable.
  surface(info: SessionInfo): string | null
  sendKeys(info: SessionInfo, keys: string, opts?: { raw?: boolean; trailingKey?: string }): Promise<{ queued: boolean }>
  interrupt(info: SessionInfo): Promise<void>

  // Probe — detect and resolve blocking TUI states
  detectBlockingState(info: SessionInfo, tailText: string): BlockingState | null

  // Native continuation of a gone session. Pure: spawns nothing; respawn is the
  // neutral last tier. resume.kind says how a resume is confirmed, so callers
  // pick the executor from the plan, not from the provider.
  // { discover }: first, if the source lacks its native id and the provider can
  // learn it from the running execution, learn it, set it on the source and
  // report it as learnedId. Claude: pane discovery. Codex: never (launch and
  // reconnect assign its id).
  recoveryPlan(src: RecoverySource, opts?: { discover?: boolean }): RecoveryPlan
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
