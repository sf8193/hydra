// Every Claude spawn relinks the bridge plugin and waits for its readiness before the tmux session starts:
// a plugin version Claude Code added since boot must not start a bridgeless session.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { bridgePluginCache, bridgeReadiness, isLinkedTo } from '../plugin-manifest.js'
import { claudeConfigDir } from '../../shared/constants.js'
import { withFakeTmux } from './fake-tmux.js'

const BRIDGE = join(import.meta.dir, '..', '..', 'bridge.ts')
const input = { sessionId: 'bs-s', tmuxName: 'bs-t', cwd: '/tmp', originalCwd: '/tmp', model: 'claude-opus-4-1', prompt: 'hi' }
const realReadiness = bridgeReadiness.run
afterEach(() => { bridgeReadiness.run = realReadiness })

test('a launch relinks a copied server.ts in a new plugin version dir, then waits for its readiness before creating the session', async () => {
  const fake = withFakeTmux() // its own CLAUDE_CONFIG_DIR: never the real plugin cache
  const dir = join(bridgePluginCache(claudeConfigDir()), '9.9.9')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'server.ts'), readFileSync(BRIDGE))
  let release!: () => void
  bridgeReadiness.run = () => new Promise(r => { release = () => r(false) })
  const write = process.stderr.write
  const lines: string[] = []
  process.stderr.write = ((s: string) => { lines.push(String(s)); return true }) as any
  try {
    const launch = new ClaudeEngine({} as any).launch(input)
    await Bun.sleep(20)
    expect(isLinkedTo(join(dir, 'server.ts'), BRIDGE)).toBe(true)
    expect(fake.calls().some(c => c.startsWith('new-session'))).toBe(false) // held until readiness settles
    release()
    await launch
    expect(fake.calls().some(c => c.startsWith('new-session'))).toBe(true)
    const log = lines.join('')
    expect(log).toContain(`daemon: spawn bs-t: relinked bridge server.ts in ${dir}`)
    expect(log.indexOf('relinked bridge server.ts')).toBeLessThan(log.indexOf('creating the tmux session'))
  } finally { process.stderr.write = write; fake.restore() }
})
