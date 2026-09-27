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
