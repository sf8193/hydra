import { describe, test, expect } from 'bun:test'
import { formatTranscript } from '../transcript-dump.js'

const entries = [
  { ts: '2026-07-08T20:00:00Z', author: 'me', content: '**Adversarial Review** — 3 rounds\nA critic will challenge.' },
  { ts: '2026-07-08T20:01:00Z', author: 'me', content: '[critic→owner]\nFinding 1: the design is wrong because…' },
  { ts: '2026-07-08T20:02:00Z', author: 'me', content: '_⚔️²▲₃ Critic posted (Round 2/3). Owner defending..._' },
  { ts: '2026-07-08T20:03:00Z', author: 'me', content: '[owner→critic]\nRebuttal: no, and here is the evidence…' },
]

describe('formatTranscript', () => {
  test('separates exchange from scaffolding, preserves both', () => {
    const out = formatTranscript('review', 't-1', entries, 5, { topic: 'liveness', outcome: 'complete' })
    expect(out).toContain('## The exchange')
    expect(out).toContain('Finding 1: the design is wrong')
    expect(out).toContain('Rebuttal: no, and here is the evidence')
    expect(out).toContain('## Scaffolding')
    expect(out).toContain('Critic posted (Round 2/3)')
    expect(out).toContain('> topic: liveness')
    expect(out).toContain('4/5 tracked messages captured (2 exchange, 2 scaffolding)')
  })
})
