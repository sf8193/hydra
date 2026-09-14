// daemon/engines/claude-engine.ts
//
// Claude engine adapter — wraps tmux + bridge socket communication.

import { randomUUID } from 'crypto'
import { execFileSync, execSync } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { SessionInfo } from '../sessions.js'
import { detectBlockingState as detectBlockingStateFn } from '../pane-probe.js'
import type { BlockingState } from '../pane-probe.js'
import type {
  EngineAdapter, LaunchInput, LaunchResult,
  DeliveryMode, DeliveryResult,
  ExecutionRetirementResult, StopResult,
  ContextUsage, EngineSnapshot,
} from './engine-adapter.js'
import { transport } from '../bridge-transport.js'
import { tmuxHasSession } from '../util.js'
import { isKnownModel } from '../../shared/constants.js'
import { CLAUDE_CONFIG, SOCK_PATH, PLATFORM, STATE_DIR } from '../config.js'
import { gateway } from '../config.js'
import { withRaisedFdLimit } from '../../shared/tmux-env.js'

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
const SPAWN_LOGS_DIR = join(STATE_DIR, 'spawn-logs')

function buildSpawnEnv(sessionId: string, tmuxName: string): string[] {
  return [
    `export HYDRA_SESSION_ID=${shq(sessionId)}`,
    `export HYDRA_SESSION_NAME=${shq(tmuxName)}`,
    `export DAEMON_SOCK=${shq(SOCK_PATH)}`,
    `export CLAUDE_CONFIG_DIR=${shq(CLAUDE_CONFIG)}`,
    `export CHAT_PLATFORM=${shq(PLATFORM)}`,
    `unset HYDRA_ROLE`,
  ]
}

export function resolveForkSpawnCwd(isFork: boolean, hasWorktree: boolean, spawnCwd: string, effectiveCwd: string): string {
  return (isFork && hasWorktree) ? spawnCwd : effectiveCwd
}

export function buildWorktreePromptAppend(isFork: boolean, worktreePath: string | undefined): string {
  if (isFork && worktreePath) {
    return `\n\nWORKTREE: Your isolated worktree is at ${worktreePath}. cd there before making any code changes.`
  }
  return ''
}

export class ClaudeEngine implements EngineAdapter {
  readonly provider = 'claude' as const

