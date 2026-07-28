import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// Ratchet: protocol code must not grow new raw gateway.send calls.
//
// Raw gateway.send throws on the platform's length cap and does not chunk;
// inside protocol code an awaited throw strands the state machine (the
// 2026-07-08 design freeze: an oversized aggregate threw and the answer
// timer was never armed). All content-bearing protocol sends go through
// safeSend, which chunks and never throws.
//
// The counts below are the sanctioned survivors — fire-and-forget sends
// whose rejection is already .catch-swallowed, and bounded id-capturing
// status lines. Adding a raw send to a protocol file fails this test:
// either use safeSend, or (rarely) justify the exception in the PR and
// bump the count in the same commit.

const SANCTIONED_RAW_SENDS: Record<string, number> = {
  'design.ts': 5,
  'adversarial.ts': 5,
  'build.ts': 4,
}

describe('raw gateway.send ratchet (protocol files)', () => {
  for (const [file, allowed] of Object.entries(SANCTIONED_RAW_SENDS)) {
    test(`${file} has at most ${allowed} sanctioned raw sends`, () => {
      const src = readFileSync(join(import.meta.dir, '..', file), 'utf8')
      // Comment lines are stripped so a mention in prose can't trip the count;
      // <= makes this a true one-way ratchet — removals don't need a bump here.
      const code = src
        .split('\n')
        .filter(l => !l.trim().startsWith('//'))
        .join('\n')
      const count = (code.match(/gateway\.send\(/g) ?? []).length
      expect(count).toBeLessThanOrEqual(allowed)
    })
  }
})
