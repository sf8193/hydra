import { describe, test, expect } from 'bun:test'
import {
  INITIAL_PHASE, isLatchPhase, isReportTurn, latchVote, nextLatch, phaseForTurn, toolNamesFrom,
  USAGE_PHASES, type LatchPhase,
} from '../usage-phase.js'

describe('usage-phase: what a turn does with its tools', () => {
  test.each([
    [['Agent'], 'review'], [['Task'], 'review'],
    [['Edit'], 'execute'], [['Write'], 'execute'], [['NotebookEdit'], 'execute'],
  ])('%p latches to %s', (tools, phase) => {
    expect(nextLatch('plan', tools as string[])).toBe(phase as LatchPhase)
  })

  test('a turn that edits AND delegates is review, not execute', () => {
    expect(nextLatch('plan', ['Edit', 'Bash', 'Agent'])).toBe('review')
  })

  // The single most load-bearing behaviour: read-only work does not vote. A
  // reviewer greps all day, and letting Bash/Read mean `plan` is what put 98%
  // of real fleet spend into one bucket.
  test('read-only tools say nothing, so the latch is left alone', () => {
    expect(nextLatch('review', ['Bash', 'Read', 'Grep', 'WebFetch'])).toBe('review')
    expect(nextLatch('execute', ['Bash'])).toBe('execute')
    expect(nextLatch('execute', [])).toBe('execute')
  })

  // Without this, `nextLatch = (c) => c` passes every other test in this file.
  test('a voting turn MOVES the latch', () => {
    expect(nextLatch('plan', ['Agent'])).toBe('review')
    expect(nextLatch('review', ['Edit'])).toBe('execute')
  })

  // A caller handing back a corrupted latch must not reach phaseTotals[phase],
  // which is an unguarded dynamic index.
  test('an off-set latch is repaired, not carried', () => {
    expect(nextLatch('nonsense' as never, ['Bash'])).toBe(INITIAL_PHASE)
    expect(nextLatch('report' as never, ['Bash'])).toBe(INITIAL_PHASE)
  })
})

// The defect this shape exists to prevent, measured on four real transcripts:
// latching `report` billed runs of up to 135 consecutive Bash turns as "sending
// a message to a human", taking 45-83% of spend against the ledger's 17%.
describe('usage-phase: report is momentary, never latched', () => {
  test('replying bills the turn to report without moving the latch', () => {
    expect(phaseForTurn('execute', ['mcp__plugin_discord_discord__reply'])).toBe('report')
    expect(nextLatch('execute', ['mcp__plugin_discord_discord__reply'])).toBe('execute')
  })

  test('the turn after a reply goes back to the work, not to report', () => {
    let latch: LatchPhase = 'plan'
    const phases: string[] = []
    for (const tools of [['Edit'], ['mcp__x__reply'], ['Bash'], ['Bash'], ['Grep']]) {
      latch = nextLatch(latch, tools)
      phases.push(phaseForTurn(latch, tools))
    }
    expect(phases).toEqual(['execute', 'report', 'execute', 'execute', 'execute'])
  })

  // The regression in miniature: one reply followed by a long read-only run.
  test('a reply does not capture the whole run that follows it', () => {
    let latch: LatchPhase = nextLatch('plan', ['Agent'])
    const after = Array.from({ length: 135 }, () => {
      latch = nextLatch(latch, ['Bash'])
      return phaseForTurn(latch, ['Bash'])
    })
    expect(phaseForTurn(latch, ['reply'])).toBe('report')
    expect(new Set(after), '135 Bash turns, none of them reporting').toEqual(new Set(['review']))
  })

  test('nextLatch can never return report, whatever it is fed', () => {
    for (const tools of [['reply'], ['send_to_thread'], ['Agent'], ['Edit'], ['Bash'], []]) {
      expect(isLatchPhase(nextLatch('plan', tools))).toBe(true)
    }
  })

  // Both halves asserted separately: `every` is what makes a mixed turn not a
  // report, and the latch is what decides where it lands instead.
  test('a turn that edits AND replies is execute, and is not a report turn', () => {
    const tools = ['mcp__plugin_discord_discord__reply', 'Edit']
    expect(isReportTurn(tools), 'a non-egress tool disqualifies it').toBe(false)
    expect(phaseForTurn(nextLatch('plan', tools), tools)).toBe('execute')
  })

  test('report needs every tool to be chat egress, not just one', () => {
    expect(isReportTurn(['mcp__plugin_discord_discord__reply', 'Bash'])).toBe(false)
    expect(isReportTurn([])).toBe(false)
  })

  test.each([
    ['mcp__plugin_discord_discord__reply'], ['mcp__plugin_slack_slack__slack_send_message'],
    ['mcp__plugin_discord_discord__send_to_thread'], ['reply'], ['send_to_thread'],
    // advance posts the protocol deliverable to the thread verbatim — egress
    // with a phase transition attached, not a different kind of act.
    ['mcp__plugin_discord_discord__advance'],
  ])('%p is chat egress', (tool) => {
    expect(isReportTurn([tool])).toBe(true)
  })

  // set_description and react are housekeeping inside another phase's work;
  // edit_message is documented as an interim progress update DURING long work;
  // a draft is not sent to anyone.
  test.each([
    ['mcp__plugin_discord_discord__set_description'], ['react'],
    ['mcp__plugin_discord_discord__edit_message'], ['mcp__plugin_slack_slack__slack_send_message_draft'],
  ])('%p is not reporting', (tool) => {
    expect(isReportTurn([tool])).toBe(false)
    expect(phaseForTurn('execute', [tool])).toBe('execute')
  })

  // The name must be whole or MCP-prefixed. Without the boundary these all
  // match, and a future tool called noreply becomes chat egress silently.
  test.each([
    ['noreply'], ['auto_reply'], ['bulk_reply'], ['quick_advance'], ['x_slack_send_message'],
  ])('%p only resembles an egress tool', (tool) => {
    expect(isReportTurn([tool])).toBe(false)
  })

  test('every phase a turn can produce is in the closed set', () => {
    for (const tools of [['Agent'], ['Edit'], ['reply'], ['Bash'], []]) {
      expect(USAGE_PHASES as readonly string[]).toContain(phaseForTurn('plan', tools))
    }
    expect(USAGE_PHASES as readonly string[]).toContain(INITIAL_PHASE)
  })
})

