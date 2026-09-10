import type { SessionInfo } from '../sessions.js'
import type { ProviderCapabilities, ProviderExecutionRef } from './engine-adapter.js'
import { getContextPercent, tmuxHasSession } from '../util.js'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { CLAUDE_CONFIG, SOCK_PATH, PLATFORM, STATE_DIR } from '../config.js'
import { withRaisedFdLimit } from '../../shared/tmux-env.js'
import type { EngineAdapter, EngineSpawnInput, EngineSpawnResult } from './engine-adapter.js'

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
const SPAWN_LOGS_DIR = join(STATE_DIR, 'spawn-logs')

export type ClaudeLaunchIo = Pick<typeof import('child_process'), 'execFileSync'> & {
  mkdirSync: typeof mkdirSync
  randomUUID: typeof randomUUID
}

function buildSpawnEnv(sessionId: string, tmuxName: string): string[] {
  return [
    `export HYDRA_SESSION_ID=${shq(sessionId)}`,
    `export HYDRA_SESSION_NAME=${shq(tmuxName)}`,
    `export DAEMON_SOCK=${shq(SOCK_PATH)}`,
    `export CLAUDE_CONFIG_DIR=${shq(CLAUDE_CONFIG)}`,
    `export CHAT_PLATFORM=${shq(PLATFORM)}`,
    `unset HYDRA_ROLE`, // prevent spawned session from inheriting byte's HYDRA_ROLE=main
  ]
}

export function resolveForkSpawnCwd(
  isFork: boolean,
  hasWorktree: boolean,
  spawnCwd: string,
  effectiveCwd: string,
): string {
  return (isFork && hasWorktree) ? spawnCwd : effectiveCwd
}

/**
 * Append worktree location to the prompt for fork+worktree builders.
 * The builder starts from spawnCwd (for --resume CWD compatibility), so it
 * needs an explicit path to cd into. Returns '' for all other spawn forms.
 */
export function buildWorktreePromptAppend(isFork: boolean, worktreePath: string | undefined): string {
  if (isFork && worktreePath) {
    return `\n\nWORKTREE: Your isolated worktree is at ${worktreePath}. cd there before making any code changes.`
  }
  return ''
}

export class ClaudeAdapter implements EngineAdapter<'claude'> {
  readonly id = 'claude' as const
  constructor(private readonly io: ClaudeLaunchIo = { execFileSync, mkdirSync, randomUUID }) {}

  readonly capabilities: ProviderCapabilities = {
    nativeFork: true, nativeResume: true, steerDuringTurn: false, dynamicTools: true,
    structuredUsage: false, interactiveTui: true, paneProbe: true, queueKeysWhileWorking: false,
  }

  uiTarget(info: Pick<SessionInfo, 'tmuxName'>): string { return info.tmuxName }
  ensureInteractiveSurface(info: SessionInfo): boolean { return tmuxHasSession(info.tmuxName) }
  contextPercent(info: SessionInfo): string { return getContextPercent(info.tmuxName) }
  executionRef(info: SessionInfo): ProviderExecutionRef { return { provider: 'claude', sessionId: info.sessionId } }
  async interruptExecution(_ref: ProviderExecutionRef): Promise<boolean> { return false }
  async isAlive(info: SessionInfo): Promise<boolean> { return tmuxHasSession(info.tmuxName) }
  async stop(info: SessionInfo): Promise<void> {
    try { this.io.execFileSync('tmux', ['kill-session', '-t', info.tmuxName], { stdio: 'pipe' }) }
    catch {
      // A missing session is already terminal; other failures retain ownership.
      try { this.io.execFileSync('tmux', ['has-session', '-t', info.tmuxName], { stdio: 'pipe' }) }
      catch { return }
      throw new Error(`Claude session ${info.tmuxName} is still running`)
    }
  }

