// Ratchet: whether a session is dead is occupancy()'s question (session-reachability.ts), never a read of
// `deadAt`. `deadAt` is history: when a death was written. The files below may touch it, for the reason given,
// and only on the lines listed, by their text (trimmed, comments excluded). A new or changed line, or a new
// file, fails here: ask occupancy() instead, or, if it really is history, list it under its reason.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Glob } from 'bun'

const ALLOWED: Record<string, { why: string; lines: string[] }> = {
  'bridge-server.ts': {
    why: 'history, not liveness: a death check retried after the hold stops once another path has already given its verdict',
    lines: [
      "if (!info || info.deadAt) { deathCheckLogged.delete(sessionId); return }",
    ],
  },
  'bridge-dispatch.ts': {
    why: 'of a name\'s dead records, the latest death',
    lines: [
      "const record = records.find(s => occupancy(s) !== 'dead') ?? records.sort((a, b) => (b.deadAt ?? 0) - (a.deadAt ?? 0))[0]",
    ],
  },
  'engines/boot.ts': {
    why: 'a persisted Codex record\'s verdict at boot',
    lines: [
      "export function classifyPersisted(info: Pick<SessionInfo, 'engine' | 'codexThreadId' | 'deadAt'>, tmuxAlive: boolean): 'live' | 'dead' {",
      "if (info.engine === 'codex' && info.codexThreadId) return info.deadAt ? 'dead' : 'live'",
    ],
  },
  'engines/codex-engine-adapter.ts': {
    why: 'a Codex home is claimed by records its runtime has not given up on',
    lines: [
      "const claimed = [...registry.values()].some(s => s !== info && !s.deadAt && s.engine === 'codex' && (s.codexHomeName ?? s.tmuxName) === home)",
    ],
  },
  'engines/codex-piggyback.ts': {
    why: 'buffers for a Codex record its runtime has given up on are dropped',
    lines: [
      "if (!info || info.deadAt || !info.adapter) { this.clear(sessionId); return }",
      "if (!registry.has(sid) || registry.get(sid)?.deadAt || entry.items.length === 0) continue",
    ],
  },
  'engines/codex-runtime.ts': {
    why: 'the Codex runtime writes and reads its own verdict',
    lines: [
      "if (!current || current.deadAt || current.engine !== 'codex') return",
      "delete info.deadAt",
      "if (info && !info.deadAt) deps.finalise(info)",
      "const codexSessions = records.filter(s => !s.deadAt)",
      "delete info.deadAt",
    ],
  },
  'event-bus.ts': {
    why: 'the death event carries when it happened',
    lines: [
      "'session:death': { sessionId: string; threadId: string; wasOwner: boolean; tmuxName: string; deadAt?: number; claudeSessionId?: string; engine?: ProviderId; codexThreadId?: string; codexHomeName?: string }",
    ],
  },
  'observability.ts': {
    why: 'a vitals sample is dropped once the autopsy has read it, which is when the death is written',
    lines: [
      "const goneOrDead = (id: string) => { const s = registry.get(id); return !s || !!s.deadAt }",
    ],
  },
  'protocol-runner.ts': {
    why: 'a Codex runtime\'s stamp is its verdict even while its socket lingers (C1)',
    lines: [
      "const connected = () => transport.has(sessionId) && !registry.get(sessionId)?.deadAt",
    ],
  },
  'raindrop.ts': {
    why: 'final usage is dated at the death',
    lines: [
      "const { sessionId, deadAt } = death",
      "const bodies = usageBodies(sessionId, facts, 'final', deadAt ?? deps.now(), final)",
      "threadId: facts.threadId, at: deadAt ?? deps.now(),",
    ],
  },
  'recovery.ts': {
    why: 'restoring a dead record keeps its first stamp; boot candidates are those the loader stamped (and tmux is checked too)',
    lines: [
      "dead.deadAt ??= Date.now()",
      "!!info.deadAt",
    ],
  },
  'session-health.ts': {
    why: 'a crash is announced once: not again once written',
    lines: [
      "if (occ === 'dead' && !info.deadAt && info.adapter.channel === 'bridge' && !crashAlerted.has(info.sessionId)) {",
    ],
  },
  'session-lifecycle.ts': {
    why: 'the resume count of the latest death, the resume recheck\'s "already written" guard',
    lines: [
      ".filter(s => s.claudeSessionId === resumeFrom && s.deadAt)",
      ".sort((a, b) => (b.deadAt ?? 0) - (a.deadAt ?? 0))[0]",
      "deadAt: info.deadAt,",
      "if (!s || s.deadAt) return",
    ],
  },
  'session-reachability.ts': {
    why: 'occupancy() itself: a stamp over a running session reads orphaned, unless a record not given up on holds its name',
    lines: [
      "deadAt?: number",
      "givenUp: !!info.deadAt,",
      "if (!info.deadAt) return false",
      "for (const s of records) if (s.sessionId !== info.sessionId && s.tmuxName === info.tmuxName && !s.deadAt) return true",
    ],
  },
  'sessions.ts': {
    why: 'the field, markDead (the one runtime writer, which says so once, the first time it writes), the boot loader (a tmux that does not answer keeps the saved state), the boot history close, ranking a name\'s past threads by when it died',
    lines: [
      "deadAt?: number",
      "const tmuxAlive = state === 'alive' || (state === 'not responding' && !info.deadAt)",
      "delete info.deadAt",
      "info.deadAt = info.deadAt ?? Date.now()",
      "if (!session.deadAt) continue",
      "if (entry) { entry.endedAt = session.deadAt; closed++ }",
      "const fresh = info.deadAt === undefined",
      "info.deadAt ??= at",
      "if (s.tmuxName === targetName && s.deadAt) note(s.threadId, s.deadAt)",
    ],
  },
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const DAEMON = join(import.meta.dir, '..')

describe('deadAt readers', () => {
  test('only the allowed files touch deadAt, each on its listed lines', () => {
    const found: Record<string, string[]> = {}
    for (const f of new Glob('**/*.ts').scanSync(DAEMON)) {
      if (f.startsWith('__tests__/')) continue
      const lines = strip(readFileSync(join(DAEMON, f), 'utf8')).split('\n').filter(l => /\bdeadAt\b/.test(l)).map(l => l.trim())
      if (lines.length) found[f] = lines
    }
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, a.lines]))
    expect(found, 'a deadAt read decides liveness only in occupancy(): ask it instead, or allow a history read with its reason').toEqual(expected)
  })
})