  async launch(input: LaunchInput): Promise<LaunchResult> {
    const { sessionId, tmuxName, model } = input
    const effectiveCwd = input.cwd
    const spawnCwd = input.originalCwd
    const worktreePath = input.worktreePath
    const worktreeTarget = !!input.forkFromOriginalCwd
    const isFork = !!input.forkFrom?.claudeSessionId
    const isResume = !!input.resumeFrom

    if (!isKnownModel(model)) {
      process.stderr.write(`daemon: unrecognized model ${model} — may be a new release or typo. Spawning anyway.\n`)
      if (input.threadId) void gateway.send(input.threadId, `⚠️ Unrecognized model \`${model}\` — may be a new release or typo. Spawning anyway.`).catch(() => {})
    }

    let prompt = input.prompt
    const worktreeAppend = buildWorktreePromptAppend(isFork, worktreePath)
    if (worktreeAppend) prompt += worktreeAppend

    const channelFlag = 'plugin:discord@claude-plugins-official'
    let claudeArgs: string
    let assignedClaudeSessionId: string | undefined
    if (isFork) {
      claudeArgs = [
        `claude`,
        `--resume ${shq(input.forkFrom!.claudeSessionId!)}`,
        `--fork-session`,
        `--model ${shq(model)}`,
        `--channels ${shq(channelFlag)}`,
        `--dangerously-skip-permissions`,
        shq(prompt),
      ].join(' ')
    } else if (isResume) {
      claudeArgs = [
        `claude`,
        `--resume ${shq(input.resumeFrom!)}`,
        `--model ${shq(model)}`,
        `--channels ${shq(channelFlag)}`,
        `--dangerously-skip-permissions`,
      ].join(' ')
    } else {
      assignedClaudeSessionId = randomUUID()
      const disallowed = input.disallowedTools?.length ? ` --disallowedTools ${shq(input.disallowedTools.join(','))}` : ''
      const toolsFlag = input.tools?.length ? ` --tools ${shq(input.tools.join(','))}` : ''
      claudeArgs = `claude --session-id ${shq(assignedClaudeSessionId)} --model ${shq(model)} --channels ${shq(channelFlag)} --dangerously-skip-permissions ${shq(prompt)}${disallowed}${toolsFlag}`
      if (disallowed) process.stderr.write(`daemon: disallowedTools flag: ${disallowed}\n`)
      if (toolsFlag) process.stderr.write(`daemon: tools whitelist active (${input.tools!.length} tools, Edit/Write blocked)\n`)
    }

    const stderrLog = join(SPAWN_LOGS_DIR, `stderr-${tmuxName}-${sessionId}.log`)
    const debugLog = join(SPAWN_LOGS_DIR, `debug-${tmuxName}-${sessionId}.log`)
    const exitFile = join(SPAWN_LOGS_DIR, `exit-${tmuxName}-${sessionId}.log`)
    const writeExitMarker = [
      `_HYDRA_EXIT_CODE=$?`,
      `_HYDRA_EXIT_TS=$(date +%s)`,
      `{ echo "exit_code=$_HYDRA_EXIT_CODE"`,
      `echo "wall_clock=\${SECONDS}s"`,
      `echo "exit_ts=$_HYDRA_EXIT_TS"`,
      `echo "session_id=${sessionId}"`,
      `echo "tmux_name=${tmuxName}"`,
      `if [ $_HYDRA_EXIT_CODE -gt 128 ]; then echo "signal=$(( $_HYDRA_EXIT_CODE - 128 ))"; fi`,
      `} > ${shq(exitFile)}`,
    ].join('; ')
    claudeArgs += ` --debug-file ${shq(debugLog)}`
    const spawnCd = resolveForkSpawnCwd(isFork, !!worktreeTarget, spawnCwd, effectiveCwd)
    if (isFork && worktreeTarget) {
      process.stderr.write(`daemon: spawn ${tmuxName}: fork+worktree — using PM CWD ${spawnCwd} for fork (worktree ${effectiveCwd} in prompt)\n`)
    }
    const inner = [
      `_hydra_write_exit() { ${writeExitMarker}; }; trap _hydra_write_exit EXIT`,
      `cd ${shq(spawnCd)}`,
      ...buildSpawnEnv(sessionId, tmuxName),
      `${claudeArgs} 2>>${shq(stderrLog)}`,
    ].join(' && ')

    process.stderr.write(`daemon: spawn ${tmuxName}: running tmux new-session\n`)
    process.stderr.write(`daemon: spawn ${tmuxName}: inner cmd = ${inner.slice(0, 300)}...\n`)

    mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
    try {
      execFileSync('tmux', ['new-session', '-d', '-s', tmuxName, withRaisedFdLimit(inner)], { stdio: 'pipe' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`daemon: spawn ${tmuxName}: execFileSync FAILED: ${msg}\n`)
      throw new Error(`failed to spawn tmux session: ${msg}`)
    }

    let tmuxConfirmedAlive = false
    try {
      execFileSync('tmux', ['has-session', '-t', tmuxName], { stdio: 'pipe' })
      process.stderr.write(`daemon: spawn ${tmuxName}: tmux session confirmed alive\n`)
      tmuxConfirmedAlive = true
    } catch {
      process.stderr.write(`daemon: spawn ${tmuxName}: WARNING -- tmux session died immediately after creation\n`)
    }

    let spawnLogPath: string | undefined
    if (tmuxConfirmedAlive) {
      try {
        mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
        const logPath = join(SPAWN_LOGS_DIR, `${tmuxName}-${sessionId}.log`)
        execFileSync('tmux', ['pipe-pane', '-o', '-t', tmuxName, `cat >> ${shq(logPath)}`], { stdio: 'pipe' })
        spawnLogPath = logPath
        process.stderr.write(`daemon: spawn ${tmuxName}: pane capture -> ${logPath}\n`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`daemon: spawn ${tmuxName}: pipe-pane capture setup FAILED (non-fatal): ${msg}\n`)
      }
    }

    return {
      provider: 'claude', model,
      claudeSessionId: assignedClaudeSessionId,
      spawnLogPath, exitFilePath: exitFile, stderrLogPath: stderrLog, debugLogPath: debugLog,
    }
  }

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

  async sendKeys(info: SessionInfo, keys: string, opts?: { raw?: boolean; trailingKey?: string }): Promise<{ queued: boolean }> {
    if (opts?.raw) {
      execFileSync('tmux', ['send-keys', '-t', info.tmuxName, ...keys.split(/\s+/)], { timeout: 3000 })
    } else {
      execFileSync('tmux', ['send-keys', '-t', info.tmuxName, '-l', keys], { timeout: 3000 })
      execFileSync('tmux', ['send-keys', '-t', info.tmuxName, opts?.trailingKey ?? 'Enter'], { timeout: 3000 })
    }
    return { queued: false }
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
