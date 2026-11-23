// engines/engine-adapter.ts
//
// Provider-neutral interface for engine adapters. Each engine (Claude, Codex)
// implements this interface. The adapter instance lives on SessionInfo so
// callers go through deliverToAdapter (sessions/bridge-transport.ts) — no dispatch logic needed.

import type { SessionInfo, SpawnOpts } from '../sessions/registry.js'
import type { LaunchPolicy, RestrictedPolicy } from '../shared/launch-policy.js'
import type { EngineName } from '../shared/engines/index.js'
export type BlockingKind = 'plan_mode' | 'login_required' | 'resume_prompt' | 'usage_limit' | 'unknown_dialog'

export type LoginStage = 'expiring' | 'login-blocked' | 'oauth_url' | 'success'

export type BlockingState = {
  kind: BlockingKind
  planPath: string | null
  loginStage: LoginStage | null
  oauthUrl: string | null
  escEndsSession?: boolean
}

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

export type ProviderId = EngineName

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type DeliveryMode = 'next-turn'

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
  /** `standing`: the refusal holds until something changes (an orphaned session stays one), so a thread is told once per window, not once per message.
   *  `permanent`: retrying this message is unsafe (`'unconfirmed'`: bytes were already pasted into a pane); callers must drop/settle it, never resend. */
  | { readonly status: 'rejected'; readonly retryable: boolean; readonly reason: string; readonly standing?: true; readonly permanent?: 'unconfirmed' }
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

// confirmedComplete: the turn is definitely over (skip the reply guard's grace).
// answer(): the session's last clean answer given after sinceMs, or null.
// Either may be lazy (Claude reads the status file and transcript on first use, and both
// describe one snapshot): read them off the outcome, never destructure it.
export type TurnOutcome = { readonly confirmedComplete: boolean; answer(): string | null }
// activityAt: epoch seconds of the last observable activity, or null when it
// can't be read (the reply-guard poller then skips the session this tick). Read
// on access, so a caller that only wants the outcome pays for no activity read.
// live: what the session is doing right now from the provider's own signal, or null when
// unknown (callers then fall back to tmux pane activity). Read on access, like activityAt.
// 'idle' and 'blocked' are authoritative: isSessionWorking does not consult tmux for them, so
// an engine that is unsure whether work continues must return null, not 'idle'.
// 'working' is unbounded unless the engine sets Turn.workingSilenceLimitS or the claim itself lapses (Codex's flag); a hung provider that
// keeps claiming it is only bounded by the protocol runner's 3x backstop.
export type LiveState = 'working' | 'idle' | 'blocked'
// workingSilenceLimitS: set by an engine whose 'working' claim can outlive a hung process (Claude's status
// file stays busy): isSessionWorking then also requires pane activity within this many seconds.
// backgroundWork: the session is between turns but something it started is still running (Claude's
// `shell` status: a background shell). Not 'working' (it is at its prompt, so input lands as a new turn),
// but not idle either. Absent when the engine can't tell.
export type Turn = TurnOutcome & { readonly activityAt: number | null; readonly live: LiveState | null; readonly workingSilenceLimitS?: number; readonly backgroundWork?: boolean }

/** A tmux keystroke action: raw key names, or literal text plus an optional trailing key. */
export type TmuxKeyAction =
  | { target: string; mode: 'raw'; keys: string[] }
  | { target: string; mode: 'literal'; text: string; trailingKey?: string }

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/**
 * How a launch continues an existing conversation — at most one per launch.
 * Replaces four flat optional fields so mutually exclusive modes are
 * unrepresentable at compile time and every engine adapter can fail closed
 * on a continuation meant for another engine.
 */
export type LaunchContinuation =
  | { readonly kind: 'fork-claude'; readonly claudeSessionId: string }
  | { readonly kind: 'fork-codex'; readonly codexThreadId: string }
  | { readonly kind: 'resume-claude'; readonly claudeSessionId: string }
  | { readonly kind: 'resume-codex'; readonly threadId: string; readonly homeName: string }
  | { readonly kind: 'resume-session'; readonly fromSessionId: string }

