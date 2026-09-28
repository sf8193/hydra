// daemon/engines/codex-engine-adapter.ts
//
// Codex engine adapter — wraps the CodexEngine (app-server + unix socket)
// and the disposable tmux TUI.

import { execFile, execFileSync, execSync } from 'child_process'
import { promisify } from 'util'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { codexSpawnEnv, tmuxNewSession } from '../../shared/spawn-env.js'
import { registry, type SessionInfo } from '../sessions.js'
import type { BlockingState } from '../pane-probe.js'
import type {
  EngineAdapter, LaunchInput, LaunchResult,
  DeliveryMode, DeliveryResult, Notification,
  StopResult,
  ContextUsage, RecoverySource, RecoveryPlan, Turn, UsageReading, UsageSubject,
} from './engine-adapter.js'
import { codexUsageTotals } from '../codex-rollout.js'
import { codexSocketPath, type CodexEngine } from '../codex-engine.js'
import { codexHomeDir as codexHomeDirFn, startCodexAppServer, stopCodexAppServer } from '../codex-process.js'
import { parseContextPercent, safeSend, tmuxHasSession, tmuxWindowActivity } from '../util.js'
import { sendTmuxKeys, type TmuxKeyAction } from '../codex-key-queue.js'
import { SOCK_PATH, STATE_DIR } from '../config.js'
import { codexTurnOutcome, defaultTurnSources } from './codex-observation.js'
import { codexPiggyback, type CodexPiggyback } from './codex-piggyback.js'
import { isCodexReconnecting, reconnectCodexSessions } from './codex-runtime.js'

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
const SPAWN_LOGS_DIR = join(STATE_DIR, 'spawn-logs')
const execFileAsync = promisify(execFile)

function registerCodexMcp(homeDir: string, sessionId: string, tmuxName: string): void {
  const mcpServerPath = join(new URL('.', import.meta.url).pathname, '..', 'codex-mcp-server.ts')
  try {
    execFileSync('bash', ['-c', [
      `mkdir -p ${shq(homeDir)}`,
      `ln -sf ~/.codex/auth.json ${shq(homeDir)}/auth.json`,
      `CODEX_HOME=${shq(homeDir)} codex mcp remove hydra 2>/dev/null; CODEX_HOME=${shq(homeDir)} codex mcp add hydra --env DAEMON_SOCK=${shq(SOCK_PATH)} --env HYDRA_SESSION_ID=${shq(sessionId)} -- bun ${shq(mcpServerPath)}`,
    ].join(' && ')], { stdio: 'pipe', env: codexSpawnEnv() })
  } catch (err) {
    process.stderr.write(`daemon: codex MCP registration failed for ${tmuxName}: ${err}\n`)
  }
}

// A Codex resume adopts the original CODEX_HOME: the record other than the one
// being replaced that already owns that home, if any. Pure.
export function resumeHomeOwner(records: Iterable<SessionInfo>, resumeCodex: { homeName: string }, replacing: string | undefined): SessionInfo | undefined {
  const home = resumeCodex.homeName
  return [...records].find(s => s.sessionId !== replacing && s.engine === 'codex' && (s.codexHomeName ?? s.tmuxName) === home)
}

/** Process side effects of launch — injectable so tests never touch ~/.codex or spawn codex. */
export const codexLaunchProcess = { registerMcp: registerCodexMcp, start: startCodexAppServer, stop: stopCodexAppServer }

export class CodexEngineAdapter implements EngineAdapter {
  readonly provider = 'codex' as const
  readonly channel = 'engine' as const
  constructor(
    private readonly engine: CodexEngine,
    private readonly proc = codexLaunchProcess,
    private readonly piggyback: CodexPiggyback = codexPiggyback,
  ) {}

  // Launch resumes the thread in its original CODEX_HOME and takes the prompt.
  // A stray claudeSessionId is ignored (PINNED R9; PR-IDENT). Nothing to
  // discover: launch and reconnect assign the Codex thread id.
  recoveryPlan(s: RecoverySource): RecoveryPlan {
    const t = s.codexThreadId
    if (!t) return { generic: false, resume: null, fork: null }
    const home = s.codexHomeName ?? s.tmuxName
    return {
      generic: false,
      resume: { kind: 'at-launch', resumeCodex: { threadId: t, homeName: home } },
      fork: { codexThreadId: t, codexHomeName: home, parentName: s.tmuxName },
    }
  }

