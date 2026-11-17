// Whether a session is a restricted specialist, and how records written before the boolean `restricted` are read.
//
// A restricted specialist is one boolean, `restricted`, on the session's launch policy. Before it, the same fact was stored two ways:
// the policy's `access` (`workdir` or `operator`) and the session type `scoped`. A record still holding either is read here, once,
// when it is loaded (sessions.ts: the session records and the thread records), so the rest of the daemon sees only the boolean.
// In memory only the boolean exists. A stored record still carries the old forms next to it (storedSession, storedPolicy), so a build from before
// the boolean, reading a record this build wrote after a revert, keeps the same confinement. Those two are historical, dropped in a follow-up.
// A leaf module: it imports nothing, so the record loaders and writers can use it.

/**
 * Whether this stored policy is a restricted specialist's. Fails closed: a policy is restricted unless its `restricted` is exactly `false`, so a
 * missing, garbled or unknown value (`access: 'root'` read as nothing) holds the restricted tools, and a start under it is refused by `policyProblem`.
 * No policy at all is not a specialist's: a plain session. The one predicate: the tool gate, `confined`, `unverified` and `isPlainWorker` all read it.
 */
export const isRestrictedPolicy = <P extends { restricted?: unknown }>(p: P | undefined): p is P & { restricted: true } => p !== undefined && p.restricted !== false

/** Whether this session is a restricted specialist (isRestrictedPolicy of its policy). */
export const isRestricted = (info: { policy?: { restricted?: unknown } } | undefined): boolean => isRestrictedPolicy(info?.policy)

/** A stored policy's `access` read as `restricted` (`workdir`: true, `operator`: false), and dropped. Any other value leaves `restricted` unset, which `policyProblem` refuses to read. */
export function readStoredPolicy(policy: unknown): void {
  if (typeof policy !== 'object' || policy === null) return
  const p = policy as { access?: unknown; restricted?: unknown }
  if (!('access' in p)) return
  if (typeof p.restricted !== 'boolean') {
    if (p.access === 'workdir') p.restricted = true
    else if (p.access === 'operator') p.restricted = false
  }
  delete p.access
}

/**
 * A stored session record read for `restricted`. The type `scoped` becomes `thread_owner` (what a restricted session now is) and the
 * policy's `restricted` is true. A `scoped` record whose policy is missing keeps the restriction on a policy that cannot be read (its
 * id matches nothing), so every start and message under it is refused with that cause, never run with a wider tool set.
 */
export function readStoredSession(raw: { sessionType?: unknown; policy?: unknown; specialist?: unknown }): void {
  readStoredPolicy(raw.policy)
  if (raw.sessionType !== 'scoped') return
  raw.sessionType = 'thread_owner'
  if (typeof raw.policy !== 'object' || raw.policy === null) {
    raw.policy = { specialist: typeof raw.specialist === 'string' ? raw.specialist : '', restricted: true, id: 'unreadable' }
  } else {
    (raw.policy as { restricted?: boolean }).restricted = true
  }
}

/** A plain worker: an owner of its thread that is not a restricted specialist (a restricted one was its own session type before, so it was never reaped, asked to hand off or auto-recovered like a worker). */
export const isPlainWorker = (info: { sessionType?: string; policy?: { restricted?: unknown } }): boolean => info.sessionType === 'thread_owner' && !isRestricted(info)

/** Historical, dropped in a follow-up (sf8193/hydra#777): the policy as a build from before the boolean stored it, `restricted` kept beside `access` (`workdir` restricted, `operator` not). */
export const storedPolicy = <P extends { restricted?: unknown }>(p: P | undefined): (P & { access: 'workdir' | 'operator' }) | undefined =>
  p === undefined ? undefined : { ...p, access: isRestrictedPolicy(p) ? 'workdir' : 'operator' }

/** Historical, dropped in a follow-up (sf8193/hydra#777): a session record as a build from before the boolean stored it: a restricted session has the type `scoped`, which that build's tool gate and plain-worker checks read. */
export const storedSession = <S extends { sessionType?: string; policy?: { restricted?: unknown } }>(info: S): S =>
  ({ ...info, ...(isRestricted(info) && { sessionType: 'scoped' }), ...(info.policy !== undefined && { policy: storedPolicy(info.policy) }) })
