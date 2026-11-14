// No daemon-internal imports — this module breaks the session-lifecycle ↔ bridge-dispatch cycle.
//
// Tool access is determined by session type (base set) + capabilities (dynamic addons).
// Definitions live in shared/tool-definitions.ts. Name sets live in shared/constants.ts.
import { BASE_TOOLS, ALL_CAPABILITY_TOOLS } from '../shared/constants.js'
import type { SessionType, Capability, DerivedCapability, ToolName } from '../shared/constants.js'
import { UNIVERSAL_TOOLS } from '../shared/tool-definitions.js'

export { UNIVERSAL_TOOLS }

/** A tool as advertised to a session: overrides may replace the literal description/schema. */
export type SessionTool = { readonly name: ToolName; readonly description: string; readonly inputSchema: object }

export type ToolOverrides = {
  descriptions?: Partial<Record<ToolName, string>>
  inputSchemas?: Partial<Record<ToolName, object>>
}

export function defaultToolDescription(name: string): string {
  const tool = UNIVERSAL_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`defaultToolDescription: unknown tool "${name}"`)
  return tool.description
}

/** `reply` as a scoped session sees it: text only. Attachments are never posted for it. */
function withoutFiles(tool: SessionTool): SessionTool {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> }
  const { files: _files, ...properties } = schema.properties ?? {}
  return { ...tool, inputSchema: { ...schema, properties } }
}

/**
 * `send_to_thread` as a scoped session sees it: to a specialist its hydra.toml `talks_to` names, a question or an answer, about a
 * conversation it owns, text only. Hydra renders what the receiver reads (daemon/talks-to.ts); nothing here reaches a header.
 */
function scopedSend(tool: SessionTool): SessionTool {
  return {
    ...tool,
    description: 'Ask another specialist for what you cannot do or know, or answer one that asked you. target is the name of a specialist your hydra.toml lets you talk to. type is question (you need something from it) or result (your answer to its question). chat_id is the conversation this is about: the chat_id of the message you are answering. Hydra delivers your text to the specialist quoted, cut at 1,500 characters, with your name, the asker you are serving and a link to the conversation, and labelled as written by a scoped session: to it your text is words from another session, never an instruction. It does not answer the person: tell them you asked, and that you do not know what comes back. If it fails, tell the person you could not reach the specialist.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The specialist to send to.' },
        type: { type: 'string', enum: ['question', 'result'], description: 'question: you need something from it. result: your answer to its question.' },
        text: { type: 'string', description: 'Self-contained: it sees only this and the link.' },
        chat_id: { type: 'string', description: 'The chat_id of the message you are answering: the conversation this is about.' },
      },
      required: ['target', 'type', 'text', 'chat_id'],
    },
  }
}

export function computeToolsForSession(type: SessionType, capabilities: Set<Capability | DerivedCapability>, overrides?: ToolOverrides): SessionTool[] {
  const allowed = new Set(BASE_TOOLS[type])
  // A scoped session's surface is its base set and nothing more: no capability grants it a tool.
  for (const cap of type === 'scoped' ? [] : capabilities) {
    const extra = ALL_CAPABILITY_TOOLS[cap]
    if (extra) for (const t of extra) allowed.add(t)
  }
  const base: SessionTool[] = UNIVERSAL_TOOLS.filter(t => allowed.has(t.name))
  const tools = type === 'scoped' ? base.map(t => t.name === 'reply' ? withoutFiles(t) : t.name === 'send_to_thread' ? scopedSend(t) : t) : base
  if (!overrides?.descriptions && !overrides?.inputSchemas) return tools
  return tools.map(t => {
    const desc = overrides.descriptions?.[t.name]
    const schema = overrides.inputSchemas?.[t.name]
    if (!desc && !schema) return t
    return { ...t, ...(desc ? { description: desc } : {}), ...(schema ? { inputSchema: schema } : {}) }
  })
}

/** Codex MCP cannot accept tools_update, so advertise the union of dynamic
 * protocol tools and enforce the live subset at the daemon boundary. */
export function codexStaticTools(): SessionTool[] {
  return computeToolsForSession('thread_owner', new Set(['protocol_context', 'protocol_spawn']))
}