  // The live app-server socket, or the runtime reconnecting it (the grace), is the
  // truth. A queued turn waits out a reconnect, so deliverable == alive.
  isConnected(info: SessionInfo): boolean {
    return this.isAlive(info)
  }

  // ⚠ F4s (pinned, fixed in S10): tmux window_activity of the session's current
  // window, which after surface repair is the static anchor, not the TUI pane.
  turn(info: SessionInfo, sinceMs: number): Turn {
    const { confirmedComplete, answer } = codexTurnOutcome(info, sinceMs, defaultTurnSources)
    return {
      confirmedComplete, answer,
      get activityAt() { try { return tmuxWindowActivity(info.tmuxName) } catch { return null } },
    }
  }

  // The boot sweep, with the completion and failure logging daemon.ts did.
  start(records: readonly SessionInfo[]): Promise<void> {
    return reconnectCodexSessions(records).then(() => {
      process.stderr.write('daemon: codex reconnection sweep complete\n')
    }).catch(err => {
      process.stderr.write(`daemon: codex reconnection failed: ${err}\n`)
    })
  }

  // Registers the MCP sidecar and starts the durable app-server; returns the spawn log path.
  private startAppServer(input: LaunchInput, codexHomeName: string): string {
    const { sessionId, tmuxName, cwd: effectiveCwd, model } = input
    this.proc.registerMcp(codexHomeDirFn(codexHomeName), sessionId, tmuxName)

    mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
    const spawnLogPath = join(SPAWN_LOGS_DIR, `${tmuxName}-${sessionId}.log`)

    // Always (re)start, even when resuming onto a live app-server: a thread
    // already loaded there keeps the MCP sidecar spawned with the OLD
    // HYDRA_SESSION_ID (verified against codex-cli 0.157.1), so its hydra tools
    // would act as the dead session. A restart reloads the thread from its rollout
    // with the sidecar just registered above.
    process.stderr.write(`daemon: codex spawning durable app-server for ${tmuxName} (home ${codexHomeName})\n`)
    this.proc.start({ homeName: codexHomeName, cwd: effectiveCwd, logPath: spawnLogPath, model })
    return spawnLogPath
  }

  async launch(input: LaunchInput): Promise<LaunchResult> {
    const { sessionId, tmuxName, model, prompt, resumeCodex } = input
    // Resume reuses the ORIGINAL home: the rollout lives there, and a fresh home cannot see it.
    const codexHomeName = resumeCodex?.homeName ?? tmuxName
    const sockPath = codexSocketPath(codexHomeName)
    const spawnLogPath = this.startAppServer(input, codexHomeName)

    // The launch prompt is FIFO item zero. Queue it before establishing the
    // thread so every later user message uses the same turn scheduler.
    this.engine.queueTurn(sessionId, prompt)

    // Connect to the app-server socket with retry
    const start = Date.now()
    let codexThreadId: string | null = null
    let resolvedModel = model
    let lastErr = ''
    while (Date.now() - start < 15_000) {
      try {
        if (resumeCodex) {
          const r = await this.engine.connectAndResume(sessionId, sockPath, resumeCodex.threadId)
          codexThreadId = resumeCodex.threadId
          resolvedModel = r.model ?? resolvedModel
        } else if (input.forkFrom?.codexThreadId) {
          const r = await this.engine.connectAndFork(sessionId, sockPath, input.forkFrom.codexThreadId, model)
          codexThreadId = r.threadId
          resolvedModel = r.model ?? resolvedModel
        } else {
          const r = await this.engine.connect(sessionId, sockPath, model)
          codexThreadId = r.threadId
          resolvedModel = r.model ?? resolvedModel
        }
        break
      } catch (err: any) {
        lastErr = err?.message || String(err)
        try { this.engine.disconnect(sessionId) } catch {}
        await new Promise(r => setTimeout(r, 500))
      }
    }
    if (!codexThreadId) {
      process.stderr.write(`daemon: stopping codex app-server ${tmuxName} (startup timeout: ${lastErr})\n`)
      this.proc.stop(codexHomeName)
      throw new Error(`codex socket not ready after 15s (last: ${lastErr})`)
    }
    process.stderr.write(`daemon: codex connected for ${tmuxName}, thread=${codexThreadId}\n`)
    // Create the tmux surface now so neutral tmux-based liveness sees the session
    // before its first turn completes. Best effort: surface logs and returns null.
    this.surface({ sessionId, tmuxName, codexThreadId, codexHomeName } as SessionInfo)

    return {
      provider: 'codex', model: resolvedModel ?? 'codex-default',
      identity: { codexThreadId, ...(resumeCodex ? { codexHomeName } : {}) }, spawnLogPath,
    }
  }