  async spawn(input: EngineSpawnInput<'claude'>): Promise<EngineSpawnResult<'claude'>> {
    const { sessionId, tmuxName, prompt: initialPrompt, model } = input
    let prompt = initialPrompt
    const effectiveCwd = input.cwd
    const spawnCwd = input.originalCwd
    const worktreePath = input.worktreePath
    const worktreeTarget = !!input.forkFromOriginalCwd
    const isFork = input.mode.kind === 'fork'
    const isResume = input.mode.kind === 'resume'
    const opts = {
      forkFrom: input.mode.kind === 'fork' ? { claudeSessionId: input.mode.source.sessionId } : undefined,
      resumeFrom: input.mode.kind === 'resume' ? input.mode.source.sessionId : undefined,
      tools: input.tools,
      disallowedTools: input.disallowedTools,
    }
    const channelFlag = 'plugin:discord@claude-plugins-official'
    // For fork+worktree: tell the builder its exact worktree path via the prompt.
    // (The process starts from spawnCwd for --resume CWD compatibility, so the
    // builder can't infer its worktree from $PWD.)
    const worktreeAppend = buildWorktreePromptAppend(isFork, worktreePath)
    if (worktreeAppend) prompt += worktreeAppend

    // Build claude command — fork adds --resume --fork-session, resume uses --resume without fork
    let claudeArgs: string
    let assignedClaudeSessionId: string | undefined
    if (isFork) {
      claudeArgs = [
        `claude`,
        `--resume ${shq(opts!.forkFrom!.claudeSessionId!)}`,
        `--fork-session`,
        `--model ${shq(model)}`,
        `--channels ${shq(channelFlag)}`,
        `--dangerously-skip-permissions`,
        shq(prompt),
      ].join(' ')
    } else if (isResume) {
      claudeArgs = [
        `claude`,
        `--resume ${shq(opts!.resumeFrom!)}`,
        `--model ${shq(model)}`,
        `--channels ${shq(channelFlag)}`,
        `--dangerously-skip-permissions`,
      ].join(' ')
    } else {
      assignedClaudeSessionId = this.io.randomUUID()
      const disallowed = opts?.disallowedTools?.length ? ` --disallowedTools ${shq(opts.disallowedTools.join(','))}` : ''
      const toolsFlag = opts?.tools?.length ? ` --tools ${shq(opts.tools.join(','))}` : ''
      claudeArgs = `claude --session-id ${shq(assignedClaudeSessionId)} --model ${shq(model)} --channels ${shq(channelFlag)} --dangerously-skip-permissions ${shq(prompt)}${disallowed}${toolsFlag}`
      if (disallowed) process.stderr.write(`daemon: disallowedTools flag: ${disallowed}\n`)
      if (toolsFlag) process.stderr.write(`daemon: tools whitelist active (${opts!.tools!.length} tools, Edit/Write blocked)\n`)
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

    this.io.mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
    try {
      this.io.execFileSync('tmux', ['new-session', '-d', '-s', tmuxName, withRaisedFdLimit(inner)], { stdio: 'pipe' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`daemon: spawn ${tmuxName}: execFileSync FAILED: ${msg}\n`)
      throw new Error(`failed to spawn tmux session: ${msg}`)
    }

    // Verify the tmux session actually exists after creation
    let tmuxConfirmedAlive = false
    try {
      this.io.execFileSync('tmux', ['has-session', '-t', tmuxName], { stdio: 'pipe' })
      process.stderr.write(`daemon: spawn ${tmuxName}: tmux session confirmed alive\n`)
      tmuxConfirmedAlive = true
    } catch {
      process.stderr.write(`daemon: spawn ${tmuxName}: WARNING -- tmux session died immediately after creation\n`)
    }


    // Best-effort: any failure is logged, never fatal to the spawn.
    let spawnLogPath: string | undefined
    if (tmuxConfirmedAlive) {
      try {
        // 0o700: the spawn logs are sensitive by construction (raw pane output).
        // Assert it at the artifact, not only via STATE_DIR's mode.
        this.io.mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
        const logPath = join(SPAWN_LOGS_DIR, `${tmuxName}-${sessionId}.log`)
        // Shell string is unavoidable here — `pipe-pane` runs its argument through a
        // shell, so it can't be array-form execFileSync; the path is shq-quoted.
        this.io.execFileSync('tmux', ['pipe-pane', '-o', '-t', tmuxName, `cat >> ${shq(logPath)}`], { stdio: 'pipe' })
        spawnLogPath = logPath
        process.stderr.write(`daemon: spawn ${tmuxName}: pane capture -> ${logPath}\n`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`daemon: spawn ${tmuxName}: pipe-pane capture setup FAILED (non-fatal): ${msg}\n`)
      }
    }

    return {
      provider: 'claude', model,
      ...(assignedClaudeSessionId ? { nativeIdentity: { provider: 'claude', sessionId: assignedClaudeSessionId } } : {}),
      spawnLogPath, exitFilePath: exitFile, stderrLogPath: stderrLog, debugLogPath: debugLog,
    }
  }
}
