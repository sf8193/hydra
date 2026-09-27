import { describe, expect, test } from 'bun:test'
import { startWithoutInstall } from '../plugin-manifest.js'

describe('startWithoutInstall', () => {
  test('drops the leading bun install from the published start script', () => {
    expect(startWithoutInstall('bun install --no-summary && bun server.ts')).toBe('bun server.ts')
    expect(startWithoutInstall('  bun install && bun bridge.ts')).toBe('bun bridge.ts')
  })

  test('leaves scripts without a leading install untouched', () => {
    expect(startWithoutInstall('bun server.ts')).toBe('bun server.ts')
    expect(startWithoutInstall('bun run build && bun install && bun server.ts')).toBe('bun run build && bun install && bun server.ts')
  })

  test('is idempotent', () => {
    const once = startWithoutInstall('bun install --no-summary && bun server.ts')
    expect(startWithoutInstall(once)).toBe(once)
  })
})

describe('ensureBridgeReady', () => {
  const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const { tmpdir } = require('os') as typeof import('os')
  const PUBLISHED = { name: 'discord', version: '1.2.3', dependencies: { ws: '^8' }, scripts: { start: 'bun install --no-summary && bun server.ts' } }
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'hydra-bridge-ready-'))
    writeFileSync(join(d, 'package.json'), JSON.stringify(PUBLISHED, null, 2))
    return d
  }
  const pkg = (d: string) => JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
  const okInstall = (calls: string[]) => async (cwd: string) => { calls.push(cwd); mkdirSync(join(cwd, 'node_modules'), { recursive: true }) }

  test('cold dir: installs once, writes the marker, lifts only the start script', async () => {
    const { ensureBridgeReady, DEPS_MARKER } = await import('../plugin-manifest.js')
    const d = dir(); const calls: string[] = []
    expect(await ensureBridgeReady(d, okInstall(calls))).toBe(true)
    expect(calls).toEqual([d])
    expect(existsSync(join(d, DEPS_MARKER))).toBe(true)
    expect(pkg(d)).toEqual({ ...PUBLISHED, scripts: { start: 'bun server.ts' } })
    expect(await ensureBridgeReady(d, okInstall(calls))).toBe(false)
    expect(calls).toHaveLength(1)
  })

  test('failed install: throws, leaves the published start script, no marker, retried next boot', async () => {
    const { ensureBridgeReady, DEPS_MARKER } = await import('../plugin-manifest.js')
    const d = dir()
    const failing = async (cwd: string) => { mkdirSync(join(cwd, 'node_modules'), { recursive: true }); throw new Error('ETIMEDOUT\nregistry unreachable') }
    await expect(ensureBridgeReady(d, failing)).rejects.toThrow('registry unreachable')
    expect(existsSync(join(d, DEPS_MARKER))).toBe(false)
    expect(pkg(d).scripts.start).toBe(PUBLISHED.scripts.start)
    const calls: string[] = []
    expect(await ensureBridgeReady(d, okInstall(calls))).toBe(true)   // partial node_modules does not count as done
    expect(calls).toEqual([d])
  })

  test('no package.json: skipped, nothing installed', async () => {
    const { ensureBridgeReady } = await import('../plugin-manifest.js')
    const d = mkdtempSync(join(tmpdir(), 'hydra-bridge-ready-'))
    const calls: string[] = []
    expect(await ensureBridgeReady(d, okInstall(calls))).toBe(false)
    expect(calls).toEqual([])
  })
})
