// No daemon-internal imports — this module breaks the session-lifecycle ↔ bridge-dispatch cycle.
//
// Tool access is determined by session type (base set) + capabilities (dynamic addons).
// Definitions live in shared/tool-definitions.ts. Name sets live in shared/constants.ts.
import { BASE_TOOLS, CAPABILITY_TOOLS } from '../shared/constants.js'
import type { SessionType, Capability, ToolName } from '../shared/constants.js'
import { UNIVERSAL_TOOLS } from '../shared/tool-definitions.js'

export { UNIVERSAL_TOOLS }

export type ToolOverrides = {
  descriptions?: Partial<Record<ToolName, string>>
  inputSchemas?: Partial<Record<ToolName, object>>
}

export function defaultToolDescription(name: string): string {
  const tool = UNIVERSAL_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`defaultToolDescription: unknown tool "${name}"`)
  return tool.description
}

export function computeToolsForSession(type: SessionType, capabilities: Set<Capability>, overrides?: ToolOverrides): typeof UNIVERSAL_TOOLS {
  const allowed = new Set(BASE_TOOLS[type])
  for (const cap of capabilities) {
    const extra = CAPABILITY_TOOLS[cap]
    if (extra) for (const t of extra) allowed.add(t)
  }
  const tools = UNIVERSAL_TOOLS.filter(t => allowed.has(t.name))
  if (!overrides?.descriptions && !overrides?.inputSchemas) return tools
  return tools.map(t => {
    const desc = overrides.descriptions?.[t.name]
    const schema = overrides.inputSchemas?.[t.name]
    if (!desc && !schema) return t
    return { ...t, ...(desc ? { description: desc } : {}), ...(schema ? { inputSchema: schema } : {}) }
  })
}
