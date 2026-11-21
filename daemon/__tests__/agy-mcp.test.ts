import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerHydraTools } from '../engines/agy-mcp.js'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'agy-mcp-')), 'config', 'mcp_config.json')
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'))

test('a missing file gets the hydra entry: this checkout\'s tool server, run by the daemon\'s bun', () => {
  const f = fresh()
  registerHydraTools(f)
  const { command, args } = read(f).mcpServers.hydra
  expect(command).toBe(process.execPath)
  expect(args).toHaveLength(1)
  expect(args[0]).toEndWith('/daemon/codex-mcp-server.ts')
})

test('the operator\'s other servers and the hydra entry\'s other keys are kept; a stale hydra path is replaced', () => {
  const f = fresh(), first = fresh()
  registerHydraTools(first)
  registerHydraTools(f)   // makes the folder
  writeFileSync(f, JSON.stringify({ mcpServers: { fs: { command: 'npx' }, hydra: { command: process.execPath, args: ['/old/codex-mcp-server.ts'], disabled: false } } }))
  registerHydraTools(f)
  const { fs, hydra } = read(f).mcpServers
  expect(fs).toEqual({ command: 'npx' })
  expect(hydra.args).toEqual([read(first).mcpServers.hydra.args[0]])   // this checkout's path, not /old/...
  expect(hydra.disabled).toBe(false)
})

test('an entry already right is not rewritten', () => {
  const f = fresh()
  registerHydraTools(f)
  const before = readFileSync(f, 'utf8')
  writeFileSync(f, before + '\n')   // a trailing newline more: a rewrite would drop it
  registerHydraTools(f)
  expect(readFileSync(f, 'utf8')).toBe(before + '\n')
})

test('a file that is not JSON is an error, and is left as it was', () => {
  const f = fresh()
  registerHydraTools(f)
  writeFileSync(f, '{ not json')
  expect(() => registerHydraTools(f)).toThrow()
  expect(readFileSync(f, 'utf8')).toBe('{ not json')
})
