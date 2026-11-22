// Creating a tmux session, the one way hydra does it (a test pins this file as the only one). A tmux server freezes its
// environment at first launch and hands it to every session for that server's life, so the scrubbed names are swept
// from the server first, and the session gets the scrubbed env (shared/spawn-env.ts).

import * as childProcess from 'child_process'
import { scrubbedSpawnEnv, scrubbedSpawnVars } from '../shared/spawn-env.js'

const SWEEP_TIMEOUT_MS = 500

// new-session is killed at this unless the caller names its own bound: the daemon creates sessions on its one
// event loop, and a hung tmux server would otherwise hold it for good. Longer than a read: it forks a shell.
export const NEW_SESSION_TIMEOUT_MS = 5_000

// tmux exits 1 for a cold start and for a real error alike; only the text differs.
const NO_SERVER = /no server running|error connecting to/

const sweepArgvFor = (vars: readonly string[]): string[] =>
  vars.flatMap((v, i) => (i === 0 ? [] : [';']).concat('set-environment', '-gr', v))

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
    }
  }
  exec('tmux', ['new-session', ...args], run)
}
