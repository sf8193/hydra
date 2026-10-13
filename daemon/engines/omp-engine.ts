// daemon/engines/omp-engine.ts
//
// omp (oh-my-pi) engine adapter — Claude's model: a TUI in tmux, with the daemon bridge socket
// spoken by an omp extension (omp/hydra-bridge.ts) instead of an MCP server. The tmux and bridge
// mechanics are Claude's, so this delegates them; only launch, observation and recovery differ.

import { mkdirSync } from 'fs'
import { join } from 'path'
import type { SessionInfo } from '../sessions.js'
import type {
  EngineAdapter, LaunchInput, LaunchResult, DeliveryResult, Notification, StopResult,
  ContextUsage, RecoveryPlan, Turn, UsageReading, UsageSubject,
} from './engine-adapter.js'
import type { BlockingState } from '../pane-probe.js'
import type { ClaudeEngine } from './claude-engine.js'
import { SOCK_PATH, PLATFORM, STATE_DIR } from '../config.js'
import { tmuxWindowActivity } from '../util.js'
import { ompContextTokens, ompSessionDir, ompTurn, ompUsageTotals, type OmpUsageCursor } from './omp-session.js'
import { contextWindowOf } from '../../shared/constants.js'
import { tmuxNewSession, withRaisedFdLimit } from '../../shared/spawn-env.js'

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
const EXTENSION = join(import.meta.dir, '..', '..', 'omp', 'hydra-bridge.ts')
const OMP_CONFIG = join(import.meta.dir, '..', '..', 'omp', 'hydra-omp.yml')
const SPAWN_LOGS_DIR = join(STATE_DIR, 'spawn-logs')

export class OmpEngine implements EngineAdapter {
  readonly provider = 'omp' as const
  readonly channel = 'bridge' as const
  constructor(private readonly claude: ClaudeEngine) {}

  async start(_records: readonly SessionInfo[]): Promise<void> {}

  async launch(input: LaunchInput): Promise<LaunchResult> {
    const { sessionId, tmuxName, model } = input
    // CLAUDE_CONFIG_DIR unset and the claude providers disabled (OMP_CONFIG): omp must not load Claude's plugins or a cwd .mcp.json.
    const stderrLog = join(SPAWN_LOGS_DIR, `stderr-${tmuxName}-${sessionId}.log`)
    const omp = process.env.HYDRA_OMP_BIN || 'omp'
    // hydra records the 1M window as `[1m]`; omp names the same model without it.
    const ompModel = model.replace(/\[1m\]$/, '')
    const args = [omp, `--model ${shq(`anthropic/${ompModel}`)}`, `-e ${shq(EXTENSION)}`, `--config ${shq(OMP_CONFIG)}`, '--approval-mode yolo', `--session-dir ${shq(ompSessionDir(sessionId))}`]
    const inner = [
      `cd ${shq(input.cwd)}`,
      `export HYDRA_SESSION_ID=${shq(sessionId)}`, `export HYDRA_SESSION_NAME=${shq(tmuxName)}`,
      `export DAEMON_SOCK=${shq(SOCK_PATH)}`, `export CHAT_PLATFORM=${shq(PLATFORM)}`,
      ...(input.prompt ? [`export HYDRA_SPAWN_PROMPT=${shq(input.prompt)}`] : []),
      `unset HYDRA_ROLE CLAUDE_CONFIG_DIR`,
      `${args.join(' ')} 2>>${shq(stderrLog)}`,
    ].join(' && ')
    mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
    tmuxNewSession(['-d', '-s', tmuxName, withRaisedFdLimit(inner)])
    return { provider: 'omp', model, identity: {}, stderrLogPath: stderrLog }
  }

  deliver(info: SessionInfo, msg: Notification): Promise<DeliveryResult> { return this.claude.deliver(info, msg) }
  isConnected(info: SessionInfo): boolean { return this.claude.isConnected(info) }

  stop(info: SessionInfo): Promise<StopResult> { return this.claude.stop(info) }

  isAlive(info: SessionInfo): boolean { return this.claude.isAlive(info) }
  peek(info: SessionInfo, lines?: number): string { return this.claude.peek(info, lines) }
  surface(info: SessionInfo): string | null { return this.claude.surface(info) }
  sendKeys(info: SessionInfo, keys: string, opts?: { raw?: boolean; trailingKey?: string }) { return this.claude.sendKeys(info, keys, opts) }
  interrupt(info: SessionInfo): Promise<void> { return this.claude.interrupt(info) }

  // omp's own session file (omp-session.ts): the turn is over when its last message is the assistant's final answer
  // and was written at or after sinceMs; that answer's text is what the reply guard relays.
  turn(info: SessionInfo, sinceMs: number): Turn {
    const { complete, text } = ompTurn(info.sessionId, sinceMs)
    return {
      confirmedComplete: complete,
      answer: () => (complete && text?.trim() ? text : null),
      live: null,
      get activityAt() { try { return tmuxWindowActivity(info.tmuxName) } catch { return null } },
    }
  }

  // Context tokens of the last request over the window hydra recorded at launch (as for Claude).
  usage(info: SessionInfo): ContextUsage | null {
    const used = ompContextTokens(info.sessionId)
    const window = contextWindowOf(info.sessionMetadata?.model)
    return used === null || !window ? null : { usedTokens: used, contextWindow: window, percent: Math.min(100, Math.round(used * 100 / window)) }
  }
  // Spend so far, from every assistant message in omp's session file (omp-session.ts); no phase split, as for Codex.
  usageTotals(info: UsageSubject, prev: unknown): UsageReading | null { return ompUsageTotals(info.sessionId, prev as OmpUsageCursor | undefined) }
  detectBlockingState(_info: SessionInfo, _tail: string): BlockingState | null { return null }
  // Resume and fork come with a later step.
  recoveryPlan(): RecoveryPlan { return { generic: false, resume: null, fork: null } }
}
