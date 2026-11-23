import { describe, expect, test } from 'bun:test'
import { hearsApp } from '../hears.js'
import type { Person } from '../types.js'

const person = (id: string, ...addresses: Person['addresses']): Person => ({ id, addresses, roles: [] })
const people = { op: person('op', 'slack:UOP', 'discord:1'), dan: person('dan', 'slack:U1', 'discord:9'), peer: person('peer', 'slack:UPEER') }

describe('hearsApp', () => {
  test("an app a [people] entry holds is heard, by any of that person's addresses", () => {
    expect(hearsApp(people, 'op', 'slack:UPEER')).toBe(true)
    expect(hearsApp(people, 'op', 'discord:9')).toBe(true)
  })
  test('an app no entry holds is not heard, nor one on another platform, nor one with no address', () => {
    expect(hearsApp(people, 'op', 'slack:UNOBODY')).toBe(false)
    expect(hearsApp(people, 'op', 'discord:UPEER')).toBe(false)
    expect(hearsApp(people, 'op', undefined)).toBe(false)
    expect(hearsApp({}, undefined, 'slack:UPEER')).toBe(false)
  })
  test("never the operator's entry: an app message under the operator's address gets no operator standing", () => {
    expect(hearsApp(people, 'op', 'slack:UOP')).toBe(false)
    expect(hearsApp(people, 'op', 'discord:1')).toBe(false)
    expect(hearsApp(people, undefined, 'slack:UOP')).toBe(true)   // with no operator named, nobody's entry is the operator's
  })
})
