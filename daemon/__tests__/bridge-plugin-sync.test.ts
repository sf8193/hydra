import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MCP_CONFIG, isLinkedTo, syncBridgePlugin } from '../plugin-manifest.js'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hydra-bridge-sync-'))
  const bridgeSrc = join(root, 'repo', 'bridge.ts')
  mkdirSync(join(root, 'repo'), { recursive: true })
  writeFileSync(bridgeSrc, "import './shared/x.js'\n")
  const cacheDir = join(root, 'cache')
  mkdirSync(cacheDir)
  const sync = () => syncBridgePlugin({ bridgeSrc, cacheDir, platform: 'discord', daemonConfig: '{"socket":"/s"}', ready: async () => false })
  return { bridgeSrc, cacheDir, sync }
}

describe('syncBridgePlugin', () => {
  test('replaces a copied server.ts with a link to bridge.ts (Nov 18: a copy cannot find ./shared/*)', () => {
    const { bridgeSrc, cacheDir, sync } = setup()
    const v = join(cacheDir, '0.0.5')
    mkdirSync(v)
    writeFileSync(join(v, 'server.ts'), readFileSync(bridgeSrc))
    expect(sync()).toEqual([v])
    expect(lstatSync(join(v, 'server.ts')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(v, 'server.ts'))).toBe(bridgeSrc)
  })

  test('links a version dir that appeared after boot, and leaves an existing link alone', () => {
    const { bridgeSrc, cacheDir, sync } = setup()
    const old = join(cacheDir, '0.0.4')
    mkdirSync(old)
    symlinkSync(bridgeSrc, join(old, 'server.ts'))
    expect(sync()).toEqual([])
    const added = join(cacheDir, '0.0.6')
    mkdirSync(added)
    expect(sync()).toEqual([added])
    expect(isLinkedTo(join(added, 'server.ts'), bridgeSrc)).toBe(true)
    expect(isLinkedTo(join(old, 'server.ts'), bridgeSrc)).toBe(true)
  })

  test('relinks a link that points somewhere else', () => {
    const { bridgeSrc, cacheDir, sync } = setup()
    const v = join(cacheDir, '0.0.5')
    mkdirSync(v)
    symlinkSync('/nowhere/bridge.ts', join(v, 'server.ts'))
    expect(sync()).toEqual([v])
    expect(isLinkedTo(join(v, 'server.ts'), bridgeSrc)).toBe(true)
  })

  test('writes the daemon config, .mcp.json and the manifest into each dir; a second run changes nothing', () => {
    const { cacheDir, sync } = setup()
    const v = join(cacheDir, '0.0.5')
    mkdirSync(v)
    sync()
    expect(readFileSync(join(v, 'daemon-discord.json'), 'utf8')).toBe('{"socket":"/s"}')
    expect(readFileSync(join(v, '.mcp.json'), 'utf8')).toBe(MCP_CONFIG)
    expect(existsSync(join(v, '.claude-plugin', 'plugin.json'))).toBe(true)
    const before = lstatSync(join(v, '.mcp.json')).mtimeMs
    expect(sync()).toEqual([])
    expect(lstatSync(join(v, '.mcp.json')).mtimeMs).toBe(before)
  })
})
