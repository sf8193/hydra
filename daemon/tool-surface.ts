import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { computeToolsForSession, type SessionTool } from './bridge-tools.js'
import { BASE_TOOLS as TYPED_BASE_TOOLS, CAPABILITY_TOOLS as TYPED_CAPABILITY_TOOLS } from '../shared/constants.js'
import type { SessionType, Capability } from '../shared/constants.js'

// Widened views: isToolAllowed checks arbitrary wire names, not just known ToolNames.
const BASE_TOOLS: Readonly<Record<SessionType, ReadonlySet<string>>> = TYPED_BASE_TOOLS
const CAPABILITY_TOOLS: Readonly<Record<Capability, ReadonlySet<string>>> = TYPED_CAPABILITY_TOOLS

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
    new Set(info.capabilities ?? []),
    {
      descriptions: info.toolDescriptions,
      inputSchemas: info.toolInputSchemas,
    },
  )
}

/** O(1) name-only check — avoids rebuilding the full tool list on every tool_call. */
export function isToolAllowed(sessionId: string, toolName: string): boolean {
  if (sessionId === 'main') {
    return BASE_TOOLS.master_orchestrator.has(toolName) || CAPABILITY_TOOLS.main_handoff.has(toolName)
  }
  const info = registry.get(sessionId)
  if (!info) return BASE_TOOLS.thread_owner.has(toolName)
  if (BASE_TOOLS[info.sessionType].has(toolName)) return true
  if (info.capabilities) {
    for (const cap of info.capabilities) {
      if (CAPABILITY_TOOLS[cap]?.has(toolName)) return true
    }
  }
  return false
}

export function pushToolSurface(sessionId: string): void {
  const tools = getToolsForSession(sessionId)
  process.stderr.write(`daemon: pushToolSurface ${sessionId} → ${tools.length} tools\n`)
  transport.sendOrQueue(sessionId, { type: 'tools_update', tools })
}
