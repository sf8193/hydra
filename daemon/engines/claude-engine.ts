// daemon/engines/claude-engine.ts
//
// Claude engine adapter — wraps tmux + bridge socket communication.

import { execFileSync, execSync } from 'child_process'
import type { SessionInfo } from '../sessions.js'
import { detectBlockingState as detectBlockingStateFn } from '../pane-probe.js'
import type { BlockingState } from '../pane-probe.js'
import type {
  EngineAdapter,
  DeliveryMode, DeliveryResult,
  ExecutionRetirementResult, StopResult,
  ContextUsage, EngineSnapshot,
} from './engine-adapter.js'
import { transport } from '../bridge-transport.js'
import { tmuxHasSession } from '../util.js'

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

export class ClaudeEngine implements EngineAdapter {
  readonly provider = 'claude' as const

  async deliver(info: SessionInfo, text: string, _mode?: DeliveryMode, meta?: Record<string, string>): Promise<DeliveryResult> {
    const msg: Record<string, unknown> = {
      type: 'notification',
      content: text,
      meta: { chat_id: info.threadId, message_id: '', user: 'system', user_id: 'system', ts: new Date().toISOString(), ...meta },
    }
    const bridge = transport.get(info.sessionId)
    if (bridge) {
      const ok = transport.sendToBridge(bridge, msg)
      return ok
        ? { status: 'accepted', via: 'bridge-socket' }
        : { status: 'unknown', reason: 'bridge write failed, message queued' }
    }
    transport.sendOrQueue(info.sessionId, msg)
    return { status: 'accepted', via: 'queued' }
  }

  async retire(_info: SessionInfo, _reason: string): Promise<ExecutionRetirementResult> {
    return { status: 'unknown', reason: 'Claude has no native retirement mechanism' }
  }

  async stop(info: SessionInfo): Promise<StopResult> {
    try {
      execFileSync('tmux', ['kill-session', '-t', info.tmuxName], { stdio: 'pipe' })
      return { status: 'stopped' }
    } catch {
      if (!tmuxHasSession(info.tmuxName)) return { status: 'stopped' }
      return { status: 'uncertain', reason: `tmux session ${info.tmuxName} is still running` }
    }
  }

  async isAlive(info: SessionInfo): Promise<boolean> {
    return tmuxHasSession(info.tmuxName)
  }

  peek(info: SessionInfo, lines: number = 50): string {
    try {
      return execSync(
        `tmux capture-pane -t ${shq(info.tmuxName)} -p -S -${lines}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 },
      ).trimEnd()
    } catch { return '' }
  }

  usage(info: SessionInfo): ContextUsage | null {
    try {
      const pane = execFileSync('tmux', ['capture-pane', '-t', info.tmuxName, '-p', '-S', '-3'],
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 }).toString()
      const tail = pane.trimEnd()
      const match = tail.match(/(\d+)%/)
      if (!match) return null
      const percent = parseInt(match[1], 10)
      return { usedTokens: 0, contextWindow: 0, percent }
    } catch { return null }
  }

  async status(info: SessionInfo): Promise<EngineSnapshot> {
    const alive = tmuxHasSession(info.tmuxName)
    const connected = transport.has(info.sessionId)
    const ctx = this.usage(info)
    return {
      provider: 'claude',
      execution: alive ? (info.deadAt ? 'dead' : 'running') : 'dead',
      connection: connected ? 'connected' : 'disconnected',
      surface: alive ? 'present' : 'absent',
      context: ctx,
      turnActive: info.turnState === 'working',
    }
  }

  uiTarget(info: SessionInfo): string { return info.tmuxName }

  ensureSurface(info: SessionInfo): boolean { return tmuxHasSession(info.tmuxName) }

  async sendKeys(info: SessionInfo, keys: string): Promise<void> {
    execFileSync('tmux', ['send-keys', '-t', info.tmuxName, '-l', keys], { timeout: 3000 })
    execFileSync('tmux', ['send-keys', '-t', info.tmuxName, 'Enter'], { timeout: 3000 })
  }

  async interrupt(info: SessionInfo): Promise<void> {
    Bun.spawn(['tmux', 'send-keys', '-t', info.tmuxName, 'Escape'], { stdio: ['pipe', 'pipe', 'pipe'] })
  }

  detectBlockingState(_info: SessionInfo, tailText: string): BlockingState | null {
    return detectBlockingStateFn(tailText)
  }

  async reconnect(_info: SessionInfo): Promise<boolean> {
    // Claude's bridge self-reconnects via scheduleReconnect() — daemon accepts passively
    return true
  }
}
