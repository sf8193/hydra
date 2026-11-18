// A Specialist is restricted, write-confined, or neither: the type cannot hold a mix. Each `@ts-expect-error` below is a mix that
// `tsc --noEmit` (CI's zero gate) must reject; if the type ever lets one through, the directive is unused and tsc fails.
import { describe, expect, test } from 'bun:test'
import type { Specialist } from '../types.js'

const base = { id: 'ops', workdir: '/srv/ops', reachableBy: [], sessions: 'shared' as const, maxSessions: 20, renamedFrom: [] }

describe('Specialist is a union', () => {
  test('each kind on its own is a Specialist', () => {
    const kinds: Specialist[] = [
      { ...base, restricted: true, tools: ['Read'], mcpServerNames: [], sendsTo: ['desk'] },
      { ...base, restricted: false, canOnlyWriteTo: 'workdir', cannotRead: [], mcpServerNames: [], denyCommands: ['rm *'] },
      { ...base, restricted: false, handoffAt: 40 },
    ]
    expect(kinds.map(k => k.restricted)).toEqual([true, false, false])
  })

  test('tsc rejects a specialist that is restricted and write-confined', () => {
    const mixes: Specialist[] = [
      // @ts-expect-error restricted with can_only_write_to
      { ...base, restricted: true, tools: ['Read'], mcpServerNames: [], canOnlyWriteTo: 'workdir', cannotRead: [] },
      // @ts-expect-error restricted with cannot_read
      { ...base, restricted: true, tools: ['Read'], mcpServerNames: [], cannotRead: ['/x'] },
      // @ts-expect-error restricted with deny_commands
      { ...base, restricted: true, tools: ['Read'], mcpServerNames: [], denyCommands: ['rm *'] },
      // @ts-expect-error write-confined with sends_to, which only a restricted specialist has
      { ...base, restricted: false, canOnlyWriteTo: 'workdir', cannotRead: [], mcpServerNames: [], sendsTo: ['desk'] },
      // @ts-expect-error cannot_read without can_only_write_to
      { ...base, restricted: false, cannotRead: ['/x'] },
      // @ts-expect-error handoff_at on a restricted specialist: its session has no handoff tool
      { ...base, restricted: true, tools: ['Read'], mcpServerNames: [], handoffAt: 40 },
      // @ts-expect-error handoff_at on a write-confined specialist: its session has no handoff tool
      { ...base, restricted: false, canOnlyWriteTo: 'workdir', cannotRead: [], mcpServerNames: [], handoffAt: 40 },
    ]
    expect(mixes).toHaveLength(7)
  })
})
