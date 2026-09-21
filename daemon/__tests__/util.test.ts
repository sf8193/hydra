import { describe, test, expect } from 'bun:test'
import { chunk, formatDuration, fallbackDescription, transformProtocolTag, formatSpawnLine, parseDuration, extractPhaseBudget, extractWorktreeTarget, parseSpawnTopic, safeEdit, resolveSpawnLabel } from '../util.js'
import { parseSessionLabel } from '../../shared/constants.js'
import { gateway } from '../config.js'

// Suppress stderr
process.stderr.write = (() => true) as any

// ---------------------------------------------------------------------------
// chunk()
// ---------------------------------------------------------------------------

describe('chunk', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello', 100, 'length')).toEqual(['hello'])
  })

  test('exact limit returns single chunk', () => {
    const text = 'a'.repeat(100)
    expect(chunk(text, 100, 'length')).toEqual([text])
  })

  test('length mode splits at limit boundary', () => {
    const text = 'a'.repeat(250)
    const result = chunk(text, 100, 'length')
    expect(result.length).toBe(3)
    expect(result[0].length).toBe(100)
    expect(result[1].length).toBe(100)
    expect(result[2].length).toBe(50)
  })

  test('newline mode prefers paragraph break', () => {
    const text = 'first paragraph\n\nsecond paragraph that is very long and keeps going'
    const result = chunk(text, 30, 'newline')
    // First chunk includes text up to the paragraph break point
    expect(result[0]).toContain('first paragraph')
    expect(result.length).toBeGreaterThan(1)
    // Second chunk should have the continuation
    expect(result.slice(1).join('')).toContain('second paragraph')
  })

  test('newline mode falls back to line break', () => {
    const text = 'line one\nline two\nline three is here'
    const result = chunk(text, 20, 'newline')
    expect(result.length).toBeGreaterThan(1)
  })

  test('newline mode splits long text without newlines', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve'
    const result = chunk(text, 30, 'newline')
    expect(result.length).toBeGreaterThan(1)
    // All content should be preserved
    expect(result.join('').replace(/\s+/g, ' ').trim()).toContain('one two three')
  })

  test('empty text returns single empty chunk', () => {
    expect(chunk('', 100, 'length')).toEqual([''])
  })

  test('all content preserved across chunks', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20)
    const result = chunk(text, 50, 'newline')
    const reassembled = result.join('')
    // Content should be preserved (minus stripped leading newlines between chunks)
    expect(reassembled.length).toBeLessThanOrEqual(text.length)
    expect(reassembled.length).toBeGreaterThan(text.length * 0.95)
  })
})

// ---------------------------------------------------------------------------
// chunk() — markdown mode
// ---------------------------------------------------------------------------

