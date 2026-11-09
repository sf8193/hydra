import { describe, test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// A one-off script that imports a daemon module, pointed at a live daemon's state dir (under ~/.claude/channels),
// must only read: loading sessions.json marks records whose tmux is gone dead, and that must not be written back.
describe('importing a daemon module outside the daemon', () => {
  const root = join(import.meta.dir, '..', '..')
  const record = [{ sessionId: 's-1', tmuxName: 'no-such-tmux-session-xyz', threadId: 't-1', engine: 'claude', createdAt: 1, sessionType: 'thread_owner' }]
  function importSessions(home: string, stateDir: string) {
    return Bun.spawnSync(['bun', '-e', `import '${join(root, 'daemon', 'sessions.ts')}'`], {
      cwd: root, timeout: 30_000,
      env: { ...process.env, HOME: home, HYDRA_STATE_DIR: stateDir, DISCORD_BOT_TOKEN: 'dummy' },
    })
  }

  test('against a live state dir it writes nothing and says why', () => {
    const home = mkdtempSync(join(tmpdir(), 'import-guard-'))
    try {
      const live = join(home, '.claude', 'channels', 'discord')
      mkdirSync(live, { recursive: true })
      writeFileSync(join(live, 'sessions.json'), JSON.stringify(record))
      const before = readFileSync(join(live, 'sessions.json'), 'utf8')
      const p = importSessions(home, live)
      expect(p.exitCode).toBe(0)
      expect(readFileSync(join(live, 'sessions.json'), 'utf8')).toBe(before)
      expect(p.stderr.toString()).toContain(`hydra: not writing ${join(live, 'sessions.json')}: it's a live daemon's state`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('against a scratch state dir it writes as before', () => {
    const home = mkdtempSync(join(tmpdir(), 'import-guard-'))
    try {
      const scratch = join(home, 'scratch-state')
      mkdirSync(scratch, { recursive: true })
      writeFileSync(join(scratch, 'sessions.json'), JSON.stringify(record))
      expect(importSessions(home, scratch).exitCode).toBe(0)
      expect(JSON.parse(readFileSync(join(scratch, 'sessions.json'), 'utf8'))[0].deadAt).toBeNumber()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
