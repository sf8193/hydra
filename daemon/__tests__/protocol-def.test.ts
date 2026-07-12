import { test, expect, describe } from 'bun:test'
import { join } from 'path'
import {
  parseProtocolDef, loadProtocolDef, toTransitionTable, expectedTag, windowMs, graceMs, isTerminal,
  loadLensDef, parseLensDef, loadProtocolWithLenses,
  type ProtocolDef, type LensDef,
} from '../protocol-def.js'
import { reviewMachine } from '../adversarial.js'
import { buildMachine } from '../build.js'

const PROTOCOLS_DIR = join(import.meta.dir, '..', '..', 'protocols')
const PROTOCOL_PATH = join(PROTOCOLS_DIR, 'review.md')
const BUILD_PATH = join(PROTOCOLS_DIR, 'build.md')
const SPIKE_PATH = join(PROTOCOLS_DIR, 'spike.md')
const LENSES_DIR = join(PROTOCOLS_DIR, 'lenses')

// The sentinel constants are module-private in adversarial.ts — test against literals.
const CRITIC_SENTINEL = '[critic→owner]'
const OWNER_SENTINEL = '[owner→critic]'
const SUMMARY_SENTINEL = '[summary]'

const CRITIC_TIMEOUT_MS = 10 * 60 * 1000
const OWNER_TIMEOUT_MS = 30 * 60 * 1000
const CLEANUP_TIMEOUT_MS = 5 * 60 * 1000
const POST_PASS_TIMEOUT_MS = 10 * 60 * 1000

const CRITIC_DISCONNECT_GRACE_MS = 30_000
const OWNER_DISCONNECT_GRACE_MS = 120_000

let def: ProtocolDef

test('the review protocol loads', async () => {
  def = await loadProtocolDef(PROTOCOL_PATH)
  expect(def.protocol).toBe('review')
})

describe('parity with adversarial.ts', () => {
  test('sentinel grammar matches the live constants', () => {
    expect(def.sentinels.critic_turn).toBe(CRITIC_SENTINEL)
    expect(def.sentinels.owner_turn).toBe(OWNER_SENTINEL)
    expect(def.sentinels.cleanup).toBe(SUMMARY_SENTINEL)
  })

  test('post_pass has no sentinel (instructions come from the lens)', () => {
    expect(def.sentinels.post_pass).toBeUndefined()
  })

  test('transition table matches reviewMachine exactly', () => {
    const table = toTransitionTable(def)
    for (const [phase, events] of Object.entries(table)) {
      for (const [event, target] of Object.entries(events)) {
        const result = reviewMachine.transition(phase as any, event as any)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.to).toBe(target as any)
      }
      expect(new Set(reviewMachine.validEvents(phase as any))).toEqual(new Set(Object.keys(events)))
    }
  })

  test('expectedTag reproduces the live closure (phase × actor → tag)', () => {
    expect(expectedTag(def, 'critic_turn', 'critic')).toBe(CRITIC_SENTINEL)
    expect(expectedTag(def, 'critic_turn', 'owner')).toBeNull()
    expect(expectedTag(def, 'owner_turn', 'owner')).toBe(OWNER_SENTINEL)
    expect(expectedTag(def, 'owner_turn', 'critic')).toBeNull()
    expect(expectedTag(def, 'cleanup', 'owner')).toBe(SUMMARY_SENTINEL)
    expect(expectedTag(def, 'cleanup', 'critic')).toBeNull()
    expect(expectedTag(def, 'post_pass', 'critic')).toBeNull()
    expect(expectedTag(def, 'complete', 'owner')).toBeNull()
  })

  test('turn windows match the live timeout constants', () => {
    expect(windowMs(def, 'critic_turn')).toBe(CRITIC_TIMEOUT_MS)
    expect(windowMs(def, 'owner_turn')).toBe(OWNER_TIMEOUT_MS)
    expect(windowMs(def, 'cleanup')).toBe(CLEANUP_TIMEOUT_MS)
    expect(windowMs(def, 'post_pass')).toBe(POST_PASS_TIMEOUT_MS)
  })

  test('disconnect grace matches the live constants', () => {
    expect(graceMs(def, 'critic')).toBe(CRITIC_DISCONNECT_GRACE_MS)
    expect(graceMs(def, 'owner')).toBe(OWNER_DISCONNECT_GRACE_MS)
  })

  test('reviewHalf is derivable from the definition', () => {
    expect(def.phases.critic_turn.half).toBe('top')
    expect(def.phases.cleanup.half).toBe('top')
    expect(def.phases.owner_turn.half).toBe('bottom')
    expect(def.phases.post_pass.half).toBe('bottom')
  })

  test('terminal phases match the machine', () => {
    expect(isTerminal(def, 'complete')).toBe(true)
    expect(isTerminal(def, 'cancelled')).toBe(true)
    expect(isTerminal(def, 'critic_turn')).toBe(false)
    expect(isTerminal(def, 'owner_turn')).toBe(false)
    expect(isTerminal(def, 'post_pass')).toBe(false)
    expect(isTerminal(def, 'cleanup')).toBe(false)
  })

  test('post_pass phase matches #119 transitions', () => {
    const table = toTransitionTable(def)
    expect(table.post_pass).toEqual({
      pass_posted: 'post_pass',
      summary_posted: 'complete',
      timeout: 'cleanup',
      cancel: 'cancelled',
    })
  })

  test('owner_turn final_round routes to post_pass (not cleanup)', () => {
    const table = toTransitionTable(def)
    expect(table.owner_turn.final_round).toBe('post_pass')
  })
})

