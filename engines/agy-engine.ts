// engines/agy-engine.ts
//
// agy (Google Antigravity CLI) engine adapter — a TUI in tmux, as for Claude and omp, so the operator can attach and work in the session.
// There is no channel into agy: a message starts a turn only as text in the pane, so deliver pastes it (agy queues text that arrives
// mid-turn). The hydra tools reach the model as MCP tools (agy-config.ts). The tmux mechanics are Claude's, so this delegates them; only launch,
// delivery, observation and recovery differ. Observation is agy's own files (agy-session.ts); a resume continues the conversation its record names.

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { SessionInfo } from '../sessions/registry.js'
import type {
  EngineAdapter, LaunchInput, LaunchResult, DeliveryResult, Notification, StopResult,
  ContextUsage, RecoveryPlan, RecoverySource, Turn,
} from './engine-adapter.js'
import { withoutIntents } from './engine-adapter.js'
import type { BlockingState } from './engine-adapter.js'
import { CLAUDE_WORKING_SILENCE_S, type ClaudeEngine } from './claude-engine.js'
import { FRESH_START_MS, SOCK_PATH, PLATFORM, SPAWN_LOGS_DIR, STATE_DIR } from '../infra/config.js'
import { removeSessionToken, removeSpawnPrompt, shq, writeSessionToken, writeSpawnPrompt } from '../infra/launch-files.js'
import { tmuxCreateSession, tmuxSync, tmuxWindowActivity } from '../infra/tmux.js'
import { SESSION_INSTRUCTIONS, contextWindowOf, formatNotification } from '../shared/constants.js'
import { withRaisedFdLimit } from '../shared/spawn-env.js'
import { AGY_HOOKS_CONFIG, AGY_MCP_CONFIG, registerHydraHooks, registerHydraTools } from './agy-config.js'
import { agyContextTokens, agyState, agyStateDir, agyStateFile, agyTurn } from './agy-session.js'

/** A Gemini API key, if the operator keeps one: agy then runs in its API-key mode, else on its own login. Only this file's path is on a command line. */
export const AGY_API_KEY_FILE = join(STATE_DIR, 'agy-api-key')
const PASTE_DIR = join(STATE_DIR, 'agy-paste')
const LANDED_WAIT_MS = 8_000
// A session still in FRESH_START_MS may be on agy's boot, login or folder-trust screen: its first hook event (turn().live is null until then) says agy takes input.
const READY_WAIT_MS = 60_000

/** The `--settings` JSON for one launch (never saved by agy): the folder is trusted, so agy does not stop to ask, and a key file means API-key mode. */
export function agySettings(cwd: string, apiKeyMode: boolean): string {
  return JSON.stringify({ trustedWorkspaces: [cwd], ...(apiKeyMode ? { modelProvider: 'gemini' } : {}) })
}

const collapse = (s: string) => s.replace(/\s+/g, '')

export class AgyEngine implements EngineAdapter {
  readonly provider = 'agy' as const
  readonly channel = 'engine' as const
  constructor(
    private readonly claude: ClaudeEngine,
    private readonly mcpConfig = AGY_MCP_CONFIG,
    private readonly hooksConfig = AGY_HOOKS_CONFIG,
    private readonly timing: { landedWaitMs?: number; pollMs?: number } = {},
  ) {}

  async start(): Promise<void> {}

