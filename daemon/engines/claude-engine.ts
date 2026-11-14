// daemon/engines/claude-engine.ts
//
// Claude engine adapter — wraps tmux + bridge socket communication.

import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { SessionInfo, SessionMetadata } from '../sessions.js'
import { detectBlockingState as detectBlockingStateFn } from '../pane-probe.js'
import type { BlockingState } from '../pane-probe.js'
import type {
  EngineAdapter, ForkPlan, LaunchInput, LaunchResult,
  DeliveryResult, Notification,
  StopResult,
  ContextUsage, RecoverySource, RecoveryPlan, Turn, UsageReading, UsageSubject,
} from './engine-adapter.js'
import { withoutIntents } from './engine-adapter.js'
import type { BridgeTransport } from '../bridge-transport.js'
import { parseContextFooter, type ContextFooter } from '../util.js'
import { tmuxCreateSession, tmuxHasSession, tmuxSessionState, tmuxSync, tmuxTimedOut, tmuxWindowActivity } from '../tmux.js'
import { claudeConfigDir, contextWindowOf, isKnownModel } from '../../shared/constants.js'
import { drainSession, lastContextTokens, newSessionCursor, projectDirName, projectsRoot, transcriptPathFor, type SessionCursor } from '../usage.js'
import { claudeTurnOutcome } from './claude-transcript.js'
import { readClaudeStatus } from './claude-status.js'
import { defaultTurnSources } from './codex-observation.js'
import { CLAUDE_CONFIG, ENV_FILE, SOCK_PATH, PLATFORM, STATE_DIR } from '../config.js'
import { gateway } from '../config.js'
import { SESSION_IDENTITY_VARS, capturedSpawnVars, scrubbedSpawnEnv, withRaisedFdLimit } from '../../shared/spawn-env.js'
import { modsExport } from '../../shared/mods.js'
import { BRIDGE_CHANNEL_FLAG, BRIDGE_MCP_SERVER_KEY, BRIDGE_PLUGIN_ID, BRIDGE_TOOLS_PERMISSION } from '../plugin-manifest.js'
import { confined, deliveryRefusal, missingTokenRefusal, PolicyRefusal, remedy, SCOPED_MODS, SCOPED_PREAMBLE, sandboxInputs, serverToolRule, type ConfinedPolicy } from '../scope.js'
import { verifyLaunch as verifyLoaded, type Verdict } from './claude-verify.js'
import { ENGINE_CAPABILITIES } from '../../shared/engine-capabilities.js'
import { makeServerTmpDirs, removeScopedFiles, serverTmpDir, serverTmpRoot, writeScopedFiles } from '../scoped-files.js'
import { sandboxedServer, sandboxIssues } from '../../config/server-sandbox.js'
import type { PrivateRoot } from '../../config/workdir-scope.js'
import type { LoadEnv } from '../../config/types.js'
import { clearNeedsAuthEntry, describeSetAt, NEEDS_AUTH_CLEARED_NOTE } from './claude-needs-auth.js'

// What the pane-and-transcript methods read. The byte (main) has no SessionInfo, so these take only this.
export type ClaudeSubject = Pick<SessionInfo, 'tmuxName'> & Partial<Pick<SessionInfo, 'claudeSessionId'>>
  & { sessionMetadata?: Pick<SessionMetadata, 'model'> }

const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
const SPAWN_LOGS_DIR = join(STATE_DIR, 'spawn-logs')

/**
 * What a scoped launch writes and passes: the settings (the bridge plugin on, and the only tool permissions: the bridge's
 * and each listed server tool), and the MCP config (the listed servers, each with the `token_env` variables and nothing
 * else of the daemon's environment). Written by scoped-files.ts: mode 0600, since the MCP config holds secrets.
 */
export type ScopedConfigInput = {
  scope: Pick<ConfinedPolicy, 'specialist' | 'servers' | 'tools'>
  /** The variables a server's `token_env` may take (the daemon's environment) and the ones its scrub held back. */
  env: NodeJS.ProcessEnv
  held: Readonly<Record<string, string>>
  sessionName: string
  /** The sandbox: the machine's probes, the places off limits, and each server's one writable folder. All injected, none read here. */
  load: Pick<LoadEnv, 'isCommand' | 'realpath'>
  roots: readonly PrivateRoot[]
  /** The folder every scoped server's folder sits in, and one server's own folder in it. */
  tmpRoot: string
  tmp: (server: string) => string
}

