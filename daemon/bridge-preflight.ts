/**
 * Why a session has no bridge.
 *
 * "Bridge absent" has two causes that look identical from the daemon's side
 * and call for opposite responses:
 *
 *  (a) Claude Code started the bridge MCP server, but it hasn't registered
 *      with the daemon yet — slow boot, or a socket that dropped. A bridge
 *      process exists and retries on a timer, so the session is worth
 *      preserving: waiting works.
 *
 *  (b) Claude Code never started the bridge at all. The plugin's MCP server
 *      was missing from the config it resolved at launch, so no bridge
 *      process exists and none will appear. The session is inert for its
 *      whole life. Waiting cannot help, and preserving it parks a session
 *      that can never answer.
 *
 * Only Claude Code knows which happened, and it records the answer in its own
 * debug log: every MCP server it starts logs `MCP server "<name>": ...`.
 * Absence of that line for the bridge server is the (b) signature — observed
 * on 2026-08-25/26, where three spawns produced sessions whose logs contained
 * every other MCP server and no bridge, alongside spawns minutes earlier and
 * later that were fine.
 *
 * This module reads that answer. Classification is pure so it can be tested
 * without a Claude Code process.
 */

import { openSync, readSync, closeSync } from 'fs'

/**
 * The plugin Claude Code loads the bridge from. Named for the platform it was
 * built for first; it now serves every platform, and the daemon must not read
 * a platform into it — a Slack session loads its bridge from this same plugin.
 */
const BRIDGE_PLUGIN = 'discord'

/** `--channels` value: which plugin owns the session's chat channel. */
export const BRIDGE_CHANNEL_FLAG = `plugin:${BRIDGE_PLUGIN}@claude-plugins-official`

/** The name Claude Code logs the bridge's MCP server under. */
export const BRIDGE_MCP_SERVER = `plugin:${BRIDGE_PLUGIN}:${BRIDGE_PLUGIN}`

/**
 * Claude Code writes this once per launch, before it resolves MCP config.
 * Its absence means we are not looking at a startup section — see
 * `classifyBridgeStart`.
 */
const STARTUP_MARKER = 'Loading MCP configs'

/** How much of the debug log to read. Startup lands in the first few hundred KB. */
const STARTUP_SCAN_BYTES = 1_000_000

export type BridgeStartVerdict =
  /** Claude Code started the bridge MCP server. Absence of a socket is a connection problem. */
  | 'started'
  /** Claude Code never started it. No bridge process exists; the session cannot recover. */
  | 'never_started'
  /** The log can't answer — missing, unreadable, or trimmed past its startup section. */
  | 'unknown'

/**
 * A trimmed log is the reason this returns 'unknown' rather than
 * 'never_started' on a missing server line: the daemon front-trims spawn logs
 * past 5MB, which discards the startup section of exactly the long-lived
 * sessions whose bridge demonstrably did start. Requiring the startup marker
 * keeps a trimmed log from being read as evidence of a failure that never
 * happened.
 */
export function classifyBridgeStart(debugLogText: string | null): BridgeStartVerdict {
  if (debugLogText === null) return 'unknown'
  if (!debugLogText.includes(STARTUP_MARKER)) return 'unknown'
  return debugLogText.includes(`MCP server "${BRIDGE_MCP_SERVER}"`) ? 'started' : 'never_started'
}

function readHead(path: string, bytes: number): string | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(bytes)
    const read = readSync(fd, buf, 0, bytes, 0)
    return buf.toString('utf8', 0, read)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }
}

/** Read a session's Claude Code debug log and say whether its bridge ever started. */
export function readBridgeStartVerdict(debugLogPath: string | undefined): BridgeStartVerdict {
  if (!debugLogPath) return 'unknown'
  return classifyBridgeStart(readHead(debugLogPath, STARTUP_SCAN_BYTES))
}

// ---------------------------------------------------------------------------
// Report-once guard
// ---------------------------------------------------------------------------

/**
 * Two detectors reach the same finding by different routes: the post-spawn
 * check at 45s and the periodic orphan poll at 90s. Both are worth keeping —
 * one is prompt, the other catches bridges lost long after spawn — but the
 * thread should hear about a given session's missing bridge once.
 */
const absenceReported = new Set<string>()

/** True for the first caller on this session, false for every caller after. */
export function claimBridgeAbsenceReport(sessionId: string): boolean {
  if (absenceReported.has(sessionId)) return false
  absenceReported.add(sessionId)
  return true
}

/** Release the claim once the bridge is back, so a later loss is reported again. */
export function clearBridgeAbsenceReport(sessionId: string): void {
  absenceReported.delete(sessionId)
}

/** One line naming the cause, for the human who has to decide what to do next. */
export function describeBridgeAbsence(verdict: BridgeStartVerdict): string {
  switch (verdict) {
    case 'never_started':
      return 'Claude Code never loaded the bridge plugin at launch, so this session has no channel back to the daemon and cannot recover on its own.'
    case 'started':
      return 'The bridge started but has not registered with the daemon — it retries every 5s, so this may still resolve.'
    case 'unknown':
      return 'Could not determine whether the bridge ever started (debug log missing or trimmed).'
  }
}
