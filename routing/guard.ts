import { spawn } from 'child_process'
import type { Guard } from '../config/types.js'
import { SPECIALIST_NAME_RE, isSessionThread } from '../shared/specialist-name.js'
import { bareOf, readTarget } from '../shared/target-kind.js'

/**
 * `[guard]`: the operator's own command, run for each message after routing and the `reachable_by` check, for anyone but the operator.
 * It judges; it never produces the content. Its exit code decides the message's fate:
 *   0   deliver (stdout `{"target": "<specialist>"}` redirects it, and that specialist's `reachable_by` is checked again)
 *   10  drop it: logged, counted, never delivered
 *   75  not now: it stays owed, for at most `owed_max`, and the next catch-up pass offers it again
 *   anything else, a timeout, too much output, or a command that will not start: deliver anyway,
 *   and log why, so a broken guard never silences anyone.
 *
 * A guard is untrusted in the ways that matter to the daemon: its run is bounded by one deadline, its
 * output by a few KB, and it runs in its own process group so a timeout kills everything it started.
 */

/** What the guard reads on stdin: who, where, and where routing sent it. `text` only with `include_text`. */
export type GuardInput = {
  /** The sender's person id; null for a stranger. */
  person: string | null
  roles: string[]
  place: string
  /** The conversation's id, as docs/slack.md writes it: `slack:C0ABC:<thread ts>`, and `slack:<app>:C0ABC:<thread ts>` for a conversation of an app other than `default`. */
  conversation: string
  /** Where routing sent it: `main`, a specialist, or a session's thread. */
  target: string
  text?: string
}

export type GuardVerdict =
  | { fate: 'deliver'; target?: string }
  | { fate: 'drop' }
  | { fate: 'later' }
  | { fate: 'open'; why: string }

export const GUARD_DROP = 10
export const GUARD_LATER = 75
export const GUARD_STDOUT_MAX = 4096
/** After the guard exits, how long a child it left behind may keep stdout open before it is killed. */
const STDOUT_GRACE_MS = 200
/** What a guard inherits: an allowlist, so a secret added to the daemon's environment later never reaches it. */
const GUARD_ENV = new Set(['PATH', 'HOME', 'USER', 'LANG', 'TZ', 'TMPDIR', 'SHELL'])
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH|CREDENTIAL/i

export function guardEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (GUARD_ENV.has(k) || k.startsWith('LC_') || (k.startsWith('HYDRA_') && !SECRET_NAME.test(k))) env[k] = v
  }
  return env
}

export function runGuard(g: Pick<Guard, 'command' | 'timeoutMs'>, input: GuardInput): Promise<GuardVerdict> {
  return new Promise(resolve => {
    let settled = false
    let out = ''
    let code: number | null = null
    let stdoutClosed = false
    let grace: ReturnType<typeof setTimeout> | undefined
    let child: ReturnType<typeof spawn>
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch {} }
    const finish = (v: GuardVerdict) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(grace)
      killGroup() // whatever it left running goes with it
      resolve(v)
    }
    const deadline = setTimeout(() => finish({ fate: 'open', why: `timed out after ${g.timeoutMs / 1000}s` }), g.timeoutMs)
    try {
      child = spawn('sh', ['-c', g.command], { stdio: ['pipe', 'pipe', 'ignore'], env: guardEnv(), detached: true })
    } catch (err) {
      finish({ fate: 'open', why: `could not start: ${err instanceof Error ? err.message : err}` })
      return
    }
    child.on('error', err => finish({ fate: 'open', why: `could not start: ${err.message}` }))
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      out += chunk
      if (out.length > GUARD_STDOUT_MAX) finish({ fate: 'open', why: `printed more than ${GUARD_STDOUT_MAX} bytes` })
    })
    const verdict = () => finish(judge(code, out))
    child.stdout!.on('close', () => { stdoutClosed = true; if (code !== null) verdict() })
    child.on('exit', c => {
      code = c ?? -1
      if (c !== 0 || stdoutClosed) return verdict() // only exit 0 reads stdout
      grace = setTimeout(verdict, STDOUT_GRACE_MS) // a lingering child holding stdout does not get to hold the verdict
    })
    child.stdin!.on('error', () => {}) // a guard that does not read stdin is its business
    child.stdin!.end(JSON.stringify(input))
  })
}

function judge(code: number | null, out: string): GuardVerdict {
  if (code === GUARD_DROP) return { fate: 'drop' }
  if (code === GUARD_LATER) return { fate: 'later' }
  if (code !== 0) return { fate: 'open', why: `exited ${code}` }
  const text = out.trim()
  if (!text) return { fate: 'deliver' }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { fate: 'open', why: 'exited 0 but printed something other than JSON' } }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { fate: 'open', why: 'exited 0 but printed JSON that is not an object' }
  const { target, to } = parsed as { target?: unknown; to?: unknown }
  if (target === undefined && to !== undefined) return { fate: 'open', why: 'printed `to`, which is not read: print `target`, as `{"target": "specialist:<name>"}` or `{"target": "main"}`' }
  if (target === undefined) return { fate: 'deliver' }
  // A redirect names `main` or `specialist:<name>`. Whether the specialist is declared is the delivery's to say, as before. A thread is no redirect: the guard cannot move a message into a session's thread.
  const read = typeof target === 'string' && target === target.trim() ? readTarget(target, id => SPECIALIST_NAME_RE.test(id) && !isSessionThread(id)) : undefined
  if (!read || !read.ok || read.ref.kind === 'thread') return { fate: 'open', why: `printed an unusable "target": ${JSON.stringify(target).slice(0, 80)}; write \`specialist:<name>\` or \`main\` (the guard's stdin \`target\` is already in that form)` }
  return { fate: 'deliver', target: bareOf(read.ref) }
}
