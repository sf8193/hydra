import { describe, test, expect } from 'bun:test'
import { buildSummaryFormat } from '../prompts/build-summary.js'
import { buildMachine } from '../build.js'

describe('buildSummaryFormat', () => {
  test('carries the build sections and closing sections in order', () => {
    const out = buildSummaryFormat(2, []).join('\n')
    expect(out).toContain('**🔨 Build Summary** (2 rounds)')
    expect(out).toContain('**What was built**')
    expect(out).toContain('**PRs / artifacts**')
    const positions = ['PRs / artifacts', 'Tensions', 'Emergences', 'Synthesis', "What's next"].map(s => out.indexOf(s))
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
  })

  test('pre-seeds detected PR links', () => {
    const out = buildSummaryFormat(1, ['https://github.com/x/y/pull/1']).join('\n')
    expect(out).toContain('https://github.com/x/y/pull/1')
  })
})

describe('build state machine closing phase', () => {
  test('LGTM and final feedback both route through closing', () => {
    expect(buildMachine.transition('reviewing', 'critic_lgtm')).toMatchObject({ ok: true, to: 'closing' })
    expect(buildMachine.transition('reviewing', 'critic_final')).toMatchObject({ ok: true, to: 'closing' })
  })

  test('closing completes on summary or timeout, never hangs', () => {
    expect(buildMachine.transition('closing', 'summary_posted')).toMatchObject({ ok: true, to: 'complete' })
    expect(buildMachine.transition('closing', 'timeout')).toMatchObject({ ok: true, to: 'complete' })
  })
})