/** Build a single LaunchContinuation from SpawnOpts continuation fields; throws on conflicting or malformed options. */
export function launchContinuationFrom(
  opts?: Pick<SpawnOpts, 'forkFrom' | 'resumeFrom' | 'resumeCodex' | 'resumeSession'>,
): LaunchContinuation | undefined {
  if (!opts) return undefined
  const found: LaunchContinuation[] = []
  if (opts.resumeFrom) found.push({ kind: 'resume-claude', claudeSessionId: opts.resumeFrom })
  if (opts.resumeCodex) found.push({ kind: 'resume-codex', threadId: opts.resumeCodex.threadId, homeName: opts.resumeCodex.homeName })
  if (opts.resumeSession) found.push({ kind: 'resume-session', fromSessionId: opts.resumeSession.fromSessionId })
  if (opts.forkFrom) {
    if (opts.forkFrom.claudeSessionId && opts.forkFrom.codexThreadId) {
      throw new Error('cannot combine claudeSessionId and codexThreadId in forkFrom')
    }
    if (opts.forkFrom.claudeSessionId) found.push({ kind: 'fork-claude', claudeSessionId: opts.forkFrom.claudeSessionId })
    else if (opts.forkFrom.codexThreadId) found.push({ kind: 'fork-codex', codexThreadId: opts.forkFrom.codexThreadId })
    else throw new Error('forkFrom must name either claudeSessionId or codexThreadId')
  }
  if (found.length > 1) {
    throw new Error(`conflicting launch continuations: ${found.map(c => c.kind).join(', ')}`)
  }
  return found[0]
}

export type LaunchInput = {
  readonly sessionId: string
  readonly tmuxName: string
  readonly cwd: string
  readonly originalCwd: string
  /** Absent: the engine picks its own default (Codex asks its app-server). Claude and omp are always given one. */
  readonly model?: string
  readonly prompt: string
  readonly worktreePath?: string
  readonly forkFromOriginalCwd?: boolean
  readonly tools?: string[]
  readonly disallowedTools?: string[]
  readonly continuation?: LaunchContinuation
  readonly threadId?: string                                     // the chat thread this session serves; exported to its env
  readonly sessionType?: SessionInfo['sessionType']              // and its role there; exported to its env
  readonly sessionToken?: string                                 // the token this launch's session presents to the CLI (cli-caller.ts): handed over by file or process env, never on a command line
  readonly policy?: LaunchPolicy                                 // what a specialist's session may reach, decided at its birth (restricted.ts). In launch() alone, restricted = true decides the folder, argv, env and files (it runs in policy.workdir); absent or operator: as ever
}

export type LaunchResult = {
  readonly provider: ProviderId
  readonly model: string
  readonly spawnLogPath?: string
  readonly exitFilePath?: string
  readonly stderrLogPath?: string
  readonly debugLogPath?: string
  // A launch-time fact that may explain a channel that never connects (Claude: it cleared the
  // bridge's needs-auth entry). Shown verbatim if the session ends up unreachable; absent otherwise.
  readonly channelNote?: string
  // The native ids the launch assigned, spread onto the record. Absent keys are
  // omitted, never undefined.
  readonly identity: { readonly claudeSessionId?: string; readonly codexThreadId?: string; readonly codexHomeName?: string }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export type RecoverySource = { tmuxName: string; sessionId?: string; claudeSessionId?: string; codexThreadId?: string; codexHomeName?: string }
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
    | { kind: 'at-launch'; resumeSession: { fromSessionId: string } }              // omp, agy: launch continues the dead session's conversation
    | null
  fork: ForkPlan | null
}
export type ForkPlan = NonNullable<SpawnOpts['forkFrom']>

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
  // nothing to do. Codex: nothing here either; daemon.ts runs its reconnect sweep (app/codex-runtime.ts).
  start(records: readonly SessionInfo[]): Promise<void>
  launch(input: LaunchInput): Promise<LaunchResult>
  /** A restricted launch's check, from the engine's own record of what it loaded: refuse (with the cause) or pass. Absent: the engine cannot say, so it cannot run a restricted session. */
  verifyLaunch?(policy: RestrictedPolicy, launched: LaunchResult): Promise<{ ok: true } | { ok: false; why: string }>
  /** What a write-confined launch (`can_only_write_to`) applied, from the engine's own record, judged against its policy. Absent: the engine cannot run that layer. */
  verifyConfinement?(policy: LaunchPolicy, launched: LaunchResult): Promise<{ ok: true } | { ok: false; why: string }>
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

  // Ask a gone session one question through a read-only fork of its conversation
  // (a plan's fork, run in cwd, on model if given) and resolve with the answer text.
  // The original conversation is untouched, and the fork cannot reach Hydra. Rejects
  // on timeout, failure or an empty answer. Absent when this provider has no read-only,
  // Hydra-free one-shot fork; then no successor is offered ask_predecessor.
  askFork?(plan: ForkPlan, cwd: string, question: string, timeoutMs: number, model?: string): Promise<string>
}

/** Format context usage as "N%" or "?" for display. */
export function formatContextPercent(adapter: EngineAdapter, info: SessionInfo): string {
  const u = adapter.usage(info)
  return u ? `${u.percent}%` : '?'
}
