import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CodexEngineAdapter } from '../../engines/codex-engine-adapter.js'
import { parseContextPercent } from '../../infra/util.js'
import { CACHE_HANDOFF_LINE, CONTEXT_ALERT_LINES, FULL_HANDOFF_DEFAULT_LINE } from '../context-lines.js'
import { withFakeTmux, type FakeTmux } from './fake-tmux.js'
import type { SessionInfo } from '../sessions.js'

const RULE = '─'.repeat(40)
const footer = (line: string, conversation = '⏺ done') => `${conversation}\n${RULE}\n❯ \n${RULE}\n  ${line}\n`

describe('the footer regex on misparse cases', () => {
  test.each([
    ['88% is 88, not 8', 'ctx: 88%', 88],
    ['8% is 8, not 88', 'ctx: 8%', 8],
    ['100%', 'ctx:100%', 100],
    ['a decimal rounds', 'ctx: 8.5%', 9],
    ['a prefixed label is not the label', 'pctx: 40%', null],
    ['no percent sign is no reading', 'ctx: 88', null],
    ['a token count is not a percent', 'ctx: 1.2k', null],
    ['a thousands separator is not a percent', 'ctx: 1,200%', null],
    ['the auto-compact line counts remaining', 'Context left until auto-compact: 12%', null],
  ])('%s', (_n, line, want) => {
    expect(parseContextPercent(footer(line))).toBe(want)
  })
  test('a percent above the input rule is conversation, never the footer', () => {
    expect(parseContextPercent(footer('no label', '⏺ ctx: 88% was the figure quoted'))).toBeNull()
  })
})

describe('Codex usage: structured first, the pane regex only as the fallback', () => {
  let tmux: FakeTmux
  beforeEach(() => { tmux = withFakeTmux() })
  afterEach(() => { tmux.restore() })
  const adapter = new CodexEngineAdapter({} as never)
  const info = (extra: Record<string, unknown> = {}) => ({ sessionId: 's', tmuxName: 'cx-ctx', ...extra }) as unknown as SessionInfo

  test('the runtime\'s context usage wins over whatever the pane says', () => {
    tmux.pane('cx-ctx:hydra-chat', footer('ctx: 88%'))
    expect(adapter.usage(info({ contextUsage: { usedTokens: 20, contextWindow: 100, percent: 20, updatedAt: 1 } }))).toEqual({ usedTokens: 20, contextWindow: 100, percent: 20 })
  })
  test('without it, the pane\'s ctx label is read whole (88, not 8)', () => {
    tmux.pane('cx-ctx:hydra-chat', footer('ctx: 88%'))
    expect(adapter.usage(info())?.percent).toBe(88)
  })
  test('without it, a stray conversation percent or the auto-compact line is no reading', () => {
    tmux.pane('cx-ctx:hydra-chat', footer('Context left until auto-compact: 8%', '⏺ sales up 34%'))
    expect(adapter.usage(info())).toBeNull()
  })
})

describe('the context lines have one home', () => {
  test('the numbers docs/handoff.md lists are the constants the daemon uses', () => {
    const doc = readFileSync(join(import.meta.dir, '../../docs/handoff.md'), 'utf8')
    const section = doc.slice(doc.indexOf('## Context lines'), doc.indexOf('## Automatic handoff'))
    expect(section).toContain(`| Alert | ${CONTEXT_ALERT_LINES.join('% and ')}% |`)
    expect(section).toContain(`off; ${CACHE_HANDOFF_LINE}%, idle 50 min`)
    expect(section).toContain(`off; ${FULL_HANDOFF_DEFAULT_LINE}% |`)
  })
})