// ---------------------------------------------------------------------------
// Lens loading
// ---------------------------------------------------------------------------

describe('lens loading', () => {
  let readabilityLens: LensDef

  test('readability lens loads', async () => {
    readabilityLens = await loadLensDef(join(LENSES_DIR, 'readability.md'))
    expect(readabilityLens.lens).toBe('readability')
  })

  test('readability lens has alias "r"', () => {
    expect(readabilityLens.aliases).toEqual(['r'])
  })

  test('readability lens instructions match POST_PASS_INSTRUCTIONS', () => {
    const expected = [
      'Review purely for simplicity and readability. Correctness is settled — don\'t re-litigate it.',
      '',
      'The standard: code should be immediately understandable without comments.',
      'If something needs a comment to explain it, it should be rewritten instead.',
      '',
      'Flag:',
      '- Anything you have to read twice to understand',
      '- Indirection that obscures what\'s actually happening',
      '- Abstractions that make simple things look complex',
      '- Code that could be deleted without changing behavior',
      '- Inconsistency (same thing done two different ways)',
      '',
      'Do NOT suggest adding anything (comments, types, docs, error handling).',
      'Only suggest making things simpler, clearer, or shorter.',
    ].join('\n')
    expect(readabilityLens.instructions).toBe(expected)
  })

  test('security lens loads', async () => {
    const security = await loadLensDef(join(LENSES_DIR, 'security.md'))
    expect(security.lens).toBe('security')
    expect(security.aliases).toEqual([])
    expect(security.instructions).toContain('security vulnerabilities')
  })
})

// ---------------------------------------------------------------------------
// Protocol + lenses together
// ---------------------------------------------------------------------------

