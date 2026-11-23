// Who sent a CLI request (shared/caller.ts has the model). Each launch is issued a token; its session's record keeps only the hash, so the
// state files hold nothing a caller could present.

import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { registry } from './registry.js'
import { occupancy } from './session-reachability.js'

export function issueSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex')
  return { token, hash: sessionTokenHash(token) }
}

export const sessionTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')

/** Constant-time check that `token` hashes to `expectedHash` (hex sha256). */
export function verifySessionToken(token: string | undefined, expectedHash: string): boolean {
  if (!token) return false
  const got = Buffer.from(sessionTokenHash(token), 'utf8')
  const want = Buffer.from(expectedHash, 'utf8')
  return got.length === want.length && timingSafeEqual(got, want)
}

// Holds token hashes for sessions between adapter.launch() and registry.set() so a bridge
// registering during startup is authenticated against its issued hash before the record lands.
const pendingSessionTokenHashes = new Map<string, string>()

export function notePendingSessionToken(sessionId: string, hash: string): void {
  pendingSessionTokenHashes.set(sessionId, hash)
}

export function clearPendingSessionToken(sessionId: string): void {
  pendingSessionTokenHashes.delete(sessionId)
}

export function bridgeRegistrationPolicy(sessionId: string): { expectedHash?: string; requireToken: boolean } {
  const record = registry.get(sessionId)
  if (record) {
    return {
      expectedHash: record.sessionTokenHash,
      requireToken: Boolean(record.sessionTokenHash && record.bridgeToken),
    }
  }
  const pending = pendingSessionTokenHashes.get(sessionId)
  if (pending) return { expectedHash: pending, requireToken: true }
  return { expectedHash: undefined, requireToken: false }
}

/**
 * Authenticate a bridge's `register` message against the session's stored token hash.
 * - Sessions spawned with token-aware bridges (`requireToken: true`) must present the matching token.
 * - Pre-deploy live sessions that already have a `sessionTokenHash` but no `bridgeToken` flag
 *   keep their old bridge alive across a rolling restart (missing token accepted), while a wrong
 *   token is still refused.
 * - Records without a hash (`main`, stray bridges, pre-token legacy records) remain accepted.
 */
export function verifyBridgeRegistration(opts: {
  sessionToken?: string
  expectedHash?: string
  requireToken: boolean
}): { ok: true } | { ok: false; reason: string } {
  if (!opts.expectedHash) return { ok: true }
  if (!opts.sessionToken) {
    return opts.requireToken ? { ok: false, reason: 'missing session token' } : { ok: true }
  }
  if (!verifySessionToken(opts.sessionToken, opts.expectedHash)) return { ok: false, reason: 'session token does not match' }
  return { ok: true }
}

/**
 * Who sent a CLI request: the operator's shell (no claim), the session whose token it presented, or a session that could not show which
 * (`unverified`: a session's environment without a token, a token no session holds or one whose session has ended, or an older CLI's
 * self-reported `callerSessionId`).
 * `hydra kill --destroy` refuses `unverified`, and `hydra spawn` treats it as a session that spawned nothing; it is never the operator.
 * No other command reads the caller.
 */
export type CLICaller = { kind: 'operator' } | { kind: 'session'; sessionId: string } | { kind: 'unverified'; why: string }

export function cliCaller(req: { caller?: unknown; params: Record<string, unknown> }): CLICaller {
  const claim = req.caller as { token?: unknown; inSession?: unknown } | undefined
  if (claim && typeof claim === 'object') {
    if (typeof claim.token === 'string' && claim.token) {
      const hash = sessionTokenHash(claim.token)
      const s = [...registry.values()].find(i => i.sessionTokenHash === hash)
      if (!s) return { kind: 'unverified', why: 'the session token it presented belongs to no session hydra knows' }
      // A process that outlived its session (a crash leaves the record behind) does not act as it.
      if (occupancy(s) === 'dead') return { kind: 'unverified', why: `the session token it presented is ${s.tmuxName}'s, which has ended` }
      return { kind: 'session', sessionId: s.sessionId }
    }
    if (claim.inSession) return { kind: 'unverified', why: 'it runs in a hydra session\'s environment but presented no session token (a session launched before tokens, or one that dropped HYDRA_SESSION_TOKEN)' }
  }
  // An older CLI named its session itself, unchecked: not to be believed, nor read as the operator.
  if (req.params.callerSessionId !== undefined) return { kind: 'unverified', why: 'it named its session (callerSessionId) instead of presenting a session token; update the hydra CLI it runs' }
  return { kind: 'operator' }
}
