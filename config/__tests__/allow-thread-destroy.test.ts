// `[threads] allow_destroy`: whether a thread whose session has ended may be deleted by its id. Off unless it says true.
import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import { testLoadEnv } from './load-env.js'

const load = (text: string) => loadHydraConfig(text, testLoadEnv())
const errorsOf = (text: string): string[] => {
  const r = load(text)
  if (r.ok) throw new Error('expected the load to fail')
  return r.errors.map(e => `${e.path}: ${e.message}`)
}

describe('[threads] allow_destroy', () => {
  test('true loads', () => {
    const r = load('[threads]\nallow_destroy = true\n')
    if (!r.ok) throw new Error(r.errors.map(e => `${e.path}: ${e.message}`).join('\n'))
    expect(r.config.allowThreadDestroy).toBe(true)
    expect(r.warnings).toEqual([])
  })
  test('absent, false, or an empty table: off', () => {
    for (const text of ['', '[threads]\n', '[threads]\nallow_destroy = false\n']) {
      const r = load(text)
      expect(r.ok && r.config.allowThreadDestroy).toBeUndefined()
    }
  })
  test('needs no operator: it says what a command may do, not who reaches what', () => {
    expect(load('[threads]\nallow_destroy = true\n').ok).toBe(true)
  })
  test('a value that is not a boolean is an error that names the key', () => {
    expect(errorsOf('[threads]\nallow_destroy = "yes"\n')).toEqual([expect.stringContaining('threads.allow_destroy')])
  })
  test('an unknown key stays an error', () => {
    expect(errorsOf('[threads]\nallow_destory = true\n')).toEqual(['threads.allow_destory: unknown key "allow_destory"'])
  })
})