describe('usage-phase: a vote is distinguishable from a carry', () => {
  test('latchVote reports only what the tools chose, never the carry', () => {
    expect(latchVote(['Agent'])).toBe('review')
    expect(latchVote(['Edit'])).toBe('execute')
    expect(latchVote(['Bash', 'Read'])).toBeUndefined()
    expect(latchVote([])).toBeUndefined()
  })

  // The structural reason `phaseSource: 'tools'` was a lie on plan rows: no
  // input can make the classifier choose it. It is only ever the seed.
  test('nothing can vote plan, so a plan row is always carried', () => {
    for (const tools of [['Agent'], ['Edit'], ['Bash'], ['reply'], ['Read', 'Grep'], []]) {
      expect(latchVote(tools), `${tools} must not vote plan`).not.toBe('plan')
    }
  })

  test('nextLatch is latchVote plus the carry, with no second opinion', () => {
    for (const tools of [['Agent'], ['Edit'], ['Bash'], []]) {
      expect(nextLatch('execute', tools)).toBe(latchVote(tools) ?? 'execute')
    }
  })
})

describe('usage-phase: reading tool names off a content array', () => {
  test('picks tool_use blocks and ignores the rest', () => {
    expect(toolNamesFrom([
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', name: 'Agent', input: { prompt: 'secret' } },
    ])).toEqual(['Agent'])
  })

  // mcp_tool_use and server_tool_use also carry a name, so the discriminator has
  // to be the type, not the presence of a name.
  test('a non-tool_use block carrying a name is ignored', () => {
    expect(toolNamesFrom([
      { type: 'text', text: 'hi', name: 'Agent' },
      { type: 'server_tool_use', name: 'Edit' },
      { type: 'mcp_tool_use', name: 'Write' },
    ])).toEqual([])
  })

  test('a malformed or absent content array yields nothing rather than throwing', () => {
    expect(toolNamesFrom(undefined)).toEqual([])
    expect(toolNamesFrom('not an array')).toEqual([])
    expect(toolNamesFrom([null, 7, { type: 'tool_use' }, { type: 'tool_use', name: 42 }])).toEqual([])
  })
})
