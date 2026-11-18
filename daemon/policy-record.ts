// Whether a session is a restricted specialist: one boolean, `restricted`, on the session's launch policy (sessions.json and threads.json
// store it as it is). A leaf module: it imports nothing, so the record loaders and writers can use it.

/**
 * Whether this stored policy is a restricted specialist's. Fails closed: a policy is restricted unless its `restricted` is exactly `false`, so a
 * missing, garbled or unknown value (`access: 'root'` read as nothing) holds the restricted tools, and a start under it is refused by `policyProblem`.
 * No policy at all is not a specialist's: a plain session. The one predicate: the tool gate, `unverified` and `isPlainWorker` all read it.
 */
export const isRestrictedPolicy = <P extends { restricted?: unknown }>(p: P | undefined): p is P & { restricted: true } => p !== undefined && p.restricted !== false

/** Whether this session is a restricted specialist (isRestrictedPolicy of its policy). */
export const isRestricted = (info: { policy?: { restricted?: unknown } } | undefined): boolean => isRestrictedPolicy(info?.policy)

/** A plain worker: an owner of its thread that is not a restricted specialist (a restricted one is never reaped, asked to hand off or auto-recovered like a worker). */
export const isPlainWorker = (info: { sessionType?: string; policy?: { restricted?: unknown } }): boolean => info.sessionType === 'thread_owner' && !isRestricted(info)
