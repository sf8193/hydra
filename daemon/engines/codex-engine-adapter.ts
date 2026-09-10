// daemon/engines/codex-engine-adapter.ts
//
// Codex engine adapter — wraps the CodexEngine (app-server + unix socket)
// and the disposable tmux TUI.

import { execFileSync, execSync } from 'child_process'
import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SessionInfo } from '../sessions.js'
import type { BlockingState } from '../pane-probe.js'
import type {
  EngineAdapter, LaunchInput, LaunchResult,
  DeliveryMode, DeliveryResult,
  ExecutionRetirementResult, StopResult,
  ContextUsage, EngineSnapshot,
} from './engine-adapter.js'
import { codexSocketPath, type CodexEngine } from '../codex-engine.js'
import { codexHomeDir as codexHomeDirFn, startCodexAppServer, stopCodexAppServer } from '../codex-process.js'
import { tmuxHasSession } from '../util.js'
import { SOCK_PATH, STATE_DIR } from '../config.js'

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
const SPAWN_LOGS_DIR = join(STATE_DIR, 'spawn-logs')

export class CodexEngineAdapter implements EngineAdapter {
  readonly provider = 'codex' as const
  constructor(private readonly engine: CodexEngine) {}

  async launch(input: LaunchInput): Promise<LaunchResult> {
    const { sessionId, tmuxName, cwd: effectiveCwd, model, prompt } = input
    const codexHomeName = tmuxName
    const sockPath = codexSocketPath(codexHomeName)
    const homeDir = codexHomeDirFn(codexHomeName)

    // Register MCP server before starting app-server
    const mcpServerPath = join(new URL('.', import.meta.url).pathname, '..', 'codex-mcp-server.ts')
    try {
      execFileSync('bash', ['-c', [
        `mkdir -p ${shq(homeDir)}`,
        `ln -sf ~/.codex/auth.json ${shq(homeDir)}/auth.json`,
        `CODEX_HOME=${shq(homeDir)} codex mcp remove hydra 2>/dev/null; CODEX_HOME=${shq(homeDir)} codex mcp add hydra --env DAEMON_SOCK=${shq(SOCK_PATH)} --env HYDRA_SESSION_ID=${shq(sessionId)} -- bun ${shq(mcpServerPath)}`,
      ].join(' && ')], { stdio: 'pipe' })
    } catch (err) {
      process.stderr.write(`daemon: codex MCP registration failed for ${tmuxName}: ${err}\n`)
    }

    mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
    const spawnLogPath = join(SPAWN_LOGS_DIR, `${tmuxName}-${sessionId}.log`)

    process.stderr.write(`daemon: codex spawning durable app-server for ${tmuxName}\n`)
    startCodexAppServer({ homeName: codexHomeName, cwd: effectiveCwd, logPath: spawnLogPath, model })

    // Connect to the app-server socket with retry
    const start = Date.now()
    let codexThreadId: string | null = null
    let resolvedModel = model
    let lastErr = ''
    while (Date.now() - start < 15_000) {
      try {
        if (input.forkFrom?.codexThreadId) {
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
      stopCodexAppServer(codexHomeName)
      throw new Error(`codex socket not ready after 15s (last: ${lastErr})`)
    }
    process.stderr.write(`daemon: codex connected for ${tmuxName}, thread=${codexThreadId}\n`)

    void this.engine.startTurn(sessionId, prompt).catch(err => {
      process.stderr.write(`daemon: codex startTurn failed for ${tmuxName}: ${err}\n`)
    })

    return {
      provider: 'codex', model: resolvedModel ?? 'codex-default',
      codexThreadId, spawnLogPath,
    }
  }

  async deliver(info: SessionInfo, text: string, mode?: DeliveryMode, meta?: Record<string, string>): Promise<DeliveryResult> {
    if (!this.engine.isConnected(info.sessionId)) {
      return { status: 'rejected', retryable: true, reason: 'codex session not connected' }
    }
    if (text === '[system] keepalive') {
      return { status: 'rejected', retryable: false, reason: 'keepalive blocked for codex' }
    }
    // Enrich with attachment paths so Codex can view images/files
    // (mirrors sendOrQueue's downloaded_files enrichment)
    let steerText = text
    const downloadedFiles = meta?.downloaded_files
    if (downloadedFiles) steerText += `\n\n[attachments: ${downloadedFiles}]`

    if (mode === 'next-turn') {
      this.engine.queueTurn(info.sessionId, steerText)
      return { status: 'accepted', via: 'queued-turn' }
    }
    this.engine.steer(info.sessionId, steerText)
    return { status: 'accepted', via: 'steer' }
  }

  async retire(info: SessionInfo, _reason: string): Promise<ExecutionRetirementResult> {
    try {
      await this.engine.retireSession(info.sessionId)
    } catch {}
    // Also interrupt any persisted thread so it doesn't keep running after we leave
    if (info.codexThreadId) {
      const sockPath = codexSocketPath(info.codexHomeName ?? info.tmuxName)
      try {
        await this.engine.interruptPersistedThread(sockPath, info.codexThreadId)
      } catch {}
    }
    return { status: 'terminal' }
  }

  async stop(info: SessionInfo): Promise<StopResult> {
    this.engine.disconnect(info.sessionId)
    stopCodexAppServer(info.codexHomeName ?? info.tmuxName)
    try { execFileSync('tmux', ['kill-session', '-t', info.tmuxName], { stdio: 'pipe' }) } catch {}
    return { status: 'stopped' }
  }

  async isAlive(info: SessionInfo): Promise<boolean> {
    if (this.engine.isConnected(info.sessionId)) return true
    // Check if the app-server socket is reachable even when we're not connected
    const sockPath = codexSocketPath(info.codexHomeName ?? info.tmuxName)
    try {
      if (await this.engine.isSocketLive(sockPath)) return true
    } catch {}
    return tmuxHasSession(info.tmuxName)
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
    // Prefer structured usage from codex-bootstrap's contextUsage event
    if (info.contextUsage) {
      return { usedTokens: info.contextUsage.usedTokens, contextWindow: info.contextUsage.contextWindow, percent: info.contextUsage.percent }
    }
    // Fall back to pane-capture approach
    try {
      const pane = execFileSync('tmux', ['capture-pane', '-t', `${info.tmuxName}:hydra-chat`, '-p', '-S', '-3'],
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 }).toString()
      const tail = pane.trimEnd()
      const match = tail.match(/(\d+)%/)
      if (!match) return null
      return { usedTokens: 0, contextWindow: 0, percent: parseInt(match[1], 10) }
    } catch { return null }
  }

  async status(info: SessionInfo): Promise<EngineSnapshot> {
    const connected = this.engine.isConnected(info.sessionId)
    const alive = connected || tmuxHasSession(info.tmuxName)
    const ctx = this.usage(info)
    return {
      provider: 'codex',
      execution: alive ? 'running' : 'dead',
      connection: connected ? 'connected' : 'disconnected',
      surface: tmuxHasSession(info.tmuxName) ? 'present' : 'absent',
      context: ctx,
      turnActive: info.turnState === 'working',
    }
  }

  uiTarget(info: SessionInfo): string { return `${info.tmuxName}:hydra-chat` }

  ensureSurface(info: SessionInfo): boolean {
    if (!info.codexThreadId) return false
    try {
      // A remote Codex TUI can take its tmux session down when the attached turn
      // finishes even though the daemon-owned app-server and socket remain live.
      // Recreate a durable container around that live engine.
      if (!tmuxHasSession(info.tmuxName)) {
        if (!this.engine.isConnected(info.sessionId)) return false
        try {
          execFileSync('tmux', [
            'new-session', '-d', '-s', info.tmuxName, '-n', 'hydra-anchor',
            'while :; do sleep 3600; done',
          ], { encoding: 'utf8', timeout: 2000, stdio: 'pipe' })
          process.stderr.write(`daemon: codex adapter recreated tmux container for ${info.tmuxName}\n`)
        } catch (err) {
          if (!tmuxHasSession(info.tmuxName)) throw err
        }
      }
      const windows = execFileSync('tmux', ['list-windows', '-t', info.tmuxName, '-F', '#{window_name}'],
        { encoding: 'utf8', timeout: 2000, stdio: 'pipe' })
      if (windows.split('\n').includes('hydra-chat')) return true
      const homeName = info.codexHomeName ?? info.tmuxName
      const codexHome = join(homedir(), '.codex', `hydra-${homeName}`)
      const socket = codexSocketPath(homeName)
      const command = `export CODEX_HOME=${shq(codexHome)} && codex resume ${shq(info.codexThreadId)} --remote ${shq(`unix://${socket}`)}`
      execFileSync('tmux', ['new-window', '-d', '-n', 'hydra-chat', '-t', info.tmuxName, command],
        { encoding: 'utf8', timeout: 2000, stdio: 'pipe' })
      process.stderr.write(`daemon: codex adapter recreated TUI for ${info.tmuxName}\n`)
      return true
    } catch (err) {
      process.stderr.write(`daemon: codex adapter could not ensure TUI for ${info.tmuxName}: ${err}\n`)
      return false
    }
  }

  async sendKeys(info: SessionInfo, keys: string): Promise<void> {
    const target = `${info.tmuxName}:hydra-chat`
    execFileSync('tmux', ['send-keys', '-t', target, '-l', keys], { timeout: 3000 })
    execFileSync('tmux', ['send-keys', '-t', target, 'Enter'], { timeout: 3000 })
  }

  async interrupt(info: SessionInfo): Promise<void> {
    const target = `${info.tmuxName}:hydra-chat`
    Bun.spawn(['tmux', 'send-keys', '-t', target, 'Escape'], { stdio: ['pipe', 'pipe', 'pipe'] })
  }

  detectBlockingState(_info: SessionInfo, _tailText: string): BlockingState | null {
    return null
  }

  async reconnect(info: SessionInfo): Promise<boolean> {
    const sockPath = codexSocketPath(info.codexHomeName ?? info.tmuxName)

    // Check if app-server socket is reachable (survives tmux death)
    let socketLive = false
    try { socketLive = await this.engine.isSocketLive(sockPath) } catch {}
    if (!socketLive && !tmuxHasSession(info.tmuxName)) return false

    if (info.codexThreadId) {
      try {
        const result = await this.engine.connectAndResume(info.sessionId, sockPath, info.codexThreadId)
        if (result.model && info.sessionMetadata) info.sessionMetadata.model = result.model
        process.stderr.write(`codex-adapter: reconnected ${info.tmuxName} (resumed)\n`)
        return true
      } catch (err: any) {
        process.stderr.write(`codex-adapter: resume failed for ${info.tmuxName}: ${err?.message || err}\n`)
        try { this.engine.disconnect(info.sessionId) } catch {}
        await new Promise(r => setTimeout(r, 2000))
      }
    }

    const hadPriorThread = !!info.codexThreadId
    try {
      const result = await this.engine.connect(info.sessionId, sockPath)
      info.codexThreadId = result.threadId
      if (result.model && info.sessionMetadata) info.sessionMetadata.model = result.model
      if (hadPriorThread) {
        const { safeSend } = await import('../util.js')
        void safeSend(info.threadId, `⚠️ Session resumed but conversation history was lost. The agent is starting fresh.`)
      }
      process.stderr.write(`codex-adapter: reconnected ${info.tmuxName} (new thread)\n`)
      return true
    } catch (err: any) {
      process.stderr.write(`codex-adapter: fresh connect failed for ${info.tmuxName}: ${err?.message || err}\n`)
      try { this.engine.disconnect(info.sessionId) } catch {}
      return false
    }
  }
}
