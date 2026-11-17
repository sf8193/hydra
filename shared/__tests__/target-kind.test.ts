// The one reader of a target value: main, specialist:<name>, thread:<id>. A value without a kind is refused; the stored form reads through refOfBare.
import { describe, expect, test } from 'bun:test'
import { bareOf, readTarget, refOfBare, spelled, spelledBare } from '../target-kind.js'

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
    expect((read('thread:12a') as any).error).toContain('a thread id is all digits')
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
