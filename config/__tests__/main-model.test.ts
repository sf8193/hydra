// `[main] model`: the model main (the operator's harness) launches with, said in hydra.toml as a specialist's `model` is.
import { describe, test, expect } from 'bun:test'
import { loadHydraConfig } from '../load.js'
import { testLoadEnv } from './load-env.js'

const load = (text: string) => loadHydraConfig(text, testLoadEnv())
const errorsOf = (text: string): string[] => {
  const r = load(text)
  if (r.ok) throw new Error('expected the load to fail')
  return r.errors.map(e => `${e.path}: ${e.message}`)
}

describe('[main]', () => {
  test('model loads as written, as a specialist\'s model does: an alias resolves when main starts', () => {
    const r = load('[main]\nmodel = "opus"\n')
    if (!r.ok) throw new Error(r.errors.map(e => `${e.path}: ${e.message}`).join('\n'))
    expect(r.config.main).toEqual({ model: 'opus' })
    expect(r.warnings).toEqual([])
  })
  test('needs no operator: it says how main runs, not who reaches it', () => {
    expect(load('[main]\nmodel = "claude-opus-5-5[1m]"\n').ok).toBe(true)
  })
  test('absent, or with no model: no main in the config', () => {
    const none = load('')
    const empty = load('[main]\n')
    expect(none.ok && none.config.main).toBeUndefined()
    expect(empty.ok && empty.config.main).toBeUndefined()
  })
  test('an unknown key or a non-string model is an error', () => {
    expect(errorsOf('[main]\nmodle = "opus"\n')).toEqual(['main.modle: unknown key "modle"'])
    expect(errorsOf('[main]\nmodel = 5\n')).toEqual(['main.model: must be a non-empty string'])
    expect(errorsOf('main = "opus"\n')).toEqual(['main: must be a table'])
  })
})
