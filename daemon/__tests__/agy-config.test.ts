import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerHydraHooks, registerHydraTools } from '../engines/agy-config.js'

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

test('an empty file, as agy itself leaves mcp_config.json, gets the entries like a missing one', () => {
  const m = fresh(), h = fresh()
  for (const f of [m, h]) { registerHydraTools(f); writeFileSync(f, '') }
  registerHydraTools(m)
  registerHydraHooks(h)
  expect(read(m).mcpServers.hydra.args[0]).toEndWith('/daemon/codex-mcp-server.ts')
  expect(Object.keys(read(h).hydra)).toEqual(['SessionStart', 'PreInvocation', 'Stop'])
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

test('the hook group covers the session start, each model call and each stop, with this checkout\'s script; the operator\'s other groups are kept', () => {
  const f = fresh()
  registerHydraHooks(f)
  writeFileSync(f, JSON.stringify({ ...read(f), mine: { Stop: [{ command: 'echo' }] } }))
  registerHydraHooks(f)
  const { hydra, mine } = read(f)
  expect(Object.keys(hydra)).toEqual(['SessionStart', 'PreInvocation', 'Stop'])
  for (const [event, [handler]] of Object.entries<any>(hydra)) {
    expect(handler.type).toBe('command')
    expect(handler.command).toContain(`/daemon/agy-hook.ts' ${event}`)
  }
  expect(mine).toEqual({ Stop: [{ command: 'echo' }] })
})

test('a stale hook group is replaced, a right one is not rewritten, and a file that is not JSON is an error', () => {
  const f = fresh()
  registerHydraHooks(f)
  writeFileSync(f, JSON.stringify({ hydra: { Stop: [{ type: 'command', command: 'old' }] } }))
  registerHydraHooks(f)
  expect(read(f).hydra.Stop[0].command).not.toBe('old')
  const before = readFileSync(f, 'utf8')
  writeFileSync(f, before + '\n')
  registerHydraHooks(f)
  expect(readFileSync(f, 'utf8')).toBe(before + '\n')
  writeFileSync(f, '{ no')
  expect(() => registerHydraHooks(f)).toThrow()
})
