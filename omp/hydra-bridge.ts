// omp extension: hydra's bridge for an omp session. Speaks the daemon-socket protocol bridge.ts
// speaks for Claude (register / registered / notification / tools_update / tool_call / tool_result).
// Loaded with `omp -e`; the session runs in tmux like Claude's.
import { connect, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { SESSION_INSTRUCTIONS } from '../shared/constants.js'

// The part of omp's ExtensionAPI this file uses (omp is not a hydra dependency, so its types are not imported).
type ExtensionAPI = {
  registerTool(tool: any): void
  on(event: string, handler: (e: any) => unknown): void
  getActiveTools(): string[]
  sendUserMessage(text: string, options?: { deliverAs?: 'aside' }): void
}
type Wire = Record<string, any>
type Tool = { name: string; description?: string; inputSchema?: Record<string, unknown> }

const SOCK = process.env.DAEMON_SOCK
const SESSION_ID = process.env.HYDRA_SESSION_ID
const RECONNECT_MS = 1000
const POLL_MS = 100
// omp re-runs extension factories for child sessions (Task subagents) in the same process: one bridge per process.
const SINGLETON = Symbol.for('hydra.omp.bridge')

// Mirrors Claude's channel envelope so the same daemon notifications read the same to the model.
export function formatNotification(content: unknown, meta: Record<string, string> = {}): string {
  const attrs = Object.entries(meta).map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('')
  return `<channel source="hydra"${attrs}>\n${typeof content === 'string' ? content : JSON.stringify(content)}\n</channel>`
}

export default function (pi: ExtensionAPI) {
  if (!SOCK || !SESSION_ID || (globalThis as any)[SINGLETON]) return
  ;(globalThis as any)[SINGLETON] = true

  let sock: Socket | null = null
  let buf = ''
  let started = false
  const toolNames: string[] = []
  // Only the tools of the first `registered` gate readiness: a tool that arrives later must not stall delivery if omp activates it late.
  let gate: string[] | null = null
  const pending = new Map<string, (r: { content: any[]; isError?: boolean }) => void>()
  const send = (m: Wire) => { sock?.write(JSON.stringify(m) + '\n') }

  // Nothing is injected before omp's runtime is bound (sendUserMessage throws until then), the daemon has
  // answered `register` and omp has activated the hydra tools: a first turn must be able to call `reply`.
  // The spawn prompt goes first, read once so omp's subprocesses never see it.
  const outbox: Array<{ text: string; first?: boolean }> = []
  const initial = process.env.HYDRA_SPAWN_PROMPT
  delete process.env.HYDRA_SPAWN_PROMPT
  if (initial) outbox.push({ text: initial, first: true })

  function flush() {
    const active = started && gate ? new Set(pi.getActiveTools()) : null
    if (!active || !gate!.every(n => active.has(n))) { if (outbox.length) setTimeout(flush, POLL_MS); return }
    for (let m = outbox.shift(); m; m = outbox.shift()) pi.sendUserMessage(m.text, m.first ? undefined : { deliverAs: 'aside' })
  }

  function registerTools(tools: Tool[]) {
    gate ??= tools.map(t => t.name)
    for (const t of tools) {
      if (toolNames.includes(t.name)) continue
      toolNames.push(t.name)
      pi.registerTool({
        name: t.name, label: t.name, description: t.description ?? t.name,
        parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as any,
        async execute(_id: string, params: unknown) {
          if (!sock) return { content: [{ type: 'text', text: `${t.name} failed: not connected to daemon` }], details: {}, isError: true }
          const id = randomUUID()
          const result = await new Promise<{ content: any[]; isError?: boolean }>(resolve => {
            const timer = setTimeout(() => { pending.delete(id); resolve({ content: [{ type: 'text', text: `${t.name} failed: timeout waiting for daemon response` }], isError: true }) }, 60_000)
            pending.set(id, r => { clearTimeout(timer); resolve(r) })
            send({ type: 'tool_call', id, name: t.name, args: params })
          })
          return { content: result.content, details: {}, ...(result.isError ? { isError: true } : {}) }
        },
      } as any)
    }
  }

  function handle(m: Wire) {
    switch (m.type) {
      case 'registered': case 'tools_update': registerTools(m.tools ?? []); flush(); break
      case 'notification': outbox.push({ text: formatNotification(m.content, m.meta) }); flush(); break
      case 'tool_result': { const done = pending.get(m.id); if (done) { pending.delete(m.id); done({ content: m.content, isError: m.isError }) } break }
    }
  }

  function connectSocket() {
    const s = connect(SOCK!)
    s.on('connect', () => { sock = s; buf = ''; send({ type: 'register', sessionId: SESSION_ID }) })
    s.on('data', d => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        try { handle(JSON.parse(line)) } catch (e) { process.stderr.write(`hydra-bridge: bad daemon message: ${e}\n`) }
      }
    })
    s.on('error', () => {})
    s.on('close', () => { if (sock === s) sock = null; setTimeout(connectSocket, RECONNECT_MS) })
  }

  pi.on('session_start', async () => { started = true; flush() })
  // Claude gets these rules as MCP instructions; omp has no such channel, so they go in the system prompt each turn.
  pi.on('before_agent_start', async (e) => ({ systemPrompt: [...e.systemPrompt, SESSION_INSTRUCTIONS] }))
  connectSocket()
}
