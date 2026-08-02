import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// Ratchet: protocol and command-handler code must not grow new raw
// gateway.send calls.
//
// Raw gateway.send throws on the platform's length cap and does not
// chunk; inside protocol or handler code an awaited throw can strand
// a state machine or silently swallow the user's only error
// notification. All content-bearing sends go through safeSend, which
// chunks and never throws.
//
// The counts below are the sanctioned survivors. Adding a raw send
// to a guarded file fails this test: either use safeSend, or (rarely)
// justify the exception in the PR and bump the count in the same commit.

const SANCTIONED_RAW_SENDS: Record<string, number> = {
  'protocol-runner.ts': 0,
  'commands/protocol.ts': 0,
}

describe('raw gateway.send ratchet (protocol files)', () => {
  for (const [file, allowed] of Object.entries(SANCTIONED_RAW_SENDS)) {
    test(`${file} has at most ${allowed} sanctioned raw sends`, () => {
      const src = readFileSync(join(import.meta.dir, '..', file), 'utf8')
      const code = src
        .split('\n')
        .filter(l => !l.trim().startsWith('//'))
        .join('\n')
      const count = (code.match(/gateway\.send\(/g) ?? []).length
      expect(count).toBeLessThanOrEqual(allowed)
    })
  }
})
