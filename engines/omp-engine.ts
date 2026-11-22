// engines/omp-engine.ts
//
// omp (oh-my-pi) engine adapter — Claude's model: a TUI in tmux, with the daemon bridge socket
// spoken by an omp extension (omp/hydra-bridge.ts) instead of an MCP server. The tmux and bridge
// mechanics are Claude's, so this delegates them; only launch, observation and recovery differ.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import type { SessionInfo } from '../sessions/registry.js'
import type {
  EngineAdapter, LaunchInput, LaunchResult, DeliveryResult, Notification, StopResult,
  ContextUsage, RecoveryPlan, RecoverySource, Turn,
} from './engine-adapter.js'
import type { BlockingState } from './claude-blocking.js'
import type { ClaudeEngine } from './claude-engine.js'
import { SOCK_PATH, PLATFORM, SPAWN_LOGS_DIR } from '../infra/config.js'
import { removeSessionToken, removeSpawnPrompt, shq, writeSessionToken, writeSpawnPrompt } from '../infra/launch-files.js'
import { tmuxCreateSession, tmuxWindowActivity } from '../infra/tmux.js'
import { ompContextTokens, ompSessionDir, ompTurn } from './omp-session.js'
import { contextWindowOf, ompProvider } from '../shared/constants.js'
import { withRaisedFdLimit } from '../shared/spawn-env.js'

const EXTENSION = join(import.meta.dir, '..', 'omp', 'hydra-bridge.ts')
const OMP_CONFIG = join(import.meta.dir, '..', 'omp', 'hydra-omp.yml')

export class OmpEngine implements EngineAdapter {
  readonly provider = 'omp' as const
  readonly channel = 'bridge' as const
  constructor(private readonly claude: ClaudeEngine) {}

  async start(_records: readonly SessionInfo[]): Promise<void> {}

  async launch(input: LaunchInput): Promise<LaunchResult> {
    const { sessionId, tmuxName, model } = input
    if (!model) throw new Error('omp engine: launched without a model')   // doSpawnSession always gives omp one
    // CLAUDE_CONFIG_DIR unset and the claude providers disabled (OMP_CONFIG): omp must not load Claude's plugins or a cwd .mcp.json.
    const stderrLog = join(SPAWN_LOGS_DIR, `stderr-${tmuxName}-${sessionId}.log`)
    const omp = process.env.HYDRA_OMP_BIN || 'omp'
    // hydra records the 1M window as `[1m]`; omp names the same model without it.
    const ompModel = model.replace(/\[1m\]$/, '')
    // Resume: the dead session's file is copied into this session's directory (the old one stays as it was) and omp continues it.
    // With no file omp would start a fresh session that the caller reports as resumed, so that fails the resume instead.
    if (input.resumeSession) {
      const from = ompSessionDir(input.resumeSession.fromSessionId)
      const files = existsSync(from) ? readdirSync(from).filter(n => n.endsWith('.jsonl')) : []
      if (!files.length) throw new Error(`omp session ${input.resumeSession.fromSessionId} has no session file to resume`)
      mkdirSync(ompSessionDir(sessionId), { recursive: true })
      for (const n of files) copyFileSync(join(from, n), join(ompSessionDir(sessionId), n))
    }
    const args = [omp, `--model ${shq(`${ompProvider(ompModel)}/${ompModel}`)}`, `-e ${shq(EXTENSION)}`, `--config ${shq(OMP_CONFIG)}`, '--approval-mode yolo', `--session-dir ${shq(ompSessionDir(sessionId))}`, ...(input.resumeSession ? ['-c'] : [])]
    // The prompt is handed to the pane by file (launch-files.ts), so no part of it is on a command line.
    const promptFile = input.prompt ? writeSpawnPrompt(tmuxName, sessionId, input.prompt) : null
    const tokenFile = input.sessionToken ? writeSessionToken(tmuxName, sessionId, input.sessionToken) : null
    const inner = [
      `cd ${shq(input.cwd)}`,
      `export HYDRA_SESSION_ID=${shq(sessionId)}`, `export HYDRA_SESSION_NAME=${shq(tmuxName)}`,
      `export HYDRA_THREAD_ID=${shq(input.threadId ?? '')}`, `export HYDRA_SESSION_TYPE=${shq(input.sessionType ?? '')}`,
      `export DAEMON_SOCK=${shq(SOCK_PATH)}`, `export CHAT_PLATFORM=${shq(PLATFORM)}`,
      ...(tokenFile ? [tokenFile.load] : []),
      ...(promptFile ? [promptFile.load, `export HYDRA_SPAWN_PROMPT=${promptFile.ref}`] : []),
      `unset HYDRA_ROLE CLAUDE_CONFIG_DIR`,
      `${args.join(' ')} 2>>${shq(stderrLog)}`,
    ].join(' && ')
    mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
    try { tmuxCreateSession(tmuxName, [withRaisedFdLimit(inner)]) } catch (err) { removeSpawnPrompt({ tmuxName, sessionId }); removeSessionToken({ tmuxName, sessionId }); throw err }
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
  detectBlockingState(_info: SessionInfo, _tail: string): BlockingState | null { return null }
  // Resume continues the dead session's file (`launch` copies it). Not `generic`: boot recovery and the `recover` list skip omp (they would relaunch it as Claude). No fork.
  recoveryPlan(src: RecoverySource): RecoveryPlan {
    return { generic: false, resume: src.sessionId ? { kind: 'at-launch', resumeSession: { fromSessionId: src.sessionId } } : null, fork: null }
  }
}
