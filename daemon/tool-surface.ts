import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { computeToolsForSession, type SessionTool } from './bridge-tools.js'
import { BASE_TOOLS as TYPED_BASE_TOOLS, ALL_CAPABILITY_TOOLS as TYPED_ALL_CAPABILITY_TOOLS } from '../shared/constants.js'
import type { SessionType, Capability, DerivedCapability } from '../shared/constants.js'
import type { SessionInfo } from './sessions.js'
import { resolveEngine } from './engines/instances.js'

// Widened views: isToolAllowed checks arbitrary wire names, not just known ToolNames.
const BASE_TOOLS: Readonly<Record<SessionType, ReadonlySet<string>>> = TYPED_BASE_TOOLS
const ALL_CAPABILITY_TOOLS: Readonly<Record<Capability | DerivedCapability, ReadonlySet<string>>> = TYPED_ALL_CAPABILITY_TOOLS

/** Whether ask_predecessor works end to end: the predecessor's engine can fork it headless (askFork),
 * and the successor's MCP client waits out a fork turn. Only Claude's bridge reads LONG_TOOL_TIMEOUTS_MS:
 * Codex's client stops at its default tool_timeout_sec (60s), omp's bridge at a fixed 60s. */
export function predecessorAsker(info: Pick<SessionInfo, 'engine' | 'predecessor'>): ((question: string, timeoutMs: number) => Promise<string>) | undefined {
  const p = info.predecessor
  const engine = p && resolveEngine(p.engine)
  if (!p || !engine?.askFork || info.engine !== 'claude') return undefined
  return (question, timeoutMs) => engine.askFork!(p.fork, p.cwd, question, timeoutMs, p.model)  // a method call, so the adapter keeps its this
}

export const canAskPredecessor = (info: Pick<SessionInfo, 'engine' | 'predecessor'>): boolean => !!predecessorAsker(info)

/** Stored capabilities plus the derived ones: a session that can ask its predecessor gets the tool. */
export function sessionCapabilities(info: Pick<SessionInfo, 'capabilities' | 'engine' | 'predecessor'>): Set<Capability | DerivedCapability> {
  const caps = new Set<Capability | DerivedCapability>(info.capabilities ?? [])
  if (canAskPredecessor(info)) caps.add('predecessor')
  return caps
}

export function getToolsForSession(sessionId: string): SessionTool[] {
  if (sessionId === 'main') {
    return computeToolsForSession('master_orchestrator', new Set<Capability>(['main_handoff']))
  }
  const info = registry.get(sessionId)
  if (!info) {
    process.stderr.write(`daemon: getToolsForSession: no registry entry for ${sessionId}, using thread_owner defaults\n`)
    return computeToolsForSession('thread_owner', new Set())
  }
  return computeToolsForSession(
    info.sessionType,
    sessionCapabilities(info),
    {
      descriptions: info.toolDescriptions,
      inputSchemas: info.toolInputSchemas,
    },
  )
}

/** O(1) name-only check — avoids rebuilding the full tool list on every tool_call. */
export function isToolAllowed(sessionId: string, toolName: string): boolean {
  if (sessionId === 'main') {
    return BASE_TOOLS.master_orchestrator.has(toolName) || ALL_CAPABILITY_TOOLS.main_handoff.has(toolName)
  }
  const info = registry.get(sessionId)
  if (!info) return BASE_TOOLS.thread_owner.has(toolName)
  if (BASE_TOOLS[info.sessionType].has(toolName)) return true
  for (const cap of sessionCapabilities(info)) {
    if (ALL_CAPABILITY_TOOLS[cap]?.has(toolName)) return true
  }
  return false
}

export function pushToolSurface(sessionId: string): void {
  const tools = getToolsForSession(sessionId)
  process.stderr.write(`daemon: pushToolSurface ${sessionId} → ${tools.length} tools\n`)
  transport.sendOrQueue(sessionId, { type: 'tools_update', tools })
}