describe('loadProtocolWithLenses', () => {
  test('discovers all lenses and builds alias map', async () => {
    const { protocol, lenses } = await loadProtocolWithLenses(PROTOCOL_PATH, LENSES_DIR)
    expect(protocol.protocol).toBe('review')
    expect(lenses.has('readability')).toBe(true)
    expect(lenses.has('r')).toBe(true)
    expect(lenses.has('security')).toBe(true)
    expect(lenses.get('r')).toBe(lenses.get('readability'))
  })

  test('a malformed lens does not poison the good ones', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('fs')
    const tmpDir = join(import.meta.dir, '..', '..', 'protocols', 'lenses-test-tmp')
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'good.md'), [
      '# Good — lens', '', '## Instructions', '', 'Do good things.', '',
      '```yaml skeleton', 'lens: good', 'aliases: [g]', '```',
    ].join('\n'))
    writeFileSync(join(tmpDir, 'bad.md'), '# Bad\n\nno skeleton here at all')
    try {
      const { lenses } = await loadProtocolWithLenses(PROTOCOL_PATH, tmpDir)
      expect(lenses.has('good')).toBe(true)
      expect(lenses.has('g')).toBe(true)
      expect(lenses.get('good')!.instructions).toBe('Do good things.')
    } finally {
      rmSync(tmpDir, { recursive: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Validation — fail-closed on structural faults
// ---------------------------------------------------------------------------

describe('validation', () => {
  test('rejects missing skeleton block', () => {
    expect(() => parseProtocolDef('# No skeleton here')).toThrow('yaml skeleton block found')
  })

  test('rejects transition to unknown phase', () => {
    const bad = `# test
\`\`\`yaml skeleton
protocol: test
emoji: "🧪"
display_name: Test
roles:
  a: { label: A }
initial_phase: start
phases:
  start:
    actor: a
    on: { go: nonexistent }
  done: { terminal: true }
completion_event:
  protocol: test
  fields: [x]
\`\`\`
`
    expect(() => parseProtocolDef(bad)).toThrow('targets an unknown phase')
  })

  test('rejects terminal phase with transitions', () => {
    const bad = `# test
\`\`\`yaml skeleton
protocol: test
emoji: "🧪"
display_name: Test
roles:
  a: { label: A }
initial_phase: start
phases:
  start:
    actor: a
    terminal: true
    on: { go: start }
completion_event:
  protocol: test
  fields: [x]
\`\`\`
`
    expect(() => parseProtocolDef(bad)).toThrow('terminal but declares transitions')
  })

  test('rejects sentinel on phase with no actor', () => {
    const bad = `# test
\`\`\`yaml skeleton
protocol: test
emoji: "🧪"
display_name: Test
roles:
  a: { label: A }
initial_phase: start
phases:
  start:
    actor: a
    on: { go: end }
  end: { terminal: true }
sentinels:
  end: "[done]"
completion_event:
  protocol: test
  fields: [x]
\`\`\`
`
    expect(() => parseProtocolDef(bad)).toThrow('which has no actor')
  })

  test('rejects lens without Instructions section', () => {
    const bad = `# Bad lens
\`\`\`yaml skeleton
lens: bad
aliases: []
\`\`\`
`
    expect(() => parseLensDef(bad)).toThrow('missing ## Instructions section')
  })
})

// ---------------------------------------------------------------------------
// Build protocol — parity with build.ts
// ---------------------------------------------------------------------------

const BUILD_BUILDER_SENTINEL = '[builder→critic]'
const BUILD_CRITIC_SENTINEL = '[critic→builder]'
const BUILD_SUMMARY_SENTINEL = '[summary]'

const BUILD_CRITIC_TIMEOUT_MS = 20 * 60 * 1000
const BUILD_OWNER_TIMEOUT_MS = 30 * 60 * 1000
const BUILD_CLOSING_TIMEOUT_MS = 5 * 60 * 1000

let buildDef: ProtocolDef

test('the build protocol loads', async () => {
  buildDef = await loadProtocolDef(BUILD_PATH)
  expect(buildDef.protocol).toBe('build')
})

describe('parity with build.ts', () => {
  test('sentinel grammar matches the live constants', () => {
    expect(buildDef.sentinels.implementing).toBe(BUILD_BUILDER_SENTINEL)
    expect(buildDef.sentinels.reviewing).toBe(BUILD_CRITIC_SENTINEL)
    expect(buildDef.sentinels.closing).toBe(BUILD_SUMMARY_SENTINEL)
  })

  test('transition table matches buildMachine exactly', () => {
    const table = toTransitionTable(buildDef)
    for (const [phase, events] of Object.entries(table)) {
      for (const [event, target] of Object.entries(events)) {
        const result = buildMachine.transition(phase as any, event as any)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.to).toBe(target as any)
      }
      expect(new Set(buildMachine.validEvents(phase as any))).toEqual(new Set(Object.keys(events)))
    }
  })

  test('turn windows match the live timeout constants', () => {
    expect(windowMs(buildDef, 'reviewing')).toBe(BUILD_CRITIC_TIMEOUT_MS)
    expect(windowMs(buildDef, 'implementing')).toBe(BUILD_OWNER_TIMEOUT_MS)
    expect(windowMs(buildDef, 'closing')).toBe(BUILD_CLOSING_TIMEOUT_MS)
  })

  test('disconnect grace matches the live constants', () => {
    expect(graceMs(buildDef, 'critic')).toBe(30_000)
    expect(graceMs(buildDef, 'builder')).toBe(120_000)
  })

  test('buildHalf is derivable from the definition', () => {
    expect(buildDef.phases.implementing.half).toBe('top')
    expect(buildDef.phases.reviewing.half).toBe('bottom')
    expect(buildDef.phases.closing.half).toBe('top')
  })

  test('terminal phases match the machine', () => {
    expect(isTerminal(buildDef, 'complete')).toBe(true)
    expect(isTerminal(buildDef, 'cancelled')).toBe(true)
    expect(isTerminal(buildDef, 'implementing')).toBe(false)
    expect(isTerminal(buildDef, 'reviewing')).toBe(false)
    expect(isTerminal(buildDef, 'closing')).toBe(false)
  })

  test('reviewing has three outcome events (lgtm, final, feedback)', () => {
    const table = toTransitionTable(buildDef)
    expect(table.reviewing.critic_lgtm).toBe('closing')
    expect(table.reviewing.critic_final).toBe('closing')
    expect(table.reviewing.critic_feedback).toBe('implementing')
  })
})

// ---------------------------------------------------------------------------
// Spike protocol — structural validity (novel protocol, no TS parity)
// ---------------------------------------------------------------------------

let spikeDef: ProtocolDef

test('the spike protocol loads', async () => {
  spikeDef = await loadProtocolDef(SPIKE_PATH)
  expect(spikeDef.protocol).toBe('spike')
})

describe('spike protocol structure', () => {
  test('has two non-adversarial roles', () => {
    expect(Object.keys(spikeDef.roles)).toEqual(['explorer', 'guide'])
    expect(spikeDef.roles.explorer.label).toBe('The Explorer')
    expect(spikeDef.roles.guide.label).toBe('The Guide')
  })

  test('exploring phase loops on checkpoint', () => {
    const table = toTransitionTable(spikeDef)
    expect(table.exploring.checkpoint).toBe('exploring')
  })

  test('exploring transitions to reporting on wrap_up or timeout', () => {
    const table = toTransitionTable(spikeDef)
    expect(table.exploring.wrap_up).toBe('reporting')
    expect(table.exploring.timeout).toBe('reporting')
  })

  test('reporting completes on report_posted', () => {
    const table = toTransitionTable(spikeDef)
    expect(table.reporting.report_posted).toBe('complete')
  })

  test('sentinels match the expected checkpoint/report pattern', () => {
    expect(spikeDef.sentinels.exploring).toBe('[checkpoint]')
    expect(spikeDef.sentinels.reporting).toBe('[report]')
  })

  test('exploring has a long window (60m)', () => {
    expect(windowMs(spikeDef, 'exploring')).toBe(60 * 60 * 1000)
  })

  test('only explorer has disconnect grace', () => {
    expect(graceMs(spikeDef, 'explorer')).toBe(120_000)
    expect(graceMs(spikeDef, 'guide')).toBeUndefined()
  })

  test('all transitions target valid phases (referential integrity)', () => {
    const table = toTransitionTable(spikeDef)
    const phases = new Set(Object.keys(spikeDef.phases))
    for (const [, events] of Object.entries(table)) {
      for (const [, target] of Object.entries(events)) {
        expect(phases.has(target)).toBe(true)
      }
    }
  })

  test('completion event declares the right fields', () => {
    expect(spikeDef.completionEvent.protocol).toBe('spike')
    expect(spikeDef.completionEvent.fields).toContain('thread')
    expect(spikeDef.completionEvent.fields).toContain('topic')
    expect(spikeDef.completionEvent.fields).toContain('transcript')
  })
})
