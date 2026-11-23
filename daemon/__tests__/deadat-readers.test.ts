// Ratchet: whether a session is dead is occupancy()'s question (sessions/occupancy.ts), never a read of
// `deadAt`. `deadAt` is history: when a death was written. The files below may touch it, for the reason given,
// and only on the lines listed, by their text (trimmed, comments excluded). A new or changed line, or a new
// file, fails here: ask occupancy() instead, or, if it really is history, list it under its reason.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Glob } from 'bun'

const ALLOWED: Record<string, { why: string; lines: string[] }> = {
  'app/bridge-server.ts': {
    why: 'history, not liveness: a death check retried after the hold stops once another path has already given its verdict',
    lines: [
      "if (!info || info.deadAt) { deathCheckLogged.delete(sessionId); return }",
    ],
  },
  'app/bridge-dispatch.ts': {
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
      "const claimed = [...this.registry.values()].some(s => s !== info && !s.deadAt && s.engine === 'codex' && (s.codexHomeName ?? s.tmuxName) === home)",
    ],
  },
  'sessions/codex-piggyback.ts': {
    why: 'buffers for a Codex record its runtime has given up on are dropped',
    lines: [
      "if (!info || info.deadAt || !info.adapter) { this.clear(sessionId); return }",
      "if (!registry.has(sid) || registry.get(sid)?.deadAt || entry.items.length === 0) continue",
    ],
  },
  'app/codex-runtime.ts': {
    why: 'the Codex runtime reads its own verdict (it writes through markDead and markRevived)',
    lines: [
      "if (!current || current.deadAt) return",
      "if (info && !info.deadAt) deps.finalise(info)",
      "const codexSessions = records.filter(s => !s.deadAt)",
      "if (info.deadAt) continue",
    ],
  },
  'sessions/observability.ts': {
    why: 'a vitals sample is dropped once the autopsy has read it, which is when the death is written',
    lines: [
      "const goneOrDead = (id: string) => { const s = registry.get(id); return !s || !!s.deadAt }",
    ],
  },
  'app/protocol-runner.ts': {
    why: 'a Codex runtime\'s stamp is its verdict even while its socket lingers (C1)',
    lines: [
      "const connected = () => transport.has(sessionId) && !registry.get(sessionId)?.deadAt",
    ],
  },
  'app/recovery.ts': {
    why: 'boot candidates are those the loader stamped (and tmux is checked too)',
    lines: [
      "!!info.deadAt",
    ],
  },
  'app/session-health.ts': {
    why: 'a crash is announced once: not again once written',
    lines: [
      "if (occ === 'dead' && !info.deadAt && !engineProfile(info.engine).judgesOwnDeath && !crashAlerted.has(info.sessionId)) {",
    ],
  },
  'app/session-lifecycle.ts': {
    why: 'skipping a second parent notice for an already-dead record, the resume count of the latest death, restoring a replaced record (keeps its first stamp), and the resume recheck\'s "already written" guard',
    lines: [
      ".filter(s => s.claudeSessionId === resumeFrom && s.deadAt)",
      ".sort((a, b) => (b.deadAt ?? 0) - (a.deadAt ?? 0))[0]",
      "old.deadAt ??= Date.now()",
      "if (!info.deadAt) notifyParentOfEnd(info, opts?.ended, reason)",
      "if (!s || s.deadAt) return",
    ],
  },
  'sessions/occupancy.ts': {
    why: 'occupancy itself: a stamp over a running session reads orphaned, unless a record not given up on holds its name',
    lines: [
      "deadAt?: number",
      "givenUp: !!info.deadAt,",
      "if (!info.deadAt) return false",
      "for (const s of records) if (s.sessionId !== info.sessionId && s.tmuxName === info.tmuxName && !s.deadAt) return true",
    ],
  },
  'sessions/session-reachability.ts': {
    why: 'resolveSendTarget ranks a name\'s past threads by when it died',
    lines: [
      "if (s.tmuxName === targetName && s.deadAt) note(s.threadId, s.deadAt)",
    ],
  },
  'sessions/registry.ts': {
    why: 'the field, markDead and markRevived (the runtime writers, a pair; markDead says so once, the first time it writes), the boot loader (a tmux that does not answer keeps the saved state), the boot history close',
    lines: [
      "deadAt?: number",
      "const tmuxAlive = state === 'alive' || (state === 'not responding' && !info.deadAt)",
      "delete info.deadAt",
      "info.deadAt = info.deadAt ?? Date.now()",
      "if (!session.deadAt) { if (this.reopenHistoryEntry(session.threadId, session.sessionId)) reopened++; continue }",
      "if (entry) { entry.endedAt = session.deadAt; closed++ }",
      "const fresh = info.deadAt === undefined",
      "info.deadAt ??= at",
      "delete info.deadAt",
    ],
  },
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const ROOT = join(import.meta.dir, '..', '..')   // keys are repo-relative

describe('deadAt readers', () => {
  test('only the allowed files touch deadAt, each on its listed lines', () => {
    const found: Record<string, string[]> = {}
    for (const [dir, prefix] of ['app', 'infra', 'engines', 'sessions', 'shared'].map(d => [join(ROOT, d), d + '/'] as const)) {
      for (const f of new Glob('**/*.ts').scanSync(dir)) {
        if (f.startsWith('__tests__/')) continue
        const lines = strip(readFileSync(join(dir, f), 'utf8')).split('\n').filter(l => /\bdeadAt\b/.test(l)).map(l => l.trim())
        if (lines.length) found[prefix + f] = lines
      }
    }
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, a.lines]))
    expect(found, 'a deadAt read decides liveness only in occupancy(): ask it instead, or allow a history read with its reason').toEqual(expected)
  })
})
