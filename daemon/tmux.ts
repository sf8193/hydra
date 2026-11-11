// The daemon's tmux. Every sync tmux call goes through tmuxSync: bounded, killed with SIGKILL, and after a
// timeout held off for a while, since a sync call blocks the daemon's one event loop and a hung tmux server
// would otherwise hold it for good. A tmux that doesn't answer reads as "not responding", never as dead:
// what the daemon does on "dead" (mark it, recover over it, report it stopped) can't be taken back.
// The async window-activity reads live here too, outside the hold by design: they never block the loop.

import { execFileSync, execFile } from 'child_process'
import { tmuxNewSession } from '../shared/spawn-env.js'

/** How long a sync tmux call on the daemon's loop may take before it is killed. */
export const TMUX_TIMEOUT_MS = 2_000
/** After a sync tmux call times out, tmux is not asked to read anything for this long: the hold. */
export const TMUX_HOLD_MS = 30_000

/** A sync tmux call was killed at its timeout, or not made because of the hold. */
export const tmuxTimedOut = (err: unknown): boolean => (err as { code?: string }).code === 'ETIMEDOUT'

// Calls that act. They still try during the hold, since not acting would be its own answer; every other
// call, a new one included, fails at once as timed out.
const TMUX_ACTS = new Set(['kill-session', 'pipe-pane', 'send-keys', 'new-window'])

// The hold: the server timed out, so one hung server costs one timeout, not one per session per tick.
// `heldUntil` stays set past its end until tmux next answers, so that answer can be logged.
let heldUntil = 0

// The test seam: what runs tmux, and the clock the hold reads. With no argument, the real ones again.
let tmuxExec: typeof execFileSync = execFileSync
let tmuxNow: () => number = Date.now
export function _setTmuxForTesting(seam: { exec?: typeof execFileSync; now?: () => number } = {}): void {
  tmuxExec = seam.exec ?? execFileSync
  tmuxNow = seam.now ?? Date.now
  heldUntil = 0
  freezeFound = undefined
}

/**
 * The daemon's one way to run tmux synchronously: killed with SIGKILL at `timeout` (TMUX_TIMEOUT_MS unless
 * a call names a reason for another), since a hung tmux server must not hold the daemon's loop. A timeout
 * within TMUX_TIMEOUT_MS starts the hold; a call given longer (send-keys) was allowed to be slow, so its
 * timeout says less about the server. Returns stdout; throws as execFileSync does, and a timeout (or a read refused by the
 * hold) as `code: 'ETIMEDOUT'`, see tmuxTimedOut. `ignoreHold`: the server has just answered another call.
 */
export function tmuxSync(args: string[], opts: { timeout?: number; ignoreHold?: boolean } = {}): string {
  const { timeout = TMUX_TIMEOUT_MS } = opts
  if (!TMUX_ACTS.has(args[0]!) && !opts.ignoreHold && tmuxNow() < heldUntil) {
    throw Object.assign(new Error(`tmux ${args[0]}: not asked, tmux timed out within the last ${TMUX_HOLD_MS / 1000}s`), { code: 'ETIMEDOUT' })
  }
  try {
    const out = String(tmuxExec('tmux', args, { encoding: 'utf8', stdio: 'pipe', timeout, killSignal: 'SIGKILL' }))
    answered()
    return out
  } catch (err) {
    if (exitedWithStatus(err)) answered()   // an exit status is still an answer: the server is there
    if (!tmuxTimedOut(err) || timeout > TMUX_TIMEOUT_MS) throw err
    if (tmuxNow() >= heldUntil) process.stderr.write(`daemon: tmux ${args[0]} timed out at ${timeout}ms; tmux reads not asked for ${TMUX_HOLD_MS / 1000}s (sessions read as alive)\n`)
    heldUntil = tmuxNow() + TMUX_HOLD_MS
    throw err
  }
}

function answered(): void {
  if (!heldUntil) return
  heldUntil = 0
  process.stderr.write('daemon: tmux is answering again\n')
}

// Only tmux exiting with a status is an answer. A timeout, the hold, or a tmux that never ran or was killed
// (ENOENT, EAGAIN, a signal) says nothing about the session or the server.
const exitedWithStatus = (err: unknown): boolean => typeof (err as { status?: unknown }).status === 'number'

// A session named exactly this: a bare `-t name` also matches a session whose name only starts with it.
// display-message needs the trailing colon; `-t =name` there prints nothing, even for no such session.
const exactSession = (name: string) => `=${name}`
const exactSessionPane = (name: string) => `=${name}:`

/** A session as tmux reports it: `dead` only when tmux answered that it isn't there (see tmuxSync's `ignoreHold`). */
export function tmuxSessionState(name: string, opts: { ignoreHold?: boolean } = {}): 'alive' | 'dead' | 'not responding' {
  try {
    tmuxSync(['has-session', '-t', exactSession(name)], opts)
    return 'alive'
  } catch (err) {
    return exitedWithStatus(err) ? 'dead' : 'not responding'
  }
}