export function scopedConfig({ scope, env, held, sessionName, load, roots, tmpRoot, tmp }: ScopedConfigInput): { settings: object; mcp: object } {
  // Listed servers run under sandbox-exec (config/server-sandbox.ts): where that cannot be set up none starts, and the launch says why.
  // The same check hydra.toml's load makes; both run in the daemon. A failure while building a profile (the temp path) is a refusal too.
  const refuse = (why: string): never => { throw new PolicyRefusal(`specialist ${scope.specialist}: ${why}. No session starts until that is fixed; after you fix it, ${remedy(sessionName)}`) }
  const why = scope.servers.length ? sandboxIssues(load.isCommand, roots) : undefined
  if (why) refuse(why)
  const sandboxed = (command: string, dir: string) => {
    try { return sandboxedServer(command, load, roots, { root: tmpRoot, dir }) } catch (err) { return refuse(err instanceof Error ? err.message : String(err)) }
  }
  return {
    settings: {
      enabledPlugins: { [BRIDGE_PLUGIN_ID]: true },
      permissions: { allow: [BRIDGE_TOOLS_PERMISSION, ...scope.servers.flatMap(s => s.tools.map(t => serverToolRule(s.name, t)))] },
    },
    mcp: {
      mcpServers: Object.fromEntries(scope.servers.map(s => [s.name, {
        type: 'stdio', ...sandboxed(s.command, tmp(s.name)),
        env: {
          ...Object.fromEntries(s.tokenEnv.map(v => {
            const value = env[v] ?? held[v]
            if (value === undefined) throw new PolicyRefusal(missingTokenRefusal({ specialist: scope.specialist, servers: [s] } as ConfinedPolicy, ENV_FILE, sessionName, env, held)!)
            return [v, value]
          })),
          // The one place the server may write is its own folder: npm's cache and the temp dir are put in it, never in ~/.npm (which a server could poison for the operator's other npx runs).
          npm_config_cache: join(tmp(s.name), 'npm-cache'),
          TMPDIR: tmp(s.name),
        },
      }])),
    },
  }
}

/** Writes this launch's settings and MCP config (scoped-files.ts); returns their paths. */
function writeScopedConfig(scope: ConfinedPolicy, tmuxName: string, sessionId: string): { settings: string; mcp: string } {
  // Made first: Seatbelt matches resolved paths, which the profile can only name once the folders exist.
  try { makeServerTmpDirs(tmuxName, sessionId, scope.servers.map(s => s.name)) } catch (err) {
    throw new PolicyRefusal(`specialist ${scope.specialist}: ${err instanceof Error ? err.message : String(err)}. No session starts until that is fixed; after you fix it, ${remedy(tmuxName)}`)
  }
  try {
    const { env: load, roots } = sandboxInputs()
    const { settings, mcp } = scopedConfig({ scope, env: process.env, held: capturedSpawnVars(), sessionName: tmuxName, load, roots, tmpRoot: serverTmpRoot(), tmp: server => serverTmpDir(tmuxName, sessionId, server) })
    return writeScopedFiles(tmuxName, sessionId, { settings, mcp })
  } catch (err) {
    removeScopedFiles({ tmuxName, sessionId }, true)   // a refused launch leaves no folder behind
    throw err
  }
}

