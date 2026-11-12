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
// new-session is killed at this unless the caller names its own bound: the daemon creates sessions on its one
// event loop, and a hung tmux server would otherwise hold it for good. Longer than a read: it forks a shell.
export const NEW_SESSION_TIMEOUT_MS = 5_000

// tmux exits 1 for a cold start and for a real error alike; only the text differs.
const NO_SERVER = /no server running|error connecting to/

export const SCRUBBED_SPAWN_VARS = [
  'RAINDROP_WRITE_KEY', 'RAINDROP_MODE', 'RAINDROP_USER_ID', 'RAINDROP_OMIT_REPO',
  // The Slack listener's default tokens: only the daemon's listener may hold them. HYDRA_SLACK_USER_TOKEN reads as the
  // operator. Names hydra.toml's Slack apps declare are added to these by registerSpawnVars.
  'SLOPBOT_SLACK_APP_TOKEN', 'SLOPBOT_SLACK_BOT_TOKEN',
  'HYDRA_SLACK_APP_TOKEN', 'HYDRA_SLACK_BOT_TOKEN', 'HYDRA_SLACK_USER_TOKEN',
] as const

/** The shape of an environment variable name: the one rule hydra.toml's `*_token_env` keys and the scrub share. */
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

/**
 * Variables no token may live in, because scrubbing one would strip it from every session: what a shell, tmux, git, ssh
 * and Claude need, and hydra's own controls (a name under a prefix below, other than HYDRA_SLACK_*, which are tokens).
 */
export const NEVER_SCRUBBED: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMUX', 'TERM', 'PWD', 'TMPDIR', 'LANG',
  'ANTHROPIC_API_KEY', 'GH_TOKEN', 'SSH_AUTH_SOCK',
])
export const NEVER_SCRUBBED_PREFIXES: readonly string[] = ['HYDRA_', 'CLAUDE_', 'LC_', 'XDG_']

/** Why a name can't hold a token (it is a variable sessions need), or undefined when it can. */
export function tokenVarRefusal(name: string): string | undefined {
  if ((SCRUBBED_SPAWN_VARS as readonly string[]).includes(name) || name.startsWith('HYDRA_SLACK_')) return undefined
  if (NEVER_SCRUBBED.has(name) || NEVER_SCRUBBED_PREFIXES.some(p => name.startsWith(p))) return 'is a variable sessions need'
  return undefined
}

// The one store of what is scrubbed. Invariant: names only accumulate for the life of the daemon; a name dropped from
// hydra.toml stays scrubbed. `captured` is every value taken out of an environment, for the daemon's own use.
const registered = new Set<string>()
const captured: Record<string, string> = {}

/** Empties what registerSpawnVars added and the captured values. For tests only. */
export function _resetScrubbedForTesting(): void {
  registered.clear()
  for (const k of Object.keys(captured)) delete captured[k]
}

/** The names scrubbed from every spawn right now: the fixed ones, then those hydra.toml's Slack apps name. */
export function scrubbedSpawnVars(): readonly string[] {
  return [...SCRUBBED_SPAWN_VARS, ...registered]
}

const sweepArgvFor = (vars: readonly string[]): string[] =>
  vars.flatMap((v, i) => (i === 0 ? [] : [';']).concat('set-environment', '-gr', v))

// Removes them, so nothing the daemon forks can inherit them. Returns what this call took.
export function captureSpawnVars(env: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const taken: Record<string, string> = {}
  for (const v of scrubbedSpawnVars()) {
    const value = env[v]
    if (value !== undefined) { taken[v] = value; captured[v] = value }
    delete env[v]
  }
  return Object.freeze(taken)
}

export type SpawnVarRefusal = { name: string; reason: string }

/**
 * Adds variables hydra.toml names as token variables to the scrubbed set, and takes their values out of `env` now.
 * A name that isn't a variable's shape, or that sessions need (PATH), is refused, not added: the loader rejects those,
 * so this is the backstop for a config that did not go through it.
 */
export function registerSpawnVars(names: readonly string[], env: NodeJS.ProcessEnv = process.env): { added: string[]; refused: SpawnVarRefusal[] } {
  const added: string[] = []
  const refused: SpawnVarRefusal[] = []
  for (const v of names) {
    const reason = !ENV_NAME_RE.test(v) ? 'is not an environment variable name' : tokenVarRefusal(v)
    if (reason) { refused.push({ name: v, reason }); continue }
    if (!(SCRUBBED_SPAWN_VARS as readonly string[]).includes(v) && !registered.has(v)) { registered.add(v); added.push(v) }
    if (env[v] !== undefined) { captured[v] = env[v]!; delete env[v] }
  }
  return { added, refused }
}

/** Every scrubbed value this process has taken out of an environment, including those of names registered after boot. */
export function capturedSpawnVars(): Readonly<Record<string, string>> {
  return { ...captured }
}

export function scrubbedSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const v of scrubbedSpawnVars()) delete env[v]
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
  const run = { stdio: 'pipe' as const, timeout: NEW_SESSION_TIMEOUT_MS, killSignal: 'SIGKILL' as const, ...opts, env: scrubbedSpawnEnv(opts.env) }
  try {
    exec('tmux', sweepArgvFor(scrubbedSpawnVars()), {
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
        `hydra: tmux env sweep failed (${cause}) — a pane may inherit ${scrubbedSpawnVars().join(', ')}\n`,
      )
      const reason = e.code ?? (e.status === undefined ? 'unknown' : `exit-${e.status}`)
      try { onSweepFailure?.(reason) } catch {}
    }
  }
  exec('tmux', ['new-session', ...args], run)
}

// A session's identity. Claude and omp export their own at launch. A process started from a session's
// shell inherits that session's; codex gets none of its own, so drop any it inherited.
export const SESSION_IDENTITY_VARS = ['HYDRA_SESSION_ID', 'HYDRA_SESSION_NAME', 'HYDRA_THREAD_ID', 'HYDRA_SESSION_TYPE'] as const

export function codexSpawnEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = scrubbedSpawnEnv({ ...process.env, ...extra })
  for (const v of SESSION_IDENTITY_VARS) delete env[v]
  return env
}
