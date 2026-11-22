import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { tomlNamesOperator } from '../lifecycle.js'

// The doctor's "no operator" warning: only a top-level operator key counts, as the loader reads it.
let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
const names = (toml: string | undefined) => {
  dir = mkdtempSync(join(tmpdir(), 'hydra-operator-check-'))
  const path = join(dir, 'hydra.toml')
  if (toml !== undefined) writeFileSync(path, toml)
  return tomlNamesOperator(path)
}

test('a top-level operator, however it is spaced, counts', () => {
  expect(names('operator = "op"\n')).toBe(true)
  expect(names('  operator\t= "op"\n[people.op]\naddresses = []\n')).toBe(true)
})

test('no file, a comment, an operator inside a table, or a file that does not parse, does not', () => {
  expect(names(undefined)).toBe(false)
  expect(names('# operator = "op"\n')).toBe(false)
  expect(names('[people.op]\noperator = "x"\n')).toBe(false)
  expect(names('operator = \n')).toBe(false)
})
