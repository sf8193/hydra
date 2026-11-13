// Golden: which tools every non-scoped session may call, over every tool the daemon defines. Written against the
// code before the `scoped` session type and kept green through it: adding a type must not move any other type.
import { expect, test } from 'bun:test'
import { registry } from '../sessions.js'
import { getToolsForSession, isToolAllowed } from '../tool-surface.js'
import { UNIVERSAL_TOOLS } from '../../shared/tool-definitions.js'

process.stderr.write = (() => true) as any

const ALL = UNIVERSAL_TOOLS.map(t => t.name).sort()
const mk = (id: string, sessionType: string, extra: Record<string, unknown> = {}) => registry.set(id, {
  sessionId: id, tmuxName: id, topic: 't', threadId: `th-${id}`, createdAt: Date.now(), lastActive: Date.now(),
  listening: false, engine: 'claude', adapter: { stop: async () => {} }, sessionType, ...extra,
} as any)

const allowed = (id: string) => ALL.filter(n => isToolAllowed(id, n))

test('tool surface of each non-scoped session, advertised and enforced, is pinned', () => {
  mk('g-owner', 'thread_owner'); mk('g-guest', 'thread_guest'); mk('g-orch', 'master_orchestrator')
  mk('g-guest-proto', 'thread_guest', { capabilities: ['protocol_context'] })
  mk('g-owner-spawn', 'thread_owner', { capabilities: ['protocol_spawn'] })
  try {
    const surface: Record<string, { allowed: string[]; advertised: string[] }> = {}
    for (const id of ['g-owner', 'g-guest', 'g-orch', 'g-guest-proto', 'g-owner-spawn', 'main', 'unregistered-id']) {
      surface[id] = { allowed: allowed(id), advertised: getToolsForSession(id).map(t => t.name).sort() }
    }
    expect(surface).toMatchSnapshot()
  } finally {
    for (const id of ['g-owner', 'g-guest', 'g-orch', 'g-guest-proto', 'g-owner-spawn']) registry.delete(id)
  }
})
