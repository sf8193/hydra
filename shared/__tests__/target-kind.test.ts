// The one reader of a target value: main, specialist:<name>, thread:<id>. A value without a kind is refused; the stored form reads through refOfBare.
import { describe, expect, test } from 'bun:test'
import { bareOf, readTarget, refOfBare, spelled, spelledBare, spelledTo } from '../target-kind.js'
import { isSessionThread } from '../specialist-name.js'

const declared = (n: string) => n === 'ops' || n === 'crm'
const read = (v: string) => readTarget(v, declared)

describe('readTarget', () => {
  test('each kind, prefixed', () => {
    expect(read('main')).toEqual({ ok: true, ref: { kind: 'main' } })
    expect(read('specialist:ops')).toEqual({ ok: true, ref: { kind: 'specialist', name: 'ops' } })
    expect(read('thread:1234')).toEqual({ ok: true, ref: { kind: 'thread', threadId: '1234' } })
    expect(read('specialist:ghost')).toEqual({ ok: false, undeclared: 'ghost' })
  })

  test('a value without a kind is refused, naming the forms', () => {
    for (const bare of ['ops', '1234', 'ghost']) expect(read(bare)).toEqual({ ok: false, error: `"${bare}" does not say its kind: a target is main, specialist:<name> or thread:<id>` })
  })

  test('a value that does not fit its kind says what is wrong', () => {
    expect((read('thread:12a') as any).error).toContain('a thread id is digits (Discord)')
    expect((read('specialist:main') as any).error).toContain('write "main"')
    expect((read('specialist:42') as any).error).toContain('write "thread:42"')
    const unknown = (read('team:ops') as any).error
    expect(unknown).toContain('"team:"')
    expect(unknown).toContain('main, specialist:<name> or thread:<id>')
    expect((read('main:ops') as any).error).toContain('not a kind of target')
  })

  test('the spellings: prefixed to write and print, bare as stored', () => {
    const [main, ops, thread] = [read('main'), read('specialist:ops'), read('thread:1234')].map(r => (r as any).ref)
    expect([main, ops, thread].map(spelled)).toEqual(['main', 'specialist:ops', 'thread:1234'])
    expect([main, ops, thread].map(bareOf)).toEqual(['main', 'ops', '1234'])
    expect([refOfBare('main'), refOfBare('ops'), refOfBare('1234')]).toEqual([main, ops, thread])
    expect(['main', 'ops', '1234'].map(spelledBare)).toEqual(['main', 'specialist:ops', 'thread:1234'])
  })
})

// A thread id is what the running gateway uses: digits on Discord, `<channel>:<ts>` on the Slack gateway.
describe('a Slack gateway thread id', () => {
  const slack = 'D0BE3RB4Y00:1792616731.235729'

  test('isSessionThread: both gateways\' ids, nothing else', () => {
    for (const id of ['1234', slack, 'C0ABC:1.2', 'G0ABC:1793732224.093059']) expect(isSessionThread(id)).toBe(true)
    for (const id of ['', 'ops', 'main', 'thread:1234', 'D0BE:', ':1.2', 'd0be:1.2', 'X0BE:1.2', 'D0BE:12', 'D0BE:1.2:3', 'specialist:ops']) expect(isSessionThread(id)).toBe(false)
  })

  test('thread:<channel>:<ts> reads as a thread, and spells back', () => {
    const r = read(`thread:${slack}`) as any
    expect(r).toEqual({ ok: true, ref: { kind: 'thread', threadId: slack } })
    expect(spelled(r.ref)).toBe(`thread:${slack}`)
    expect(bareOf(r.ref)).toBe(slack)
  })

  test('the stored form reads as a thread, never as a specialist', () => {
    expect(refOfBare(slack)).toEqual({ kind: 'thread', threadId: slack })
    expect(spelledBare(slack)).toBe(`thread:${slack}`)
    expect(spelledTo(slack)).toBe(`thread:${slack}`)
    expect(read(spelledTo(slack))).toEqual({ ok: true, ref: { kind: 'thread', threadId: slack } })
  })

  test('already spelled values pass through; a bare Slack id is not "already spelled"', () => {
    for (const v of ['main', 'specialist:ops', 'thread:1234', `thread:${slack}`]) expect(spelledTo(v)).toBe(v)
    expect(spelledTo('ops')).toBe('specialist:ops')
    expect(spelledTo('1234')).toBe('thread:1234')
  })

  test('the Slack id still needs its kind when typed', () => {
    expect((read(slack) as any).error).toContain('starts with "D0BE3RB4Y00:", which is not a kind of target')
    expect((read(`specialist:${slack}`) as any).error).toContain(`write "thread:${slack}"`)
  })
})
