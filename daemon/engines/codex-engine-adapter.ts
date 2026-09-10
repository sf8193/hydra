// daemon/engines/codex-engine-adapter.ts
//
// Codex engine adapter — wraps the CodexEngine (app-server + unix socket)
// and the disposable tmux TUI.

import { execFileSync, execSync } from 'child_process'
import type { SessionInfo } from '../sessions.js'
import type { BlockingState } from '../pane-probe.js'
import type {
  EngineAdapter,
  DeliveryMode, DeliveryResult,
  ExecutionRetirementResult, StopResult,
  ContextUsage, EngineSnapshot,
} from './engine-adapter.js'
import { codexSocketPath, type CodexEngine } from '../codex-engine.js'
import { transport } from '../bridge-transport.js'
import { tmuxHasSession } from '../util.js'

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

export class CodexEngineAdapter implements EngineAdapter {
  readonly provider = 'codex' as const
  constructor(private readonly engine: CodexEngine) {}

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

  async retire(_info: SessionInfo, _reason: string): Promise<ExecutionRetirementResult> {
    return { status: 'unknown', reason: 'main branch codex has no native retirement' }
  }

  async stop(info: SessionInfo): Promise<StopResult> {
    this.engine.disconnect(info.sessionId)
    try { execFileSync('tmux', ['kill-session', '-t', info.tmuxName], { stdio: 'pipe' }) } catch {}
    return { status: 'stopped' }
  }

  async isAlive(info: SessionInfo): Promise<boolean> {
    return this.engine.isConnected(info.sessionId) || tmuxHasSession(info.tmuxName)
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
    // Same pane-capture approach as Claude — both engines parse the tmux status bar.
    // Codex uses :hydra-chat window instead of the root pane.
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

  ensureSurface(info: SessionInfo): boolean { return tmuxHasSession(info.tmuxName) }

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
    if (!tmuxHasSession(info.tmuxName)) return false
    const sockPath = codexSocketPath(info.tmuxName)

    if (info.codexThreadId) {
      try {
        await this.engine.connectAndResume(info.sessionId, sockPath, info.codexThreadId)
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
