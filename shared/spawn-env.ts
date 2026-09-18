import * as childProcess from 'child_process'
/**
 * tmux panes inherit RLIMIT_NOFILE from the tmux *server*, not from whoever ran
 * `new-session`. A server started by launchd carries the macOS default of 256
 * and holds it for its entire lifetime, so a shell with a high limit still
 * spawns constrained panes.
 *
 * Headroom is the lesser reason to raise it. The greater one is diagnostic:
 * bun attributes unrelated startup failures to "possibly due to low max file
 * descriptors", quoting whatever ceiling is in effect. Under a low ceiling that
 * message is emitted for faults with no descriptor involvement at all — a
 * permission denial on the working directory reads identically to exhaustion.
 * Raising the limit removes the false attribution along with the constraint.
 *
 * Separated by `;` rather than `&&`, with stderr discarded, so a shell that
 * rejects the call still runs the command.
 */
export const TMUX_PANE_FD_LIMIT = 65536

export function withRaisedFdLimit(command: string): string {
  return `ulimit -n ${TMUX_PANE_FD_LIMIT} 2>/dev/null; ${command}`
}

const SWEEP_TIMEOUT_MS = 500

// tmux exits 1 for a cold start and for a real error alike; only the text differs.
const NO_SERVER = /no server running|error connecting to/

export const SCRUBBED_SPAWN_VARS = [
  'RAINDROP_WRITE_KEY', 'RAINDROP_MODE', 'RAINDROP_USER_ID', 'RAINDROP_OMIT_REPO',
] as const

export const SWEEP_ARGV: readonly string[] = SCRUBBED_SPAWN_VARS.flatMap(
  (v, i) => (i === 0 ? [] : [';']).concat('set-environment', '-gr', v),
)

// Removes them, so nothing the daemon forks can inherit them.
export function captureSpawnVars(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const captured: Record<string, string> = {}
  for (const v of SCRUBBED_SPAWN_VARS) {
    const value = env[v]
    if (value !== undefined) captured[v] = value
    delete env[v]
  }
  return Object.freeze(captured)
}

export function scrubbedSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const v of SCRUBBED_SPAWN_VARS) delete env[v]
  return env
}

let onSweepFailure: ((reason: string) => void) | null = null

export function setSweepFailureHandler(fn: ((reason: string) => void) | null): void {
  onSweepFailure = fn
}

type ExecFn = typeof childProcess.execFileSync
type TmuxOpts = Omit<childProcess.ExecFileSyncOptions, 'env'> & { env?: NodeJS.ProcessEnv }

export function tmuxNewSession(
  args: string[],
  opts: TmuxOpts = {},
  exec: ExecFn = childProcess.execFileSync,
): void {
  const run = { stdio: 'pipe' as const, ...opts, env: scrubbedSpawnEnv(opts.env) }
  try {
    exec('tmux', [...SWEEP_ARGV], {
      ...run,
      timeout: run.timeout ? Math.min(run.timeout, SWEEP_TIMEOUT_MS) : SWEEP_TIMEOUT_MS,
    })
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string; status?: number; code?: string }
    const stderr = String(e.stderr ?? '').trim()
    if (e.code !== 'ENOENT' && !NO_SERVER.test(stderr)) {
      const cause = [stderr, e.code, e.status === undefined ? '' : `exit ${e.status}`, e.message]
        .filter(Boolean).join(' ')
      process.stderr.write(
        `hydra: tmux env sweep failed (${cause}) — a pane may inherit ${SCRUBBED_SPAWN_VARS.join(', ')}\n`,
      )
      const reason = e.code ?? (e.status === undefined ? 'unknown' : `exit-${e.status}`)
      try { onSweepFailure?.(reason) } catch {}
    }
  }
  exec('tmux', ['new-session', ...args], run)
}

export function codexSpawnEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return scrubbedSpawnEnv({ ...process.env, ...extra })
}