// Spawn env whitelist: explicit construction, not ambient inheritance. Each env var the byte
// carries gets a conscious routing decision here:
//   pass-through: shared between byte and sessions (platform, socket, config, mods)
//   override:     session-specific identity (thread and type as hookEnv gives them: '' when unknown)
//   strip:        byte-only (HYDRA_ROLE), kept from leaking into sessions
//   lineage:      the Claude session a fork continues, for hooks keyed on Claude's session_id (fresh: unset)
function buildSpawnEnv(input: LaunchInput): string[] {
  const forkedFromClaudeSessionId = input.forkFrom?.claudeSessionId
  return [
    `export HYDRA_SESSION_ID=${shq(input.sessionId)}`,
    `export HYDRA_SESSION_NAME=${shq(input.tmuxName)}`,
    `export HYDRA_THREAD_ID=${shq(input.threadId ?? '')}`,
    `export HYDRA_SESSION_TYPE=${shq(input.sessionType ?? '')}`,
    ...(forkedFromClaudeSessionId ? [`export HYDRA_FORKED_FROM_CLAUDE_SESSION_ID=${shq(forkedFromClaudeSessionId)}`] : []),
    `export DAEMON_SOCK=${shq(SOCK_PATH)}`,
    `export CLAUDE_CONFIG_DIR=${shq(CLAUDE_CONFIG)}`,
    `export CHAT_PLATFORM=${shq(PLATFORM)}`,
    modsExport(STATE_DIR, confined(input.policy, input.tmuxName) ? SCOPED_MODS : undefined),
    // Enabling the bridge plugin by settings would also bring back the account's claude.ai connectors: this keeps them off.
    ...(confined(input.policy, input.tmuxName) ? [`export ENABLE_CLAUDEAI_MCP_SERVERS=false`] : []),
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
    const panePid = tmuxSync(['list-panes', '-t', tmuxName, '-F', '#{pane_pid}']).trim()
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

// ---------------------------------------------------------------------------
// ask_predecessor: a one-shot read-only fork of a finished conversation
// ---------------------------------------------------------------------------

// Read-only by construction, not by instruction: only the read tools exist, in plan mode.
// No MCP servers (plugins' included), so the fork can't register with Hydra; no session
// persistence, so it leaves no transcript. `--` keeps a question starting with '-' from being a flag.
export function askForkArgv(claudeSessionId: string, question: string, model?: string): string[] {
  return [
    '--resume', claudeSessionId, '--fork-session', '--no-session-persistence',
    '--strict-mcp-config', '--permission-mode', 'plan', '--tools', 'Read,Grep,Glob',
    ...(model ? ['--model', model] : []),
    '-p', '--', `${question}\n\nAnswer only; change nothing.`,
  ]
}

// The fork must not look like any Hydra session: no identity or daemon socket to register with.
export function askForkEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = scrubbedSpawnEnv(base)
  for (const v of [...SESSION_IDENTITY_VARS, 'HYDRA_ROLE', 'DAEMON_SOCK', 'TMUX', 'TMUX_PANE']) delete env[v]
  return { ...env, CLAUDE_CONFIG_DIR: CLAUDE_CONFIG }
}

/** Injectable for tests: the real one runs `claude`, detached so a timeout can kill its whole process group (rg, hooks). */
export const claudeForkProcess = { spawn: (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => spawn('claude', args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], detached: true }) }

const FORK_KILL_GRACE_MS = 5_000
const FORK_OUTPUT_CHARS = 400

function killFork(child: { pid?: number; kill: (sig: NodeJS.Signals) => boolean }, sig: NodeJS.Signals): void {
  try { if (child.pid) { process.kill(-child.pid, sig); return } } catch { /* group already gone: fall through to the pid */ }
  try { child.kill(sig) } catch { /* already exited */ }
}

// Both streams, each from its start (an error's message line comes first; a stack's tail is its deepest frames).
export function forkFailureOutput(stdout: string, stderr: string): string {
  const parts = [['stderr', stderr.trim()], ['stdout', stdout.trim()]].filter(([, t]) => t)
  return parts.length ? parts.map(([name, t]) => `${name}: ${t.length > FORK_OUTPUT_CHARS ? t.slice(0, FORK_OUTPUT_CHARS) + '…' : t}`).join(' | ') : 'no output'
}

