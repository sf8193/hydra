// Claude Code's needs-auth cache (<config>/mcp-needs-auth-cache.json) silently keeps a
// listed MCP server out of every process that shares the config dir. The Claude adapter
// removes the bridge's own key before each launch, and nothing else (claude-needs-auth.ts).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearNeedsAuthEntry, describeSetAt, NEEDS_AUTH_CACHE_FILE, NEEDS_AUTH_CLEARED_NOTE } from '../engines/claude-needs-auth.js'
import { BRIDGE_CHANNEL_FLAG, BRIDGE_MCP_SERVER_KEY, MCP_CONFIG, PLUGIN_MANIFEST } from '../plugin-manifest.js'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { claudeConfigDir } from '../../shared/constants.js'
import { withFakeTmux } from './fake-tmux.js'

const KEY = 'plugin:discord:discord'
const OTHERS = {
  'claude.ai AngelList - Sentry': { timestamp: 1791571486280, id: 'mcpsrv_01PgZtRogagA69WZYJ5x5wgV' },
  'plugin:slack:slack': { timestamp: 1791576000000, id: 'x', extra: { nested: [1, 'two', null] } },
}

let dir: string
const cacheFile = () => join(dir, NEEDS_AUTH_CACHE_FILE)
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'needs-auth-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('clearNeedsAuthEntry', () => {
  test("removes only the bridge's key; every other entry survives value for value", async () => {
    writeFileSync(cacheFile(), JSON.stringify({ ...OTHERS, [KEY]: { timestamp: 1791576070588, id: 'bb69023a1ae1314e' } }))
    chmodSync(cacheFile(), 0o644)
    expect(await clearNeedsAuthEntry(KEY, dir)).toEqual({ key: KEY, setAt: 1791576070588 })
    expect(JSON.parse(readFileSync(cacheFile(), 'utf8'))).toEqual(OTHERS)
    expect(statSync(cacheFile()).mode & 0o777).toBe(0o644)
    expect(readdirSync(dir)).toEqual([NEEDS_AUTH_CACHE_FILE]) // no temp file left behind
  })

  test('the last entry removed leaves an empty object, not a missing file', async () => {
    writeFileSync(cacheFile(), JSON.stringify({ [KEY]: { timestamp: 5, id: 'a' } }))
    expect(await clearNeedsAuthEntry(KEY, dir)).toEqual({ key: KEY, setAt: 5 })
    expect(readFileSync(cacheFile(), 'utf8')).toBe('{}')
  })

  test('an entry without a usable timestamp is still removed', async () => {
    writeFileSync(cacheFile(), JSON.stringify({ [KEY]: { id: 'a' } }))
    expect(await clearNeedsAuthEntry(KEY, dir)).toEqual({ key: KEY, setAt: null })
  })

  test('no file: no-op, nothing created', async () => {
    expect(await clearNeedsAuthEntry(KEY, dir)).toBeNull()
    expect(existsSync(cacheFile())).toBe(false)
  })

  test('no config dir at all: no-op', async () => {
    expect(await clearNeedsAuthEntry(KEY, join(dir, 'absent'))).toBeNull()
  })

  for (const [what, body] of [
    ['corrupt JSON', '{"plugin:discord:discord": {"timest'],
    ['an array', `["${KEY}"]`],
    ['null', 'null'],
    ['key absent', JSON.stringify(OTHERS)],
    ['a near-miss key', JSON.stringify({ 'plugin:discord:discord2': {}, 'plugin:discord': {} })],
  ] as const) {
    test(`${what}: no-op, file byte-identical`, async () => {
      writeFileSync(cacheFile(), body)
      expect(await clearNeedsAuthEntry(KEY, dir)).toBeNull()
      expect(readFileSync(cacheFile(), 'utf8')).toBe(body)
    })
  }

  test('an unwritable directory: logs, resolves null, never throws', async () => {
    writeFileSync(cacheFile(), JSON.stringify({ [KEY]: { timestamp: 1 } }))
    chmodSync(dir, 0o500)
    const write = process.stderr.write
    const lines: string[] = []
    process.stderr.write = ((s: string) => { lines.push(String(s)); return true }) as any
    try {
      expect(await clearNeedsAuthEntry(KEY, dir)).toBeNull()
    } finally { process.stderr.write = write; chmodSync(dir, 0o700) }
    expect(lines.join('')).toContain(`could not clear Claude Code needs-auth cache entry for ${KEY}`)
    expect(JSON.parse(readFileSync(cacheFile(), 'utf8'))).toEqual({ [KEY]: { timestamp: 1 } })
  })
})

