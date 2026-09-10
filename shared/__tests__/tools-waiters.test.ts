import { describe, expect, it } from 'bun:test'

import { ToolsWaiterSet, type ToolsWaiter } from '../tools-waiters.js'

type Tools = string[]

function recordingWaiter(sink: Array<Tools | null>): ToolsWaiter<Tools> {
  return tools => sink.push(tools)
}

describe('ToolsWaiterSet', () => {
  it('settles every concurrent waiter from one reply — the regression', () => {
    // Two overlapping tools/list requests. Under the old single-slot resolver
    // the first was overwritten and never settled, hanging until Claude Code
    // timed it out.
    const set = new ToolsWaiterSet<Tools>()
    const first: Array<Tools | null> = []
    const second: Array<Tools | null> = []
    const firstWaiter = recordingWaiter(first)
    const secondWaiter = recordingWaiter(second)

    set.add(firstWaiter)
    set.add(secondWaiter)
    set.settleAll(['reply', 'tool'])

    expect(first).toEqual([['reply', 'tool']])
    expect(second).toEqual([['reply', 'tool']])
    expect(set.size).toBe(0)
  })

  it('does not settle a waiter twice when its timeout fires after the reply', () => {
    const set = new ToolsWaiterSet<Tools>()
    const seen: Array<Tools | null> = []
    const waiter = recordingWaiter(seen)

    set.add(waiter)
    set.settleAll(['tool'])
    expect(set.timeout(waiter)).toBe(false)

    expect(seen).toEqual([['tool']])
  })

  it('settles a waiter with null when its timeout wins', () => {
    const set = new ToolsWaiterSet<Tools>()
    const seen: Array<Tools | null> = []
    const waiter = recordingWaiter(seen)

    set.add(waiter)
    expect(set.timeout(waiter)).toBe(true)

    expect(seen).toEqual([null])
    expect(set.size).toBe(0)
  })

  it('times out one waiter without disturbing the others', () => {
    const set = new ToolsWaiterSet<Tools>()
    const early: Array<Tools | null> = []
    const late: Array<Tools | null> = []
    const earlyWaiter = recordingWaiter(early)
    const lateWaiter = recordingWaiter(late)

    set.add(earlyWaiter)
    set.add(lateWaiter)
    set.timeout(earlyWaiter)
    set.settleAll(['tool'])

    expect(early).toEqual([null])
    expect(late).toEqual([['tool']])
  })

  it('is a no-op when a reply arrives with nothing waiting', () => {
    const set = new ToolsWaiterSet<Tools>()
    expect(() => set.settleAll(['tool'])).not.toThrow()
    expect(set.size).toBe(0)
  })
})
