import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MCP_CONFIG, bridgeReadiness, isLinkedTo, syncBridgePlugin } from '../plugin-manifest.js'

const realReadiness = bridgeReadiness.run
afterEach(() => { bridgeReadiness.run = realReadiness })

function setup() {
  bridgeReadiness.run = async () => false
  const root = mkdtempSync(join(tmpdir(), 'hydra-bridge-sync-'))
  const bridgeSrc = join(root, 'repo', 'bridge.ts')
  mkdirSync(join(root, 'repo'), { recursive: true })
  writeFileSync(bridgeSrc, "import './shared/x.js'\n")
  const cacheDir = join(root, 'cache')
  mkdirSync(cacheDir)
  const sync = () => syncBridgePlugin({ bridgeSrc, cacheDir, platform: 'discord', daemonConfig: '{"socket":"/s"}' })
  return { bridgeSrc, cacheDir, sync }
}

describe('syncBridgePlugin', () => {
  test('replaces a copied server.ts with a link to bridge.ts (a copy cannot find ./shared/*)', () => {
    const { bridgeSrc, cacheDir, sync } = setup()
    const v = join(cacheDir, '0.0.5')
    mkdirSync(v)
    writeFileSync(join(v, 'server.ts'), readFileSync(bridgeSrc))
    expect(sync().relinked).toEqual([v])
    expect(lstatSync(join(v, 'server.ts')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(v, 'server.ts'))).toBe(bridgeSrc)
  })

  test('links a version dir that appeared after an earlier sync, and leaves an existing link alone', () => {
    const { bridgeSrc, cacheDir, sync } = setup()
    const old = join(cacheDir, '0.0.4')
    mkdirSync(old)
    symlinkSync(bridgeSrc, join(old, 'server.ts'))
    expect(sync().relinked).toEqual([])
    const added = join(cacheDir, '0.0.6')
    mkdirSync(added)
    const r = sync()
    expect(r.relinked).toEqual([added])
    expect(r.dirs.sort()).toEqual([old, added].sort())
    expect(isLinkedTo(join(added, 'server.ts'), bridgeSrc)).toBe(true)
    expect(isLinkedTo(join(old, 'server.ts'), bridgeSrc)).toBe(true)
  })

  test('relinks a link that points somewhere else, leaving no temp link behind', () => {
    const { bridgeSrc, cacheDir, sync } = setup()
    const v = join(cacheDir, '0.0.5')
    mkdirSync(v)
    symlinkSync('/nowhere/bridge.ts', join(v, 'server.ts'))
    expect(sync().relinked).toEqual([v])
    expect(isLinkedTo(join(v, 'server.ts'), bridgeSrc)).toBe(true)
    expect(require('fs').readdirSync(v).filter((n: string) => n.includes('hydra-link'))).toEqual([])
  })

  test('one dir failing does not stop the others', () => {
    const { bridgeSrc, cacheDir, sync } = setup()
    const broken = join(cacheDir, '0.0.4')
    mkdirSync(join(broken, 'server.ts', 'x'), { recursive: true }) // a non-empty directory: the link cannot replace it
    const good = join(cacheDir, '0.0.5')
    mkdirSync(good)
    const r = sync()
    expect(r.failed.map(f => f.dir)).toEqual([broken])
    expect(isLinkedTo(join(good, 'server.ts'), bridgeSrc)).toBe(true)
    expect(existsSync(join(good, '.mcp.json'))).toBe(true)
  })

  test('writes the daemon config, .mcp.json and the manifest into each dir; a second run writes nothing', () => {
    const { cacheDir, sync } = setup()
    const v = join(cacheDir, '0.0.5')
    mkdirSync(v)
    sync()
    expect(readFileSync(join(v, 'daemon-discord.json'), 'utf8')).toBe('{"socket":"/s"}')
    expect(readFileSync(join(v, '.mcp.json'), 'utf8')).toBe(MCP_CONFIG)
    expect(existsSync(join(v, '.claude-plugin', 'plugin.json'))).toBe(true)
    const before = lstatSync(join(v, '.mcp.json')).mtimeMs
    expect(sync().relinked).toEqual([])
    expect(lstatSync(join(v, '.mcp.json')).mtimeMs).toBe(before)
  })

  test('readiness runs once per dir at a time: a second sync while it runs shares it, and ready waits for it', async () => {
    const { cacheDir, sync } = setup()
    mkdirSync(join(cacheDir, '0.0.5'))
    let calls = 0
    let release!: () => void
    bridgeReadiness.run = () => { calls++; return new Promise(r => { release = () => r(true) }) }
    const first = sync()
    const second = sync()
    expect(calls).toBe(1)
    let settled = false
    void Promise.all([first.ready, second.ready]).then(() => { settled = true })
    await Bun.sleep(5)
    expect(settled).toBe(false)
    release()
    await Promise.all([first.ready, second.ready])
    expect(settled).toBe(true)
    sync()
    expect(calls).toBe(2) // finished: the next sync checks again
  })
})
