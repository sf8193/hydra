import { spawn } from 'child_process'
import { accessSync, constants as fsConstants, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATE_DIR } from '../../infra/config.js'
import type { SessionInfo, SessionMetadata } from '../../sessions/registry.js'
import { isRestricted } from '../../shared/policy-record.js'

// Under STATE_DIR so the test preload's temp state dir keeps `bun test` from ever running the real hooks
export const KILL_HOOK_PATH = join(STATE_DIR, 'hooks', 'on-kill')
export const PRE_HANDOFF_HOOK_PATH = join(STATE_DIR, 'hooks', 'pre-handoff')

/** The session's identity as HYDRA_* env vars, shared by the user hooks. */
function hookEnv(info: HookSubject): Record<string, string> {
  return {
    HYDRA_SESSION_NAME: info.tmuxName,
    HYDRA_SESSION_ID: info.sessionId,
    HYDRA_THREAD_ID: info.threadId ?? '',
    HYDRA_ENGINE: info.engine ?? 'claude',
    HYDRA_CLAUDE_SESSION_ID: info.claudeSessionId ?? '',
    HYDRA_CODEX_HOME_NAME: info.codexHomeName ?? '',
    HYDRA_SESSION_TYPE: info.sessionType ?? '',
    HYDRA_RESTRICTED: isRestricted(info) ? '1' : '',
  }
}

/**
 * User extension point: if <STATE_DIR>/hooks/on-kill exists, run it detached after a
 * session dies, with the session's identity in env. Best-effort, never blocks the kill.
 */
export function runKillHook(info: SessionInfo, reason: string, hookPath = KILL_HOOK_PATH): void {
  if (!existsSync(hookPath)) return
  try {
    const child = spawn(hookPath, [], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...hookEnv(info), HYDRA_KILL_REASON: reason },
    })
    child.on('error', err => process.stderr.write(`daemon: on-kill hook failed: ${err.message}\n`))
    child.unref()
  } catch (err) {
    process.stderr.write(`daemon: on-kill hook failed: ${err instanceof Error ? err.message : err}\n`)
  }
}

const PRE_HANDOFF_OUTPUT_MAX = 1500

/** The pre-handoff hook's answer: go, or refuse with the hook's output. */
export type PreHandoffVerdict = { ok: true } | { ok: false; output: string }

/** What the hooks read about a session. Main has no SessionInfo, so hooks take only this (it has no thread and no worktree). */
export type HookSubject = Pick<SessionInfo, 'tmuxName' | 'sessionId'>
  & Partial<Pick<SessionInfo, 'threadId' | 'engine' | 'claudeSessionId' | 'codexHomeName' | 'sessionType' | 'policy' | 'worktree'>>
  & { sessionMetadata?: Pick<SessionMetadata, 'cwd'> }

/** Where the session works: its Hydra worktree, else the cwd it was launched in. */
export function sessionDir(info: Pick<HookSubject, 'worktree' | 'sessionMetadata'>): string | undefined {
  return info.worktree?.path ?? info.sessionMetadata?.cwd
}

/**
 * User extension point: if <STATE_DIR>/hooks/pre-handoff is executable, run it with the letter
 * path before a handoff. A non-zero exit refuses the handoff and returns the hook's output.
 * Fails open: a hook that gives no verdict (times out, can't start, dies from a signal, or
 * exits 126/127 because it couldn't run a command) must never trap a session.
 */
export async function runPreHandoffHook(
  info: HookSubject, letterPath: string, hookPath = PRE_HANDOFF_HOOK_PATH, timeoutMs = 15_000,
): Promise<PreHandoffVerdict> {
  if (!existsSync(hookPath)) return { ok: true }
  try { accessSync(hookPath, fsConstants.X_OK) } catch {
    process.stderr.write(`daemon: pre-handoff hook ${hookPath} is not executable — skipped\n`)
    return { ok: true }
  }
  // A missing session dir must not become the daemon's own cwd: a `git` check would judge the
  // wrong repo. Run from the temp dir and say so through an empty HYDRA_CWD.
  const sessionCwd = sessionDir(info)
  const cwd = sessionCwd && existsSync(sessionCwd) ? sessionCwd : undefined
  if (sessionCwd && !cwd) process.stderr.write(`daemon: pre-handoff hook: session dir ${sessionCwd} is gone — running from ${tmpdir()} with HYDRA_CWD empty\n`)
  // Async, so a slow hook never stalls the daemon. Its own process group, so a timeout kills
  // whatever it started too. The verdict waits for the output streams, but never past a short grace.
  return new Promise(resolve => {
    const started = Date.now()
    let out = ''
    let settled = false
    let exitCode: number | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let exitGrace: ReturnType<typeof setTimeout> | undefined
    // One line per run, so a pass, a refusal and a fail-open can be told apart in the log.
    const settle = (r: PreHandoffVerdict, outcome: 'pass' | 'refused' | 'fail-open', why?: string) => {
      if (settled) return
      settled = true; clearTimeout(timer); clearTimeout(exitGrace)
      process.stderr.write(`daemon: pre-handoff hook ${info.tmuxName}: ${outcome}, exit ${exitCode ?? 'none'}, ${Date.now() - started}ms${why ? ` (${why})` : ''}\n`)
      resolve(r)
    }
    // No verdict: hand off anyway.
    const giveUp = (why: string) => settle({ ok: true }, 'fail-open', why)
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(hookPath, [letterPath], {
        cwd: cwd ?? tmpdir(),
        env: { ...process.env, ...hookEnv(info), HYDRA_CWD: cwd ?? '' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (err) { return giveUp(err instanceof Error ? err.message : String(err)) }
    const killGroup = () => { try { process.kill(-child.pid!, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} } }
    timer = setTimeout(() => { killGroup(); giveUp(`timed out after ${timeoutMs}ms`) }, timeoutMs)
    // Keep the tail: a hook prints its reason last.
    const collect = (d: Buffer) => { out = (out + d.toString('utf8')).slice(-PRE_HANDOFF_OUTPUT_MAX * 2) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', err => giveUp(err.message))
    const verdict = () => {
      if (exitCode === 0) return settle({ ok: true }, 'pass')
      // 126/127: the hook couldn't run a command (not executable, not found). That is a broken
      // hook, not a refusal; refusing would trap the session on every retry.
      if (exitCode === 126 || exitCode === 127) return giveUp('the hook could not run a command')
      const output = out.trim() || `exit ${exitCode}`
      settle({ ok: false, output: output.length > PRE_HANDOFF_OUTPUT_MAX ? `…${output.slice(-PRE_HANDOFF_OUTPUT_MAX)}` : output }, 'refused')
    }
    child.on('close', () => { if (exitCode !== null) verdict() })
    child.on('exit', (code, signal) => {
      if (code === null) return giveUp(`signal ${signal}`)
      exitCode = code
      // 'close' follows once the streams drain; a background child holding them open must not stall the verdict.
      exitGrace = setTimeout(verdict, 200)
    })
  })
}