/**
 * A new tmux session, for the daemon, and its state just after: tmuxNewSession, then a has-session asked past
 * the hold (the server has just answered). new-session's bound (NEW_SESSION_TIMEOUT_MS unless `opts` names one)
 * may kill it after the server made the session, so on a timeout the session counts as created only if tmux
 * made it since this call began: during a hold the name check misses tmux's own names, and a session left
 * under the name is not ours. Anything else is killed, best effort, so no pane outlives its failed spawn, and
 * the timeout is thrown.
 */
export function tmuxCreateSession(name: string, args: string[], opts?: Parameters<typeof tmuxNewSession>[1]): 'alive' | 'dead' | 'not responding' {
  const since = Math.floor(tmuxNow() / 1000)
  try {
    tmuxNewSession(['-d', '-s', name, ...args], opts, tmuxExec)
  } catch (err) {
    if (!tmuxTimedOut(err)) throw err
    if (createdSince(name, since)) return 'alive'
    try { tmuxSync(['kill-session', '-t', exactSession(name)]) } catch {}
    throw err
  }
  return tmuxSessionState(name, { ignoreHold: true })
}

/** tmux made a session of exactly this name at `epochSec` or later. False if tmux can't say. */
function createdSince(name: string, epochSec: number): boolean {
  try {
    return Number(tmuxSync(['display-message', '-p', '-t', exactSessionPane(name), '#{session_created}'], { ignoreHold: true }).trim()) >= epochSec
  } catch { return false }
}

/** The tmux server as `hydra health` reports it. */
export function tmuxServerState(): 'running' | 'not running' | 'not responding' {
  try {
    tmuxSync(['list-sessions'])
    return 'running'
  } catch (err) {
    return exitedWithStatus(err) ? 'not running' : 'not responding'
  }
}

/**
 * Whether tmux has this session. Not responding reads as alive: a slow tmux is not a dead session, and
 * callers act on false for good (mark dead, recover over, report stopped), while true at worst waits for the next look.
 */
export function tmuxHasSession(name: string): boolean {
  return tmuxSessionState(name) !== 'dead'
}

// Looked up once, found or not, with no spawn: a freeze installed later is seen after a daemon restart.
let freezeFound: boolean | undefined
/** Whether `freeze` (the pane-to-PNG renderer paneScreenshot needs) is on PATH. */
export function hasFreeze(): boolean {
  return freezeFound ??= Bun.which('freeze') !== null
}

/**
 * A pane as a PNG at `outPath`: its colored text from tmux, rendered by `freeze` (which must be installed).
 * Throws if either fails. `freeze` keeps its own 10 s: it renders, it does not wait on tmux.
 */
export function paneScreenshot(target: string, outPath: string): void {
  const ansi = tmuxSync(['capture-pane', '-t', target, '-e', '-p'])
  execFileSync('freeze', ['-o', outPath, '--language', 'bash'], { input: ansi, stdio: 'pipe', timeout: 10_000, killSignal: 'SIGKILL' })
}

const windowActivityArgs = (target: string) => ['display-message', '-t', target, '-p', '#{window_activity}']

/** tmux window_activity (epoch seconds) of a target; 0 if unparsable. Throws if tmux fails. */
export function tmuxWindowActivity(target: string): number {
  return parseInt(tmuxSync(windowActivityArgs(target)).trim()) || 0
}

// window_activity epoch (seconds) of a tmux target, or null when tmux could not answer (error,
// timeout, unparsable). Callers decide what "unknown" means.
function windowActivitySync(name: string): number | null {
  try {
    const epoch = parseInt(tmuxSync(windowActivityArgs(name)).trim(), 10)
    return isNaN(epoch) ? null : epoch
  } catch { return null }
}

// async: outside the hold, never blocks the loop.
async function windowActivity(name: string): Promise<number | null> {
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      // SIGKILL: a child that ignored the default SIGTERM would leave this pending past its timeout.
      execFile('tmux', windowActivityArgs(name),
        { encoding: 'utf8', timeout: TMUX_TIMEOUT_MS, killSignal: 'SIGKILL' }, (err, stdout) => err ? reject(err) : resolve({ stdout }))
    })
    const epoch = parseInt(stdout.trim(), 10)
    return isNaN(epoch) ? null : epoch
  } catch { return null }
}

const ageS = (epoch: number) => Date.now() / 1000 - epoch

/** Active within the last `thresholdSeconds`; a failed lookup reads as not active. */
export function isTmuxRecentlyActiveSync(name: string, thresholdSeconds = 60): boolean {
  const epoch = windowActivitySync(name)
  return epoch !== null && ageS(epoch) < thresholdSeconds
}

export async function isTmuxRecentlyActive(name: string, thresholdSeconds = 60): Promise<boolean> {
  const epoch = await windowActivity(name)
  return epoch !== null && ageS(epoch) < thresholdSeconds
}

/** Silent for MORE than `seconds`: true only when tmux answered. A failed lookup is unknown, not silence. */
export function tmuxSilentLongerThanSync(name: string, seconds: number): boolean {
  const epoch = windowActivitySync(name)
  return epoch !== null && ageS(epoch) > seconds
}

export async function tmuxSilentLongerThan(name: string, seconds: number): Promise<boolean> {
  const epoch = await windowActivity(name)
  return epoch !== null && ageS(epoch) > seconds
}