  async launch(input: LaunchInput): Promise<LaunchResult> {
    const { sessionId, tmuxName } = input
    const model = input.model!   // doSpawnSession always gives agy one (its flash model when none is named)
    const cont = input.continuation
    if (cont && cont.kind !== 'resume-session') {
      throw new Error(`agy engine: unsupported launch continuation "${cont.kind}"`)
    }
    // Resume: agy continues the dead session's conversation (agy keeps conversations per folder: the caller launches in the folder the session had).
    // With no conversation on record agy would start a fresh one that the caller reports as resumed, so that fails the resume instead.
    const conversation = cont ? agyState(cont.fromSessionId)?.conversationId : undefined
    if (cont && !conversation) throw new Error(`agy session ${cont.fromSessionId} has no conversation to resume`)
    registerHydraTools(this.mcpConfig)
    registerHydraHooks(this.hooksConfig)
    mkdirSync(agyStateDir(), { recursive: true, mode: 0o700 })
    rmSync(agyStateFile(sessionId), { force: true })   // a relaunch of this session id starts with no word from agy
    const apiKeyMode = existsSync(AGY_API_KEY_FILE)
    // The key reaches the pane's environment, which agy's own commands can print: it must not also be readable by other users.
    if (apiKeyMode && statSync(AGY_API_KEY_FILE).mode & 0o077) throw new Error(`${AGY_API_KEY_FILE} is readable by other users: chmod 600 it`)
    const stderrLog = join(SPAWN_LOGS_DIR, `stderr-${tmuxName}-${sessionId}.log`)
    const agy = process.env.HYDRA_AGY_BIN || 'agy'
    // The reply rules go first in the first prompt: agy has no instructions channel of its own. The prompt is handed to the pane by file (launch-files.ts).
    mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
    let promptFile: ReturnType<typeof writeSpawnPrompt>, tokenFile: ReturnType<typeof writeSessionToken> | null = null
    try {
      promptFile = writeSpawnPrompt(tmuxName, sessionId, `${SESSION_INSTRUCTIONS}\n\n${input.prompt}`)
      if (input.sessionToken) tokenFile = writeSessionToken(tmuxName, sessionId, input.sessionToken)
    } catch (err) { removeSpawnPrompt({ tmuxName, sessionId }); removeSessionToken({ tmuxName, sessionId }); throw err }
    const args = [agy, `--model ${shq(model)}`, `--settings ${shq(agySettings(input.cwd, apiKeyMode))}`, '--dangerously-skip-permissions', ...(conversation ? [`--conversation ${shq(conversation)}`] : []), `-i ${promptFile.ref}`]
    const inner = [
      `cd ${shq(input.cwd)}`,
      `export HYDRA_SESSION_ID=${shq(sessionId)}`, `export HYDRA_SESSION_NAME=${shq(tmuxName)}`,
      `export HYDRA_THREAD_ID=${shq(input.threadId ?? '')}`, `export HYDRA_SESSION_TYPE=${shq(input.sessionType ?? '')}`,
      `export DAEMON_SOCK=${shq(SOCK_PATH)}`, `export CHAT_PLATFORM=${shq(PLATFORM)}`, `export HYDRA_AGY_STATE=${shq(agyStateFile(sessionId))}`,
      ...(apiKeyMode ? [`GEMINI_API_KEY=$(cat ${shq(AGY_API_KEY_FILE)}) && export GEMINI_API_KEY`] : []),
      ...(tokenFile ? [tokenFile.load] : []),
      promptFile.load,
      `unset HYDRA_ROLE CLAUDE_CONFIG_DIR`,
      `${args.join(' ')} 2>>${shq(stderrLog)}`,
    ].join(' && ')
    try { tmuxCreateSession(tmuxName, [withRaisedFdLimit(inner)]) } catch (err) { removeSpawnPrompt({ tmuxName, sessionId }); removeSessionToken({ tmuxName, sessionId }); throw err }
    return { provider: 'agy', model, identity: {}, stderrLogPath: stderrLog }
  }

  // One message at a time per session: two pastes before the first Enter would reach agy as one turn.
  private readonly sending = new Map<string, Promise<unknown>>()
  deliver(info: SessionInfo, msg: Notification): Promise<DeliveryResult> {
    const run = (this.sending.get(info.sessionId) ?? Promise.resolve()).then(() => this.paste(info, msg))
    const tail = run.catch(() => {}).then(() => { if (this.sending.get(info.sessionId) === tail) this.sending.delete(info.sessionId) })
    this.sending.set(info.sessionId, tail)
    return run
  }