  // Every delivery is a priced turn, so the intents decide whether it gets one.
  deliver(info: SessionInfo, msg: Notification): Promise<DeliveryResult> {
    if (msg.optional === true) return Promise.resolve({ status: 'rejected', retryable: false, reason: 'optional delivery dropped for codex' })
    // Accepting into a dead session's queue would lose it silently.
    if (!this.isAlive(info)) return Promise.resolve({ status: 'rejected', retryable: false, reason: 'session is dead — resume or respawn' })
    // Ride the next turn the user creates instead of paying for a standalone
    // one, CI failures and changes-requested included — Sam's call
    // (2026-09-15): the 1h backstop bounds the delay, no urgency carve-out.
    if (msg.lowPriority === true) {
      this.piggyback.buffer(info.sessionId, msg.content as string)
      return Promise.resolve({ status: 'accepted', via: 'piggyback-buffer' })
    }
    // Opt-IN, not opt-out: only a caller that knows it's delivering a turn the
    // user actually created (a real message, not a liveness/procedural nudge
    // the model may no-op on) carries buffered content along. begin() takes
    // ownership of exactly what rides — a new item can land before delivery
    // resolves — and finish() settles only that receipt.
    const text = typeof msg.content === 'string' && msg.content ? msg.content : undefined
    const prefix = text && msg.allowPiggyback === true ? this.piggyback.begin(info.sessionId) : undefined
    if (!prefix) return this.deliverTurn(info, msg)
    const sid = info.sessionId
    const finish = (result: DeliveryResult) => this.piggyback.finish(sid, prefix, result)
    try {
      return this.deliverTurn(info, { ...msg, content: `${prefix.items.join('\n\n')}\n\n---\n\n${text}` })
        .then(finish, err => finish({ status: 'unknown', reason: String(err) }))
    } catch (err) {
      return Promise.resolve(finish({ status: 'unknown', reason: String(err) }))
    }
  }

  /** One turn's worth of delivery: steer, or queue for the next turn. */
  async deliverTurn(info: SessionInfo, msg: Notification): Promise<DeliveryResult> {
    const text = msg.content
    // Silent, as when sendOrQueue dropped it before reaching the adapter (PINNED E1b).
    if (typeof text !== 'string' || !text) return { status: 'rejected', retryable: false, reason: 'non-text content' }
    if (text === '[system] keepalive') {
      return { status: 'rejected', retryable: false, reason: 'keepalive blocked for codex' }
    }
    const mode: DeliveryMode | undefined = msg.deferUntilTurnComplete === true || msg.handoff === true ? 'next-turn' : undefined
    const meta = msg.meta
    // Enrich before transferring ownership to the queue, including while the
    // app-server connection is absent.
    let deliveryText = text
    const downloadedFiles = meta?.downloaded_files
    if (downloadedFiles) deliveryText += `\n\n[attachments: ${downloadedFiles}]`

    if (mode === 'next-turn') {
      const accepted = this.engine.queueTurn(info.sessionId, deliveryText)
      return accepted
        ? { status: 'accepted', via: 'queued-turn' }
        : { status: 'rejected', retryable: false, reason: 'session is retiring' }
    }

    return this.engine.steer(info.sessionId, deliveryText)
  }

  async stop(info: SessionInfo): Promise<StopResult> {
    this.engine.disconnect(info.sessionId)
    // A home another LIVE record claims (e.g. adopted by a resume) is not ours to stop.
    // Dead records don't count, or a lingering one would leak the live owner's server.
    const home = info.codexHomeName ?? info.tmuxName
    const claimed = [...registry.values()].some(s => s !== info && !s.deadAt && s.engine === 'codex' && (s.codexHomeName ?? s.tmuxName) === home)
    if (!claimed) this.proc.stop(home)
    try { execFileSync('tmux', ['kill-session', '-t', info.tmuxName], { stdio: 'pipe' }) } catch {}
    return { status: 'stopped' }
  }