describe('chunk markdown mode', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello', 100, 'markdown')).toEqual(['hello'])
  })

  test('plain prose splits at paragraph boundaries', () => {
    const text = 'First paragraph here.\n\nSecond paragraph that continues on and on.'
    const result = chunk(text, 40, 'markdown')
    expect(result.length).toBeGreaterThan(1)
    expect(result[0]).toContain('First paragraph')
  })

  test('fence spanning a split is closed and reopened', () => {
    const code = 'x = 1\n'.repeat(30)
    const text = 'Before code:\n\n```python\n' + code + '```\n\nAfter code.'
    const result = chunk(text, 100, 'markdown')
    expect(result.length).toBeGreaterThan(1)

    for (const part of result) {
      const fences = (part.match(/^`{3,}/gm) ?? [])
      expect(fences.length % 2).toBe(0)
    }
  })

  test('fence language tag is preserved on reopen', () => {
    const code = 'line\n'.repeat(40)
    const text = '```typescript\n' + code + '```'
    const result = chunk(text, 100, 'markdown')
    expect(result.length).toBeGreaterThan(1)

    expect(result[0]).toMatch(/^```typescript/)
    expect(result[0]).toMatch(/```$/)

    for (let i = 1; i < result.length; i++) {
      expect(result[i]).toMatch(/^```typescript/)
      const fences = (result[i].match(/^`{3,}/gm) ?? [])
      expect(fences.length % 2).toBe(0)
    }
  })

  test('single code block exceeding limit is split with fence close/reopen', () => {
    const bigLine = 'x'.repeat(80)
    const code = (bigLine + '\n').repeat(40)
    const text = '```js\n' + code + '```'
    const result = chunk(text, 200, 'markdown')
    expect(result.length).toBeGreaterThan(1)

    for (const part of result) {
      const fences = (part.match(/^`{3,}/gm) ?? [])
      expect(fences.length % 2).toBe(0)
    }
  })

  test('table near boundary avoids mid-row splits when possible', () => {
    const header = '| Col A | Col B |\n|-------|-------|\n'
    const rows = '| data  | value |\n'.repeat(15)
    const text = 'Some intro text.\n\n' + header + rows + '\nAfter the table.'
    const result = chunk(text, 250, 'markdown')
    expect(result.length).toBeGreaterThan(1)
    expect(result[0]).toContain('Some intro text.')
    const firstChunkTableLines = result[0].split('\n').filter(l => l.startsWith('|'))
    for (const line of firstChunkTableLines) {
      expect(line).toMatch(/\|$/)
    }
  })

  test('plain prose unchanged when under limit', () => {
    const text = 'Just a simple message.'
    expect(chunk(text, 100, 'markdown')).toEqual([text])
  })

  test('content round-trips minus injected fence markers', () => {
    const code = 'const a = 1\nconst b = 2\n'.repeat(20)
    const text = 'Intro.\n\n```ts\n' + code + '```\n\nOutro paragraph.'
    const result = chunk(text, 150, 'markdown')
    const reassembled = result.join('\n')
    expect(reassembled).toContain('Intro.')
    expect(reassembled).toContain('Outro paragraph.')
    expect(reassembled).toContain('const a = 1')
    expect(reassembled).toContain('const b = 2')
  })

  test('multiple code blocks both handled', () => {
    const block1 = '```python\n' + 'print("hi")\n'.repeat(15) + '```'
    const block2 = '```ruby\n' + 'puts "hello"\n'.repeat(15) + '```'
    const text = block1 + '\n\nSome text.\n\n' + block2
    const result = chunk(text, 100, 'markdown')
    expect(result.length).toBeGreaterThan(1)

    for (const part of result) {
      const fences = (part.match(/^`{3,}/gm) ?? [])
      expect(fences.length % 2).toBe(0)
    }
  })

  test('does not infinite loop on long line inside fence', () => {
    const longLine = 'x'.repeat(2500)
    const text = '```python\n' + longLine + '\n```'
    const result = chunk(text, 2000, 'markdown')
    expect(result.length).toBeGreaterThan(1)
    const allXs = result.join('').replace(/[^x]/g, '')
    expect(allXs.length).toBe(2500)
  })

  test('chunks do not exceed the limit', () => {
    const code = 'line of code here\n'.repeat(150)
    const text = '```ts\n' + code + '```'
    const result = chunk(text, 200, 'markdown')
    for (const part of result) {
      expect(part.length).toBeLessThanOrEqual(200)
    }
  })

  test('does not hang with very small limit', () => {
    const text = '```python\nhello world\n```'
    const result = chunk(text, 15, 'markdown')
    expect(result.length).toBeGreaterThan(1)
    expect(result.join('')).toContain('hello world')
  })

  test('legacy modes still work', () => {
    const text = 'a'.repeat(250)
    expect(chunk(text, 100, 'length').length).toBe(3)

    const text2 = 'word '.repeat(50)
    const result = chunk(text2, 30, 'newline')
    expect(result.length).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// formatDuration()
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  test('minutes only', () => {
    expect(formatDuration(5 * 60_000)).toBe('5m')
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(59 * 60_000)).toBe('59m')
  })

  test('hours and minutes', () => {
    expect(formatDuration(90 * 60_000)).toBe('1h 30m')
    expect(formatDuration(60 * 60_000)).toBe('1h')
    expect(formatDuration(23 * 60 * 60_000)).toBe('23h')
  })

  test('days and hours', () => {
    expect(formatDuration(25 * 60 * 60_000)).toBe('1d 1h')
    expect(formatDuration(48 * 60 * 60_000)).toBe('2d')
    expect(formatDuration(49 * 60 * 60_000)).toBe('2d 1h')
  })
})

// ---------------------------------------------------------------------------
// fallbackDescription()
// ---------------------------------------------------------------------------

describe('fallbackDescription', () => {
  test('strips leading slash command', () => {
    expect(fallbackDescription('/spawn some topic')).toBe('some topic')
  })

  test('uses first line only', () => {
    expect(fallbackDescription('first line\nsecond line')).toBe('first line')
  })

  test('truncates long descriptions', () => {
    const long = 'a'.repeat(150)
    const result = fallbackDescription(long)
    expect(result.length).toBe(100)
    expect(result.endsWith('...')).toBe(true)
  })

  test('short description passes through', () => {
    expect(fallbackDescription('hello world')).toBe('hello world')
  })

  test('empty string', () => {
    expect(fallbackDescription('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// formatSpawnLine()
// ---------------------------------------------------------------------------

describe('formatSpawnLine', () => {
  test('role spawn with initiator', () => {
    expect(formatSpawnLine({ roleLabel: 'critic', emoji: '🌊', name: 'drift', model: 'claude-x', trigger: 'review', initiator: 'dan' }))
      .toBe('> ⚡ spawned [ The Critic • 🌊 drift ] · model `claude-x` · by review from dan')
  })

  test('plain spawn without role', () => {
    expect(formatSpawnLine({ emoji: '🟦', name: 'pixel', model: 'claude-x', trigger: 'spawn:', initiator: 'dan' }))
      .toBe('> ⚡ spawned [ 🟦 pixel ] · model `claude-x` · by spawn: from dan')
  })

  test('no initiator omits from-clause; multiword role title-cases', () => {
    expect(formatSpawnLine({ roleLabel: 'contract-lawyer', emoji: '🗺️', name: 'atlas', model: 'm', trigger: 'design' }))
      .toBe('> ⚡ spawned [ The Contract-Lawyer • 🗺️ atlas ] · model `m` · by design')
  })
})
// parseDuration() / extractPhaseBudget()
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  test('parses s/m/h units', () => {
    expect(parseDuration('90s')).toBe(90_000)
    expect(parseDuration('20m')).toBe(1_200_000)
    expect(parseDuration('1h')).toBe(3_600_000)
  })

  test('rejects garbage', () => {
    expect(parseDuration('banana')).toBeNull()
    expect(parseDuration('20')).toBeNull()
    expect(parseDuration('m20')).toBeNull()
    expect(parseDuration('')).toBeNull()
  })

  test('rejects zero and setTimeout-overflowing values', () => {
    expect(parseDuration('0m')).toBeNull()
    expect(parseDuration('0s')).toBeNull()
    expect(parseDuration('25h')).toBeNull()
    expect(parseDuration('999999h')).toBeNull()
    expect(parseDuration('24h')).toBe(86_400_000)
  })
})

describe('extractPhaseBudget', () => {
  test('strips the flag and returns ms', () => {
    expect(extractPhaseBudget('fix the bug --phase-budget 20m off main'))
      .toEqual({ topic: 'fix the bug off main', budgetMs: 1_200_000 })
  })

  test('flag at start and equals form', () => {
    expect(extractPhaseBudget('--phase-budget 90s quick check'))
      .toEqual({ topic: 'quick check', budgetMs: 90_000 })
    expect(extractPhaseBudget('audit logs --phase-budget=1h'))
      .toEqual({ topic: 'audit logs', budgetMs: 3_600_000 })
  })

  test('no flag → topic unchanged', () => {
    expect(extractPhaseBudget('plain topic')).toEqual({ topic: 'plain topic' })
  })

  test('unparseable duration stays in the topic (visible, not swallowed)', () => {
    expect(extractPhaseBudget('task --phase-budget banana'))
      .toEqual({ topic: 'task --phase-budget banana' })
  })
})
// transformProtocolTag()
// ---------------------------------------------------------------------------

describe('transformProtocolTag', () => {
  test('routing tag is stripped, content preserved', () => {
    expect(transformProtocolTag('[critic→owner]\nFinding 1: bug'))
      .toBe('Finding 1: bug')
  })

  test('routing tag with content on same line', () => {
    expect(transformProtocolTag('[builder→critic] done with round'))
      .toBe('done with round')
  })

  test('body-less routing tag returns original text', () => {
    expect(transformProtocolTag('[critic→owner]'))
      .toBe('[critic→owner]')
  })

  test('[summary] passes through (stripping handled in bridge-dispatch)', () => {
    expect(transformProtocolTag('[summary]\nAll good.')).toBe('[summary]\nAll good.')
  })

  test('other move sentinels without an arrow are untouched', () => {
    expect(transformProtocolTag('[done]')).toBe('[done]')
  })

  test('free-form posts are untouched', () => {
    expect(transformProtocolTag('just chatting here')).toBe('just chatting here')
  })
})

// ---------------------------------------------------------------------------
// safeEdit()
// ---------------------------------------------------------------------------
//
// The failure classification is the point. Collapsing every failure into "the
// message is gone" is what retires a live auto-refreshing display on the first
// rate-limit, and an unbounded edit is what makes the platform reject it.

describe('safeEdit', () => {
  const origEdit = gateway.edit

  function stubEdit(impl: (channelId: string, messageId: string, text: string) => Promise<string>): void {
    ;(gateway as any).edit = impl
  }
  function restore(): void {
    ;(gateway as any).edit = origEdit
  }

  test('passes text through untouched when it fits', async () => {
    let seen = ''
    stubEdit(async (_c, _m, text) => { seen = text; return 'm1' })
    expect(await safeEdit('c', 'm1', 'still here')).toBe('ok')
    expect(seen).toBe('still here')
    restore()
  })

  test('truncates rather than letting the platform reject the whole edit', async () => {
    let seen = ''
    stubEdit(async (_c, _m, text) => { seen = text; return 'm1' })
    expect(await safeEdit('c', 'm1', 'x'.repeat(gateway.maxMessageLength + 500))).toBe('ok')
    expect(seen.length).toBeLessThanOrEqual(gateway.maxMessageLength)
    expect(seen).toEndWith('_…truncated_')
    restore()
  })

  test('a missing message is distinguished from a failed call', async () => {
    stubEdit(async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }) })
    expect(await safeEdit('c', 'm1', 'hi')).toBe('message-gone')

    stubEdit(async () => { throw { data: { error: 'message_not_found' } } })
    expect(await safeEdit('c', 'm1', 'hi')).toBe('message-gone')
    restore()
  })

  test('a missing channel is its own answer — there is nowhere to re-post', async () => {
    stubEdit(async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }) })
    expect(await safeEdit('c', 'm1', 'hi')).toBe('channel-gone')

    stubEdit(async () => { throw { data: { error: 'channel_not_found' } } })
    expect(await safeEdit('c', 'm1', 'hi')).toBe('channel-gone')
    restore()
  })

  test('everything else is transient, so the caller keeps its message', async () => {
    for (const err of [
      Object.assign(new Error('rate limited'), { code: 429 }),
      Object.assign(new Error('Missing Permissions'), { code: 50013 }),
      Object.assign(new Error('Invalid Form Body'), { code: 50035 }),
      new Error('socket hang up'),
    ]) {
      stubEdit(async () => { throw err })
      expect(await safeEdit('c', 'm1', 'hi')).toBe('failed')
    }
    restore()
  })
})

describe('extractWorktreeTarget', () => {
  test.each([
    ['wt:hydra fix the bug', 'hydra', 'fix the bug'],
    ['worktree:nova ship it', 'nova', 'ship it'],
  ])('%p yields worktree %p and topic %p', (input, worktree, topic) => {
    expect(extractWorktreeTarget(input)).toEqual({ worktree, topic })
  })

  // The regression: the label flag used to be stripped upstream, leaving
  // "wt:hydra", which needed trailing whitespace to match — so the worktree
  // vanished and the session ran against the main checkout.
  test('a bare prefix still yields the worktree, so a label-only topic cannot drop it', () => {
    expect(extractWorktreeTarget('wt:hydra')).toEqual({ worktree: 'hydra', topic: '' })
  })

  test('the worktree survives a topic that is nothing but a label flag', () => {
    const wt = extractWorktreeTarget('wt:hydra --review')
    expect(wt.worktree).toBe('hydra')
    expect(parseSessionLabel(wt.topic)).toEqual({ label: 'review', topic: '' })
  })

  test.each(['fix the bug', 'notwt:hydra thing', ''])('%p has no worktree prefix', (input) => {
    expect(extractWorktreeTarget(input)).toEqual({ topic: input })
  })
})

describe('parseSpawnTopic', () => {
  // The order is the whole point: the worktree prefix is ^-anchored, so a flag
  // sitting in front of it used to make the worktree vanish and the session run
  // against the main checkout. Both positions must work.
  test.each([
    ['wt:hydra --review', 'hydra', 'review', 'session'],
    ['--review wt:hydra fix the bug', 'hydra', 'review', 'fix the bug'],
    ['wt:hydra fix the bug --build', 'hydra', 'build', 'fix the bug'],
    ['--investigate worktree:nova ship it', 'nova', 'investigate', 'ship it'],
    // Hidden from the first pass by the prefix; without the second pass the
    // flag leaks into the prompt and the label is lost.
    ['wt:hydra --review fix the bug', 'hydra', 'review', 'fix the bug'],
    ['--phase-budget 30m wt:hydra fix', 'hydra', undefined, 'fix'],
  ] as const)('%p keeps the worktree and the label', (input, worktree, label, topic) => {
    const p = parseSpawnTopic(input)
    expect(p.worktree).toBe(worktree)
    expect(p.label).toBe(label)
    expect(p.topic || 'session').toBe(topic)
  })

  test('a phase budget survives alongside a label and a worktree', () => {
    const p = parseSpawnTopic('wt:hydra --phase-budget 30m go --review')
    expect(p.worktree).toBe('hydra')
    expect(p.label).toBe('review')
    expect(p.budgetMs).toBe(30 * 60_000)
    expect(p.topic).toBe('go')
  })

  test('an ordinary topic passes through untouched', () => {
    expect(parseSpawnTopic('fix the bug')).toEqual({ topic: 'fix the bug', worktree: undefined, label: undefined, budgetMs: undefined })
  })

  // The topic becomes the session's prompt.
  test('a flag inside prose is not treated as a label', () => {
    const p = parseSpawnTopic('compare --review and --build modes')
    expect(p.label).toBeUndefined()
    expect(p.topic).toBe('compare --review and --build modes')
  })
})

// Which end wins when a label sits on both sides of the worktree prefix. Not a
// supported form, but the tie-break decides the cost bucket, so pin it.
test('a label before the worktree prefix beats one after it', () => {
  expect(parseSpawnTopic('--review wt:hydra --build x').label).toBe('review')
  expect(parseSpawnTopic('wt:hydra --build x').label).toBe('build')
})

// The whole cost-bucket rule: opts, then the topic's flag, then what a parent
// or dead predecessor handed down. Production and the test harness both call
// this one function — when the harness had its own copy, every label test
// proved the copy and the real rule was free to break.
describe('resolveSpawnLabel', () => {
  test('a flag typed on the topic becomes the bucket', () => {
    expect(resolveSpawnLabel('--review fix the parser')).toEqual({ label: 'review' })
    expect(resolveSpawnLabel('fix the parser --build')).toEqual({ label: 'build' })
  })

  test('opts alone works when the topic names nothing', () => {
    expect(resolveSpawnLabel('fix it', 'investigate')).toEqual({ label: 'investigate' })
  })

  test('an inherited bucket is used when nothing else names one', () => {
    expect(resolveSpawnLabel('fix the bug', undefined, 'review')).toEqual({ label: 'review' })
  })

  test('an explicit opts label beats the topic flag', () => {
    expect(resolveSpawnLabel('--review fix it', 'build')).toEqual({ label: 'build' })
  })

  test('an explicit opts label beats an inherited bucket', () => {
    expect(resolveSpawnLabel('fix it', 'build', 'review')).toEqual({ label: 'build' })
  })

  test('a topic flag beats an inherited bucket', () => {
    expect(resolveSpawnLabel('--build fix the bug', undefined, 'review')).toEqual({ label: 'build' })
    expect(resolveSpawnLabel('wt:hydra --build x', undefined, 'review')).toEqual({ label: 'build' })
  })

  // The factory case: the builder's topic is `factory-builder: <spec>`, so a
  // `--build` the operator typed at the end of the spec outranks the PM's
  // bucket. One typed at the front of the spec sits mid-string behind the
  // prefix, where the grammar does not look, and the PM's bucket still wins.
  test("a flag at the end of a factory spec beats the PM's bucket", () => {
    expect(resolveSpawnLabel('factory-builder: wire up the CSV export --build', undefined, 'review')).toEqual({ label: 'build' })
    expect(resolveSpawnLabel('factory-builder: --build wire up the CSV export', undefined, 'review')).toEqual({ label: 'review' })
  })

  test('opts wins over both of the others', () => {
    expect(resolveSpawnLabel('--build fix it', 'investigate', 'review')).toEqual({ label: 'investigate' })
  })

  // Spread into a SessionInfo literal, so the key has to be absent rather than
  // present-and-undefined — the latter serialises into sessions.json.
  test('with nothing naming a bucket, the key is absent, not undefined', () => {
    const fields = resolveSpawnLabel('fix the parser')
    expect(fields).toEqual({})
    expect('label' in fields).toBe(false)
    expect(JSON.stringify({ ...fields })).toBe('{}')
    expect('label' in resolveSpawnLabel('fix the parser', undefined, undefined)).toBe(false)
  })

  // The flag grammar composes with the other prefixes the topic can carry.
  test('it sees through a worktree prefix and a phase budget', () => {
    expect(resolveSpawnLabel('wt:hydra --review audit the gate')).toEqual({ label: 'review' })
    expect(resolveSpawnLabel('--phase-budget=5m --build ship it')).toEqual({ label: 'build' })
  })

  // Prose must survive: the topic is the instruction the session is given.
  test('a label word in the middle of prose is not a flag', () => {
    expect(resolveSpawnLabel('compare --review and --build modes')).toEqual({})
    expect(resolveSpawnLabel('compare --review and --build modes', undefined, 'investigate')).toEqual({ label: 'investigate' })
  })
})
