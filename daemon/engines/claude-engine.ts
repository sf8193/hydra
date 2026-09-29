// daemon/engines/claude-engine.ts
//
// Claude engine adapter — wraps tmux + bridge socket communication.

import { randomUUID } from 'crypto'
import { execFileSync, execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { SessionInfo } from '../sessions.js'
import { detectBlockingState as detectBlockingStateFn } from '../pane-probe.js'
import type { BlockingState } from '../pane-probe.js'
import type {
  EngineAdapter, LaunchInput, LaunchResult,
  DeliveryResult, Notification,
  StopResult,
  ContextUsage, RecoverySource, RecoveryPlan, Turn, UsageReading, UsageSubject,
} from './engine-adapter.js'
import { withoutIntents } from './engine-adapter.js'
import type { BridgeTransport } from '../bridge-transport.js'
import { parseContextPercent, tmuxHasSession, tmuxWindowActivity } from '../util.js'
import { claudeConfigDir, contextWindowOf, isKnownModel } from '../../shared/constants.js'
import { drainUsage, lastContextTokens, newCursor, projectDirName, projectsRoot, transcriptPathFor, type UsageCursor } from '../usage.js'
import { claudeTurnOutcome } from './claude-transcript.js'
import { readClaudeStatus } from './claude-status.js'
import { defaultTurnSources } from './codex-observation.js'
import { CLAUDE_CONFIG, SOCK_PATH, PLATFORM, STATE_DIR } from '../config.js'
import { gateway } from '../config.js'
import { tmuxNewSession, withRaisedFdLimit } from '../../shared/spawn-env.js'

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

// ---------------------------------------------------------------------------
// Claude session ID discovery
// ---------------------------------------------------------------------------

export function discoverClaudeSessionId(tmuxName: string): string | null {
  try {
    const panePid = execFileSync('tmux', ['list-panes', '-t', tmuxName, '-F', '#{pane_pid}'], { encoding: 'utf8', timeout: 2000 }).toString().trim()
    if (!panePid) return null

    // Primary: read Claude's session file at $CLAUDE_CONFIG_DIR/sessions/<pid>.json
    const sessionFile = join(claudeConfigDir(), 'sessions', `${panePid}.json`)
    try {
      const data = JSON.parse(readFileSync(sessionFile, 'utf8'))
      if (data.sessionId && data.cwd) {
        // Verify the conversation file exists (Claude creates .jsonl lazily —
        // freshly spawned sessions may not have one yet).
        // NOTE: For fork+worktree builders, data.cwd reflects Claude's launch CWD
        // (spawnCwd, e.g. /Users/sam/trading), not the worktree the builder later
        // `cd`s to via Bash. Claude's session file captures the startup CWD and does
        // not update on shell cd — so the conversation file will be found correctly.
        const projectDir = join(projectsRoot(), projectDirName(data.cwd))
        const conversationFile = join(projectDir, `${data.sessionId}.jsonl`)
        if (existsSync(conversationFile)) return data.sessionId
      }
    } catch {}

    // Fallback (Claude is a child of the pane's shell, so no <panePid>.json): the status file that names this tmux session.
    return readClaudeStatus(tmuxName)?.sessionId ?? null
  } catch {
    return null
  }
}

// The pane's `ctx:` number is cross-checked against the transcript at most this often per session.
const CONTEXT_CHECK_EVERY_MS = 10 * 60_000
const lastContextCheckAt = new Map<string, number>()

// ponytail: a genuinely silent Claude turn longer than this (no spinner repaint) reads not-working.
export const CLAUDE_WORKING_SILENCE_S = 10 * 60

export class ClaudeEngine implements EngineAdapter {
  readonly provider = 'claude' as const
  readonly channel = 'bridge' as const
  constructor(private readonly transport: BridgeTransport) {}

  // Resume relaunches with --resume and is confirmed when the bridge registers.
  recoveryPlan(s: RecoverySource, opts?: { discover?: boolean }): RecoveryPlan {
    const learnedId = opts?.discover ? this.discover(s) : null
    const id = s.claudeSessionId
    const plan: RecoveryPlan = id
      ? { generic: true, resume: { kind: 'await-bridge', resumeFrom: id }, fork: { claudeSessionId: id, parentName: s.tmuxName } }
      : { generic: true, resume: null, fork: null }
    return learnedId ? { learnedId, ...plan } : plan
  }

  // Learn a missing claudeSessionId from the running pane and set it on the record.
  private discover(s: RecoverySource): string | null {
    if (s.claudeSessionId) return null
    const discovered = discoverClaudeSessionId(s.tmuxName)
    if (discovered) s.claudeSessionId = discovered
    return discovered
  }

  isConnected(info: SessionInfo): boolean {
    return this.transport.bridges.has(info.sessionId)
  }

  turn(info: SessionInfo, sinceMs: number): Turn {
    const outcome = claudeTurnOutcome(info, sinceMs, defaultTurnSources)
    return {
      get confirmedComplete() { return outcome.confirmedComplete }, answer: outcome.answer,
      get activityAt() { try { return tmuxWindowActivity(info.tmuxName) } catch { return null } },
      get live() { return outcome.live },
      // A live turn keeps its spinner moving; a hung one (API retry loop, stuck tool) goes silent while the
      // status file still says busy, so isSessionWorking bounds the claim by pane activity.
      workingSilenceLimitS: CLAUDE_WORKING_SILENCE_S,
    }
  }

  async start(_records: readonly SessionInfo[]): Promise<void> {}

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

    process.stderr.write(`daemon: spawn ${tmuxName}: creating the tmux session\n`)
    process.stderr.write(`daemon: spawn ${tmuxName}: inner cmd = ${inner.slice(0, 300)}...\n`)

    mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
    try {
      tmuxNewSession(['-d', '-s', tmuxName, withRaisedFdLimit(inner)])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`daemon: spawn ${tmuxName}: tmuxNewSession FAILED: ${msg}\n`)
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
      identity: assignedClaudeSessionId ? { claudeSessionId: assignedClaudeSessionId } : {},
      spawnLogPath, exitFilePath: exitFile, stderrLogPath: stderrLog, debugLogPath: debugLog,
    }
  }

  // No await before the write: callers rely on it having happened on return.
  async deliver(info: SessionInfo, msg: Notification): Promise<DeliveryResult> {
    const r = this.transport.writeOrQueue(info.sessionId, withoutIntents(msg))
    return r === 'written' ? { status: 'accepted', via: 'bridge-socket' }
      : r === 'queued' ? { status: 'accepted', via: 'queued' }
      // sendToBridge re-queued it; the queue flushes on reconnect, as when absent.
      // Not 'unknown': that would surface a delivery:failed warning (#378) for
      // a message the transport still owns.
      : { status: 'accepted', via: 'requeued' }
  }

  async stop(info: SessionInfo): Promise<StopResult> {
    // Last-resort claudeSessionId discovery before tmux dies — if the bridge
    // never registered it, read $CLAUDE_CONFIG_DIR/sessions/<panePid>.json while the
    // pane PID is still available. Without this, resume falls to tier 3 (respawn).
    const discovered = this.discover(info)
    if (discovered) process.stderr.write(`daemon: kill ${info.tmuxName}: late-discovered claudeSessionId=${discovered}\n`)
    try {
      execFileSync('tmux', ['kill-session', '-t', info.tmuxName], { stdio: 'pipe' })
      return { status: 'stopped' }
    } catch {
      if (!tmuxHasSession(info.tmuxName)) return { status: 'stopped' }
      return { status: 'uncertain', reason: `tmux session ${info.tmuxName} is still running` }
    }
  }

  isAlive(info: SessionInfo): boolean {
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

  // From the transcript: the last turn's context tokens over the window the session was launched with. The id comes
  // from the status file (a /clear starts a new transcript; the stored id goes stale). The pane's `ctx:` number is
  // the fallback (unknown model, no transcript yet) and is cross-checked, at most every CONTEXT_CHECK_EVERY_MS.
  usage(info: SessionInfo): ContextUsage | null {
    const window = contextWindowOf(info.sessionMetadata?.model)
    const path = window ? transcriptPathFor(readClaudeStatus(info.tmuxName)?.sessionId ?? info.claudeSessionId) : undefined
    const used = path ? lastContextTokens(path) : null
    if (!window || used === null) {
      const pane = this.panePercent(info)
      return pane === null ? null : { usedTokens: 0, contextWindow: 0, percent: pane }
    }
    const percent = Math.min(100, Math.round(used * 100 / window))
    const now = Date.now()
    if (now - (lastContextCheckAt.get(info.tmuxName) ?? 0) >= CONTEXT_CHECK_EVERY_MS) {
      lastContextCheckAt.set(info.tmuxName, now)
      const pane = this.panePercent(info)
      if (pane !== null && Math.abs(pane - percent) >= 2) {
        process.stderr.write(`daemon: context %: ${info.tmuxName} transcript says ${percent}% (${used}/${window}), pane says ${pane}%\n`)
      }
    }
    return { usedTokens: used, contextWindow: window, percent }
  }

  private panePercent(info: SessionInfo): number | null {
    try {
      const pane = execFileSync('tmux', ['capture-pane', '-t', info.tmuxName, '-p'],
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: 2000 }).toString()
      return parseContextPercent(pane)
    } catch { return null }
  }

  // Reads only the four token counters out of the transcript; see daemon/usage.ts.
  // A drain that can't stat the file throws: a transcript that quietly stops being
  // readable would otherwise report zero forever.
  usageTotals(info: UsageSubject, prev: unknown): UsageReading | null {
    const transcript = transcriptPathFor(info.claudeSessionId)
    if (!transcript) return null
    const next = drainUsage(transcript, (prev as UsageCursor | undefined) ?? newCursor())
    return {
      totals: { ...next.totals }, providerSessionId: info.claudeSessionId!, cursor: next,
      restarted: next.restartedFromZero === true,
      phases: { totals: next.phaseTotals, current: next.latch, voted: next.voted },
    }
  }

  surface(info: SessionInfo): string | null { return tmuxHasSession(info.tmuxName) ? info.tmuxName : null }

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