  // Paste the message into the pane as one bracketed paste, then Enter, then wait for the pane to show it once more than before. agy shows a big paste as
  // "[Pasted text +N lines]" until Enter, so a big message counts only once sent; a short one is shown in the input box already, so for it this proves the
  // paste reached the pane, not that Enter sent it.
  private async paste(info: SessionInfo, msg: Notification): Promise<DeliveryResult> {
    const { content, meta } = withoutIntents(msg)
    const text = formatNotification(content, meta as Record<string, string> | undefined)
    const pollMs = this.timing.pollMs ?? 250
    const landedWaitMs = this.timing.landedWaitMs ?? LANDED_WAIT_MS
    if (Date.now() - info.createdAt < FRESH_START_MS) {
      for (const start = Date.now(); this.turn(info, 0).live === null; await Bun.sleep(pollMs)) {
        if (Date.now() - start > READY_WAIT_MS) return { status: 'rejected', retryable: true, reason: `${info.tmuxName} has not finished starting: agy has sent no first event` }
      }
    }
    const needle = collapse(text).slice(-40)
    const seen = () => collapse(this.peek(info, 200)).split(needle).length - 1
    const before = seen()
    mkdirSync(PASTE_DIR, { recursive: true, mode: 0o700 })
    const file = join(PASTE_DIR, `${info.sessionId}.txt`)
    try {
      writeFileSync(file, text, { mode: 0o600 })
      tmuxSync(['load-buffer', '-b', `hydra-${info.sessionId}`, file])
      tmuxSync(['paste-buffer', '-p', '-d', '-b', `hydra-${info.sessionId}`, '-t', info.tmuxName])
    } catch (err) {
      return { status: 'rejected', retryable: true, reason: `tmux paste into ${info.tmuxName} failed: ${err instanceof Error ? err.message : err}` }
    } finally { rmSync(file, { force: true }) }
    // The text is in agy's input now: a failed Enter must not be retried as a whole message, or it would be pasted twice. A caller retries an `unknown` (targets.ts `outcomeOf`), so these are non-retryable rejections.
    try {
      await Bun.sleep(150)   // the pane takes the paste before the Enter that sends it
      tmuxSync(['send-keys', '-t', info.tmuxName, 'Enter'])
    } catch (err) {
      return { status: 'rejected', retryable: false, reason: `the message was pasted into ${info.tmuxName} but Enter failed: ${err instanceof Error ? err.message : err}` }
    }
    for (const start = Date.now(); Date.now() - start < landedWaitMs; await Bun.sleep(pollMs)) {
      if (seen() > before) return { status: 'accepted', via: 'tmux-paste' }
    }
    return { status: 'rejected', retryable: false, reason: `the message was pasted into ${info.tmuxName} but the pane never showed it, so it may or may not have been sent` }
  }
  isConnected(info: SessionInfo): boolean { return this.claude.isAlive(info) }
  stop(info: SessionInfo): Promise<StopResult> { return this.claude.stop(info) }
  isAlive(info: SessionInfo): boolean { return this.claude.isAlive(info) }
  peek(info: SessionInfo, lines?: number): string { return this.claude.peek(info, lines) }
  surface(info: SessionInfo): string | null { return this.claude.surface(info) }
  sendKeys(info: SessionInfo, keys: string, opts?: { raw?: boolean; trailingKey?: string }) { return this.claude.sendKeys(info, keys, opts) }
  interrupt(info: SessionInfo): Promise<void> { return this.claude.interrupt(info) }

  // agy's own record (agy-session.ts): the turn is over when agy has stopped with nothing running and its transcript ends in an answer to a message from at or
  // after sinceMs; that answer's text is what the reply guard relays. `live` is agy's hook's word: working from a model call until a stop.
  turn(info: SessionInfo, sinceMs: number): Turn {
    const { complete, text } = agyTurn(info.sessionId, sinceMs)
    const state = agyState(info.sessionId)
    return {
      confirmedComplete: complete,
      answer: () => (complete && text?.trim() ? text : null),
      live: state ? state.live : null,
      workingSilenceLimitS: CLAUDE_WORKING_SILENCE_S,   // an interrupted or crashed agy may never send its stop
      ...(state?.backgroundWork ? { backgroundWork: true } : {}),
      get activityAt() { try { return tmuxWindowActivity(info.tmuxName) } catch { return null } },
    }
  }

  // Context tokens of the last model call over the model's window.
  usage(info: SessionInfo): ContextUsage | null {
    const used = agyContextTokens(info.sessionId)
    const window = contextWindowOf(info.sessionMetadata?.model)
    return used === null || !window ? null : { usedTokens: used, contextWindow: window, percent: Math.min(100, Math.round(used * 100 / window)) }
  }
  detectBlockingState(): BlockingState | null { return null }
  // Resume continues the dead session's conversation (`launch` finds its id in the dead session's record). Not `generic`: boot recovery and the `recover` list skip agy (they would relaunch it as Claude). No fork.
  recoveryPlan(src: RecoverySource): RecoveryPlan {
    return { generic: false, resume: src.sessionId ? { kind: 'at-launch', resumeSession: { fromSessionId: src.sessionId } } : null, fork: null }
  }
}
