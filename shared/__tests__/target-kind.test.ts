// The one reader of a target value: main, specialist:<name>, thread:<id>, and the bare spellings that still read.
import { describe, expect, test } from 'bun:test'
import { bareOf, readTarget, refOfBare, spelled, spelledBare } from '../target-kind.js'

const declared = (n: string) => n === 'ops' || n === 'crm'
const read = (v: string) => readTarget(v, declared)

describe('readTarget', () => {
  test('each kind, prefixed: main has one spelling and is never bare', () => {
    expect(read('main')).toEqual({ ok: true, ref: { kind: 'main' }, bare: false })
    expect(read('specialist:ops')).toEqual({ ok: true, ref: { kind: 'specialist', name: 'ops' }, bare: false })
    expect(read('thread:1234')).toEqual({ ok: true, ref: { kind: 'thread', threadId: '1234' }, bare: false })
  })

  test('bare values read as the same target, flagged bare: a declared name is a specialist, all digits a thread', () => {
    expect(read('ops')).toEqual({ ok: true, ref: { kind: 'specialist', name: 'ops' }, bare: true })
    expect(read('1234')).toEqual({ ok: true, ref: { kind: 'thread', threadId: '1234' }, bare: true })
    expect(read('ops')).toMatchObject({ ref: (read('specialist:ops') as any).ref })
    expect(read('ghost')).toEqual({ ok: false, undeclared: 'ghost' })
    expect(read('specialist:ghost')).toEqual({ ok: false, undeclared: 'ghost' })
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
    const [main, ops, thread] = [read('main'), read('ops'), read('1234')].map(r => (r as any).ref)
    expect([main, ops, thread].map(spelled)).toEqual(['main', 'specialist:ops', 'thread:1234'])
    expect([main, ops, thread].map(bareOf)).toEqual(['main', 'ops', '1234'])
    expect([refOfBare('main'), refOfBare('ops'), refOfBare('1234')]).toEqual([main, ops, thread])
    expect(['main', 'ops', '1234'].map(spelledBare)).toEqual(['main', 'specialist:ops', 'thread:1234'])
  })
})
