// Ratchet: whether a session is dead is occupancy()'s question (session-reachability.ts), never a read of
// `deadAt`. `deadAt` is history: when a death was written. The files below may touch it, for the reason given,
// and only on the counted number of lines (comments excluded). A new line, or a new file, fails here: ask
// occupancy() instead, or, if it really is history, add it with its reason.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Glob } from 'bun'

const ALLOWED: Record<string, { lines: number; why: string }> = {
  'session-reachability.ts': { lines: 2, why: 'occupancy() itself: a stamp over a running session reads orphaned' },
  'sessions.ts': { lines: 7, why: 'the field, markDead (the one runtime writer), the boot loader, the boot history close, ranking a name\'s past threads by when it died' },
  'session-lifecycle.ts': { lines: 4, why: 'the resume count of the latest death, the resume recheck\'s "already written" guard' },
  'session-health.ts': { lines: 1, why: 'a crash is announced once: not again once written' },
  'recovery.ts': { lines: 2, why: 'restoring a dead record keeps its first stamp; boot candidates are those the loader stamped (and tmux is checked too)' },
  'raindrop.ts': { lines: 3, why: 'final usage is dated at the death' },
  'observability.ts': { lines: 1, why: 'a vitals sample is dropped once the autopsy has read it, which is when the death is written' },
  'event-bus.ts': { lines: 1, why: 'the death event carries when it happened' },
  'bridge-dispatch.ts': { lines: 1, why: 'of a name\'s dead records, the latest death' },
  'protocol-runner.ts': { lines: 1, why: 'a Codex runtime\'s stamp is its verdict even while its socket lingers (C1)' },
  'engines/boot.ts': { lines: 2, why: 'a persisted Codex record\'s verdict at boot' },
  'engines/codex-runtime.ts': { lines: 5, why: 'the Codex runtime writes and reads its own verdict' },
  'engines/codex-piggyback.ts': { lines: 2, why: 'buffers for a Codex record its runtime has given up on are dropped' },
  'engines/codex-engine-adapter.ts': { lines: 1, why: 'a Codex home is claimed by records its runtime has not given up on' },
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const DAEMON = join(import.meta.dir, '..')

describe('deadAt readers', () => {
  test('only the allowed files touch deadAt, each on its counted lines', () => {
    const found: Record<string, number> = {}
    for (const f of new Glob('**/*.ts').scanSync(DAEMON)) {
      if (f.startsWith('__tests__/')) continue
      const lines = strip(readFileSync(join(DAEMON, f), 'utf8')).split('\n').filter(l => /\bdeadAt\b/.test(l)).length
      if (lines) found[f] = lines
    }
    const expected = Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, a.lines]))
    expect(found, 'a deadAt read decides liveness only in occupancy(): ask it instead, or allow a history read with its reason').toEqual(expected)
  })
})