function runFork(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  // Otherwise spawn's ENOENT reads as "claude is not installed".
  if (!existsSync(cwd)) return Promise.reject(new Error(`ask_predecessor: the predecessor's directory ${cwd} no longer exists`))
  return new Promise((resolve, reject) => {
    const child = claudeForkProcess.spawn(args, { cwd, env: askForkEnv() })
    let out = '', err = ''
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => { out += d })
    child.stderr?.on('data', (d: string) => { err += d })
    const timer = setTimeout(() => {
      killFork(child, 'SIGTERM')
      // The group, not just claude: its children can outlive it.
      setTimeout(() => killFork(child, 'SIGKILL'), FORK_KILL_GRACE_MS).unref()
      reject(new Error(`ask_predecessor: the fork gave no answer within ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    child.on('error', e => { clearTimeout(timer); reject(new Error(`ask_predecessor: could not run claude: ${e.message}`)) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const answer = out.trim()
      if (code !== 0) reject(new Error(`ask_predecessor: the fork ${signal ? `was killed by ${signal}` : `exited ${code}`}: ${forkFailureOutput(out, err)}`))
      else if (!answer) reject(new Error('ask_predecessor: the fork returned an empty answer'))
      else resolve(answer)
    })
  })
}

// The pane is read for the transcript cross-check at most this often per session; only a `ctx:` footer is compared.
const CONTEXT_CHECK_EVERY_MS = 10 * 60_000
const lastContextCheckAt = new Map<string, number>()

// ponytail: a genuinely silent Claude turn longer than this (no spinner repaint) reads not-working.
export const CLAUDE_WORKING_SILENCE_S = 10 * 60

export class ClaudeEngine implements EngineAdapter {
  readonly provider = 'claude' as const
  readonly channel = 'bridge' as const
  readonly confinesAccess = ENGINE_CAPABILITIES.claude.confinesAccess
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

  askFork(plan: ForkPlan, cwd: string, question: string, timeoutMs: number, model?: string): Promise<string> {
    // Narrows the shared ForkPlan type: Claude's recoveryPlan only yields a fork that has the id.
    if (!plan.claudeSessionId) return Promise.reject(new Error(`ask_predecessor: ${plan.parentName} has no Claude session id to fork`))
    return runFork(askForkArgv(plan.claudeSessionId, question, model), cwd, timeoutMs)
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
      get backgroundWork() { return outcome.backgroundWork },
      // A live turn keeps its spinner moving; a hung one (API retry loop, stuck tool) goes silent while the
      // status file still says busy, so isSessionWorking bounds the claim by pane activity.
      workingSilenceLimitS: CLAUDE_WORKING_SILENCE_S,
    }
  }

  async start(_records: readonly SessionInfo[]): Promise<void> {}

  /** What a confined launch loaded, from its own debug file, against the policy (claude-verify.ts). */
  verifyLaunch(policy: ConfinedPolicy, launched: LaunchResult): Promise<Verdict> { return verifyLoaded(policy, launched.debugLogPath) }

  async launch(input: LaunchInput): Promise<LaunchResult> {
    try {
      return await this.launchSession(input)
    } catch (err) {
      // A confined launch writes a file holding token values before it starts anything; one that fails then has no session record
      // whose kill or death would remove it, so it is removed here.
      if (input.policy?.access === 'workdir') removeScopedFiles({ tmuxName: input.tmuxName, sessionId: input.sessionId })
      throw err
    }
  }

  private async launchSession(input: LaunchInput): Promise<LaunchResult> {
    const { sessionId, tmuxName, model } = input
    // The folder, flags, env and files of a launch come from the launch policy here, whatever cwd the caller passed. A policy that
    // cannot be read refuses (never the operator's account).
    const scoped = confined(input.policy, tmuxName)
    const effectiveCwd = scoped ? scoped.workdir : input.cwd
    const spawnCwd = scoped ? scoped.workdir : input.originalCwd
    const worktreePath = input.worktreePath
    const worktreeTarget = !!input.forkFromOriginalCwd
    const isFork = !!input.forkFrom?.claudeSessionId
    const isResume = !!input.resumeFrom

    if (!isKnownModel(model)) {
      process.stderr.write(`daemon: unrecognized model ${model} — may be a new release or typo. Spawning anyway.\n`)
      if (input.threadId) void gateway.send(input.threadId, `⚠️ Unrecognized model \`${model}\` — may be a new release or typo. Spawning anyway.`).catch(() => {})
    }

    let prompt = input.prompt
    // A scoped kickoff starts with hydra's fixed preamble (scope.ts): a prompt, not a control. Operator and non-specialist kickoffs are untouched.
    if (scoped) prompt = `${SCOPED_PREAMBLE} ${prompt}`
    const worktreeAppend = buildWorktreePromptAppend(isFork, worktreePath)
    if (worktreeAppend) prompt += worktreeAppend

    const channelFlag = BRIDGE_CHANNEL_FLAG
    let claudeArgs: string
    let assignedClaudeSessionId: string | undefined
    const disallowed = input.disallowedTools?.length ? ` --disallowedTools ${shq(input.disallowedTools.join(','))}` : ''
    const toolsFlag = input.tools?.length ? ` --tools ${shq(input.tools.join(','))}` : ''
    if (scoped) {
      // A specialist with access = "workdir": no --dangerously-skip-permissions (--permission-mode dontAsk instead), the
      // prompt positional before the variadic flags, and the generated settings and MCP config (see scopedConfig).
      const files = writeScopedConfig(scoped, tmuxName, sessionId)
      const confinement = ` --restricted --tools ${shq(scoped.tools.join(','))} --settings ${shq(files.settings)} --mcp-config ${shq(files.mcp)} --permission-mode dontAsk`
      if (isFork) {
        claudeArgs = `claude --resume ${shq(input.forkFrom!.claudeSessionId!)} --fork-session --model ${shq(model)} ${shq(prompt)} --channels ${shq(channelFlag)}${confinement}${disallowed}`
      } else if (isResume) {
        claudeArgs = `claude --resume ${shq(input.resumeFrom!)} --model ${shq(model)} --channels ${shq(channelFlag)}${confinement}${disallowed}`
      } else {
        assignedClaudeSessionId = randomUUID()
        claudeArgs = `claude --session-id ${shq(assignedClaudeSessionId)} --model ${shq(model)} ${shq(prompt)} --channels ${shq(channelFlag)}${confinement}${disallowed}`
      }
    } else if (isFork) {
      claudeArgs = [
        `claude`,
        `--resume ${shq(input.forkFrom!.claudeSessionId!)}`,
        `--fork-session`,
        `--model ${shq(model)}`,
        `--channels ${shq(channelFlag)}`,
        `--dangerously-skip-permissions`,
        shq(prompt),
      ].join(' ') + disallowed + toolsFlag
    } else if (isResume) {
      claudeArgs = [
        `claude`,
        `--resume ${shq(input.resumeFrom!)}`,
        `--model ${shq(model)}`,
        `--channels ${shq(channelFlag)}`,
        `--dangerously-skip-permissions`,
      ].join(' ') + disallowed + toolsFlag
    } else {
      assignedClaudeSessionId = randomUUID()
      claudeArgs = `claude --session-id ${shq(assignedClaudeSessionId)} --model ${shq(model)} --channels ${shq(channelFlag)} --dangerously-skip-permissions ${shq(prompt)}${disallowed}${toolsFlag}`
    }
    if (disallowed) process.stderr.write(`daemon: disallowedTools flag: ${disallowed}\n`)
    if (scoped) process.stderr.write(`daemon: scoped launch ${tmuxName}: specialist ${scoped.specialist}, tools ${scoped.tools.join(',')}, servers ${scoped.servers.map(x => x.name).join(',') || 'none'}\n`)
    if (toolsFlag && !scoped) process.stderr.write(`daemon: tools whitelist active (${input.tools!.length} tools, Edit/Write blocked)\n`)

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
      ...buildSpawnEnv(input),
      `${claudeArgs} 2>>${shq(stderrLog)}`,
    ].join(' && ')

    // A needs-auth entry for the bridge would make this process skip it silently (claude-needs-auth.ts).
    const cleared = await clearNeedsAuthEntry(BRIDGE_MCP_SERVER_KEY)
    if (cleared) process.stderr.write(`daemon: cleared Claude Code needs-auth cache entry for ${cleared.key} (set ${describeSetAt(cleared.setAt, Date.now())}) before launching ${tmuxName}\n`)

    process.stderr.write(`daemon: spawn ${tmuxName}: creating the tmux session\n`)
    process.stderr.write(`daemon: spawn ${tmuxName}: inner cmd = ${inner.slice(0, 300)}...\n`)

    mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
    let created: ReturnType<typeof tmuxCreateSession>
    try {
      created = tmuxCreateSession(tmuxName, [withRaisedFdLimit(inner)])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`daemon: spawn ${tmuxName}: tmuxNewSession FAILED: ${msg}\n`)
      throw new Error(`failed to spawn tmux session: ${msg}`)
    }

    const tmuxConfirmedAlive = created === 'alive'
    process.stderr.write(`daemon: spawn ${tmuxName}: ${
      created === 'alive' ? 'tmux session confirmed alive'
      : created === 'dead' ? 'WARNING -- tmux session died immediately after creation'
      : 'WARNING -- tmux not responding; session unconfirmed, pane capture skipped'}\n`)

    let spawnLogPath: string | undefined
    if (tmuxConfirmedAlive) {
      try {
        mkdirSync(SPAWN_LOGS_DIR, { recursive: true, mode: 0o700 })
        const logPath = join(SPAWN_LOGS_DIR, `${tmuxName}-${sessionId}.log`)
        tmuxSync(['pipe-pane', '-o', '-t', tmuxName, `cat >> ${shq(logPath)}`])
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
      ...(cleared ? { channelNote: NEEDS_AUTH_CLEARED_NOTE } : {}),
    }
  }

  // No await before the write: callers rely on it having happened on return.
  async deliver(info: SessionInfo, msg: Notification): Promise<DeliveryResult> {
    // Every delivery to a Claude session passes here: one that no longer matches what hydra.toml gives its specialist is not delivered to.
    const refused = deliveryRefusal(info)
    if (refused) return { status: 'rejected', retryable: false, reason: refused }
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
      tmuxSync(['kill-session', '-t', info.tmuxName])
      return { status: 'stopped' }
    } catch (err) {
      if (tmuxTimedOut(err)) return { status: 'uncertain', reason: 'tmux not responding' }
      if (!tmuxHasSession(info.tmuxName)) return { status: 'stopped' }
      return { status: 'uncertain', reason: `tmux session ${info.tmuxName} is still running` }
    }
  }

  isAlive(info: ClaudeSubject): boolean {
    return tmuxHasSession(info.tmuxName)
  }

  peek(info: ClaudeSubject, lines: number = 50): string {
    try {
      return tmuxSync(['capture-pane', '-t', info.tmuxName, '-p', '-S', `-${lines}`]).trimEnd()
    } catch { return '' }
  }

  // From the transcript: the last turn's context tokens over the window the session was launched with. The id comes
  // from the status file (a /clear starts a new transcript; the stored id goes stale). The pane's footer number is
  // the fallback (no or unknown launch model; no transcript yet). Only a `ctx:` footer is cross-checked,
  // at most every CONTEXT_CHECK_EVERY_MS: the README's hook prints Claude Code's used percentage as is, while a bar may
  // be rescaled (GSD's reads 100% at auto-compact).
  usage(info: ClaudeSubject): ContextUsage | null {
    const window = contextWindowOf(info.sessionMetadata?.model)
    const path = window ? transcriptPathFor(readClaudeStatus(info.tmuxName)?.sessionId ?? info.claudeSessionId) : undefined
    const used = path ? lastContextTokens(path) : null
    if (!window || used === null) {
      const pane = this.paneFooter(info)
      return pane === null ? null : { usedTokens: 0, contextWindow: 0, percent: pane.percent }
    }
    const percent = Math.min(100, Math.round(used * 100 / window))
    const now = Date.now()
    if (now - (lastContextCheckAt.get(info.tmuxName) ?? 0) >= CONTEXT_CHECK_EVERY_MS) {
      lastContextCheckAt.set(info.tmuxName, now)
      const pane = this.paneFooter(info)
      if (pane?.shape === 'ctx' && Math.abs(pane.percent - percent) >= 2) {
        process.stderr.write(`daemon: context %: ${info.tmuxName} transcript says ${percent}% (${used}/${window}), pane says ${pane.percent}%\n`)
      }
    }
    return { usedTokens: used, contextWindow: window, percent }
  }

  private paneFooter(info: ClaudeSubject): ContextFooter | null {
    try {
      const pane = tmuxSync(['capture-pane', '-t', info.tmuxName, '-p'])
      return parseContextFooter(pane)
    } catch { return null }
  }

  // Reads only the four token counters out of the transcript; see daemon/usage.ts.
  // A drain that can't stat the file throws: a transcript that quietly stops being
  // readable would otherwise report zero forever.
  usageTotals(info: UsageSubject, prev: unknown): UsageReading | null {
    const transcript = transcriptPathFor(info.claudeSessionId)
    if (!transcript) return null
    const next = drainSession(transcript, (prev as SessionCursor | undefined) ?? newSessionCursor())
    return {
      totals: { ...next.totals }, providerSessionId: info.claudeSessionId!, cursor: next.cursor,
      restarted: next.restarted,
      phases: { totals: next.phaseTotals, current: next.latch, voted: next.voted },
    }
  }

  surface(info: ClaudeSubject): string | null { return tmuxHasSession(info.tmuxName) ? info.tmuxName : null }

  async sendKeys(info: ClaudeSubject, keys: string, opts?: { raw?: boolean; trailingKey?: string }): Promise<{ queued: boolean }> {
    // Its own 3 s, as before: typing a long message into a busy pane can outlast a read.
    const send = (args: string[]) => tmuxSync(['send-keys', '-t', info.tmuxName, ...args], { timeout: 3_000 })
    if (opts?.raw) send(keys.split(/\s+/))
    else { send(['-l', keys]); send([opts?.trailingKey ?? 'Enter']) }
    return { queued: false }
  }

  async interrupt(info: SessionInfo): Promise<void> {
    Bun.spawn(['tmux', 'send-keys', '-t', info.tmuxName, 'Escape'], { stdio: ['pipe', 'pipe', 'pipe'] })
  }

  detectBlockingState(_info: ClaudeSubject, tailText: string): BlockingState | null {
    return detectBlockingStateFn(tailText)
  }

  async reconnect(_info: SessionInfo): Promise<boolean> {
    // Claude's bridge self-reconnects via scheduleReconnect() — daemon accepts passively
    return true
  }
}
