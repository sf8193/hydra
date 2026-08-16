import { registry } from './sessions.js'
import { transport } from './bridge-transport.js'
import { computeToolsForSession, UNIVERSAL_TOOLS } from './bridge-tools.js'
import { BASE_TOOLS, CAPABILITY_TOOLS } from '../shared/constants.js'

export function getToolsForSession(sessionId: string): typeof UNIVERSAL_TOOLS {
  if (sessionId === 'main') {
    return computeToolsForSession('master_orchestrator', new Set())
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
    return BASE_TOOLS.master_orchestrator.has(toolName)
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