  // Not tmux: the hydra-anchor window outlives a dead app-server. Not deadAt: the
  // runtime writes that as the verdict when reconnecting gives up.
  isAlive(info: SessionInfo): boolean {
    return this.engine.isConnected(info.sessionId) || isCodexReconnecting(info.sessionId)
  }

  peek(info: SessionInfo, lines: number = 50): string {
    try {
      return execSync(
        `tmux capture-pane -t ${shq(`${info.tmuxName}:hydra-chat`)} -p -S -${lines}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 },
      ).trimEnd()
    } catch {
      // Fall back to main pane if hydra-chat window doesn't exist
      try {
        return execSync(
          `tmux capture-pane -t ${shq(info.tmuxName)} -p -S -${lines}`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 },
        ).trimEnd()
      } catch { return '' }
    }
  }

  usage(info: SessionInfo): ContextUsage | null {
    // Prefer structured usage from codex-runtime's contextUsage event
    if (info.contextUsage) {
      return { usedTokens: info.contextUsage.usedTokens, contextWindow: info.contextUsage.contextWindow, percent: info.contextUsage.percent }
    }
    // Fall back to pane-capture approach
    try {
      const pane = execFileSync('tmux', ['capture-pane', '-t', `${info.tmuxName}:hydra-chat`, '-p'],
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 }).toString()
      const percent = parseContextPercent(pane)
      if (percent === null) return null
      return { usedTokens: 0, contextWindow: 0, percent }
    } catch { return null }
  }

  usageTotals(info: UsageSubject, prev: unknown): UsageReading | null {
    return codexUsageTotals(info, prev)
  }

  surface(info: SessionInfo): string | null {
    const target = `${info.tmuxName}:hydra-chat`
    if (!info.codexThreadId) return null
    try {
      // A remote Codex TUI can take its tmux session down when the attached turn
      // finishes even though the daemon-owned app-server and socket remain live.
      // Recreate a durable container around that live engine.
      if (!tmuxHasSession(info.tmuxName)) {
        if (!this.engine.isConnected(info.sessionId)) return null
        try {
          tmuxNewSession(['-d', '-s', info.tmuxName, '-n', 'hydra-anchor', 'while :; do sleep 3600; done'],
            { encoding: 'utf8', timeout: 2000 })
          process.stderr.write(`daemon: codex adapter recreated tmux container for ${info.tmuxName}\n`)
        } catch (err) {
          if (!tmuxHasSession(info.tmuxName)) throw err
        }
      }
      const windows = execFileSync('tmux', ['list-windows', '-t', info.tmuxName, '-F', '#{window_name}'],
        { encoding: 'utf8', timeout: 2000, stdio: 'pipe' })
      if (windows.split('\n').includes('hydra-chat')) return target
      // Never start a TUI against a dead server; the anchor alone would let this through.
      if (!this.engine.isConnected(info.sessionId)) return null
      const homeName = info.codexHomeName ?? info.tmuxName
      const codexHome = join(homedir(), '.codex', `hydra-${homeName}`)
      const socket = codexSocketPath(homeName)
      const command = `export CODEX_HOME=${shq(codexHome)} && codex resume ${shq(info.codexThreadId)} --remote ${shq(`unix://${socket}`)}`
      execFileSync('tmux', ['new-window', '-n', 'hydra-chat', '-t', info.tmuxName, command],
        { encoding: 'utf8', timeout: 2000, stdio: 'pipe' })
      process.stderr.write(`daemon: codex adapter recreated TUI for ${info.tmuxName}\n`)
      return target
    } catch (err) {
      process.stderr.write(`daemon: codex adapter could not ensure TUI for ${info.tmuxName}: ${err}\n`)
      return null
    }
  }

  async sendKeys(info: SessionInfo, keys: string, opts?: { raw?: boolean; trailingKey?: string }): Promise<{ queued: boolean }> {
    const target = `${info.tmuxName}:hydra-chat`
    const action: TmuxKeyAction = opts?.raw
      ? { target, mode: 'raw', keys: keys.split(/\s+/) }
      : { target, mode: 'literal', text: keys, trailingKey: opts?.trailingKey }
    await sendTmuxKeys(action, action.mode === 'literal' ? pane => this.waitForComposer(pane) : undefined)
    return { queued: false }
  }

  private async waitForComposer(target: string): Promise<void> {
    const deadline = Date.now() + 5000
    do {
      // A newly created window is not necessarily a ready TUI. Inspect the live
      // viewport at the visible cursor for Codex's composer before typing text.
      // Menus also use ›, but hide the cursor; a prompt elsewhere is not enough.
      // Raw keys deliberately bypass this check so dialogs remain controllable.
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      try {
        const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '-t', target,
          '#{cursor_flag} #{cursor_x} #{cursor_y}', ';', 'capture-pane', '-p', '-t', target],
          { timeout: Math.min(1000, remaining) })
        const [cursor, ...lines] = stdout.split('\n')
        const match = cursor.match(/^1 (\d+) (\d+)$/)
        if (match && Number(match[1]) >= 2 && /^›(?: |$)/.test(lines[Number(match[2])] ?? '')) return
      } catch { /* Missing/cold panes may become ready within the deadline. */ }
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
    } while (Date.now() < deadline)
    throw new Error(`Codex composer is not ready for ${target} after 5s; no text was sent`)
  }

  async interrupt(info: SessionInfo): Promise<void> {
    // Connected: acknowledged app-server interrupt; the next queued turn still
    // waits for the interrupted turn's completion. Otherwise fall back to the TUI.
    if (this.engine.isConnected(info.sessionId)) {
      await this.engine.interruptActiveTurn(info.sessionId)
      return
    }
    const target = `${info.tmuxName}:hydra-chat`
    Bun.spawn(['tmux', 'send-keys', '-t', target, 'Escape'], { stdio: ['pipe', 'pipe', 'pipe'] })
  }

  detectBlockingState(_info: SessionInfo, _tailText: string): BlockingState | null {
    return null
  }

  // Boot and disconnect recovery (codex-runtime); not part of EngineAdapter.
  async reconnect(info: SessionInfo): Promise<boolean> {
    const sockPath = codexSocketPath(info.codexHomeName ?? info.tmuxName)
    // Generation bound (invariant 10): if this record was replaced or removed while
    // we awaited, its home may belong to a successor — touch nothing.
    const stale = () => {
      if (registry.get(info.sessionId) === info) return false
      try { this.engine.disconnect(info.sessionId) } catch {}
      process.stderr.write(`codex-adapter: abandoning stale reconnect for ${info.tmuxName}\n`)
      return true
    }

    // Check if app-server socket is reachable (survives tmux death)
    let socketLive = false
    try { socketLive = await this.engine.isSocketLive(sockPath) } catch {}
    if (stale()) return false
    if (!socketLive && !tmuxHasSession(info.tmuxName)) return false

    if (info.codexThreadId) {
      try {
        const result = await this.engine.connectAndResume(info.sessionId, sockPath, info.codexThreadId)
        if (stale()) return false
        if (result.model && info.sessionMetadata) info.sessionMetadata.model = result.model
        process.stderr.write(`codex-adapter: reconnected ${info.tmuxName} (resumed)\n`)
        // A close during the resume's queue drain can already have dropped the
        // socket (and its event is swallowed while we're reconnecting).
        return this.engine.isConnected(info.sessionId)
      } catch (err: any) {
        process.stderr.write(`codex-adapter: resume failed for ${info.tmuxName}: ${err?.message || err}\n`)
        try { this.engine.disconnect(info.sessionId) } catch {}
        await new Promise(r => setTimeout(r, 2000))
        if (stale()) return false
      }
    }

    const hadPriorThread = !!info.codexThreadId
    try {
      const result = await this.engine.connect(info.sessionId, sockPath)
      if (stale()) return false
      info.codexThreadId = result.threadId
      if (result.model && info.sessionMetadata) info.sessionMetadata.model = result.model
      if (hadPriorThread) {
        void safeSend(info.threadId, `⚠️ Session resumed but conversation history was lost. The agent is starting fresh.`)
      }
      process.stderr.write(`codex-adapter: reconnected ${info.tmuxName} (new thread)\n`)
      return this.engine.isConnected(info.sessionId)
    } catch (err: any) {
      process.stderr.write(`codex-adapter: fresh connect failed for ${info.tmuxName}: ${err?.message || err}\n`)
      try { this.engine.disconnect(info.sessionId) } catch {}
      return false
    }
  }
}