describe('describeSetAt', () => {
  test('seconds under a minute, minutes after, unknown without a timestamp', () => {
    expect(describeSetAt(1_000, 41_000)).toBe('40s ago')
    expect(describeSetAt(0, 3 * 60_000 + 10_000)).toBe('3m ago')
    expect(describeSetAt(10_000, 0)).toBe('0s ago') // clock skew never reads negative
    expect(describeSetAt(null, 0)).toBe('at an unknown time')
  })
})

describe('bridge key derivation', () => {
  test('the key is plugin:<plugin>:<server> from the manifest the daemon writes', () => {
    const manifest = JSON.parse(PLUGIN_MANIFEST)
    const servers = Object.keys(JSON.parse(MCP_CONFIG).mcpServers)
    expect(servers).toHaveLength(1)
    expect(BRIDGE_MCP_SERVER_KEY).toBe(`plugin:${manifest.name}:${servers[0]}`)
    expect(BRIDGE_MCP_SERVER_KEY).toBe(KEY)
    expect(BRIDGE_CHANNEL_FLAG).toBe(`plugin:${manifest.name}@claude-plugins-official`)
  })

  // Slack sessions load the same bridge plugin (its name is historical), so the key must not move with the platform.
  test('is the same key on both platforms', () => {
    for (const platform of ['discord', 'slack']) {
      const r = Bun.spawnSync(['bun', '-e', "import('./daemon/plugin-manifest.ts').then(m => process.stdout.write(m.BRIDGE_MCP_SERVER_KEY))"], {
        cwd: join(import.meta.dir, '..', '..'), env: { ...process.env, CHAT_PLATFORM: platform },
      })
      expect(r.stdout.toString()).toBe(KEY)
    }
  })
})

describe('ClaudeEngine.launch', () => {
  const input = { sessionId: 'na-s', tmuxName: 'na-t', cwd: '/tmp', originalCwd: '/tmp', model: 'claude-opus-4-1', prompt: 'hi' }

  async function launchWith(cache: object | null): Promise<{ result: Awaited<ReturnType<ClaudeEngine['launch']>>; log: string; after: unknown }> {
    const fake = withFakeTmux() // also points CLAUDE_CONFIG_DIR at its own temp dir: never the real ~/.claude
    const file = join(claudeConfigDir(), NEEDS_AUTH_CACHE_FILE)
    expect(file.startsWith(tmpdir())).toBe(true)
    mkdirSync(claudeConfigDir(), { recursive: true })
    if (cache) writeFileSync(file, JSON.stringify(cache))
    const write = process.stderr.write
    const lines: string[] = []
    process.stderr.write = ((s: string) => { lines.push(String(s)); return true }) as any
    try {
      const result = await new ClaudeEngine({} as any).launch(input)
      return { result, log: lines.join(''), after: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null }
    } finally { process.stderr.write = write; fake.restore() }
  }

  test("clears the bridge's entry before launching, logs its age once, and notes it on the result", async () => {
    const { result, log, after } = await launchWith({ ...OTHERS, [KEY]: { timestamp: Date.now() - 3 * 60_000, id: 'b' } })
    expect(after).toEqual(OTHERS)
    expect(log).toContain(`daemon: cleared Claude Code needs-auth cache entry for ${KEY} (set 3m ago) before launching na-t\n`)
    expect(log.indexOf('cleared Claude Code needs-auth')).toBeLessThan(log.indexOf('creating the tmux session'))
    expect(result.channelNote).toBe(NEEDS_AUTH_CLEARED_NOTE)
  })

  test('nothing to clear: no log line, no note, cache untouched', async () => {
    const { result, log, after } = await launchWith(OTHERS)
    expect(after).toEqual(OTHERS)
    expect(log).not.toContain('needs-auth')
    expect('channelNote' in result).toBe(false)
  })
})
