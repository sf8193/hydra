import { describe, test, expect } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The real daemon entry point, in a child with its own state dir: it must refuse before anything connects.
describe('daemon boot with hydra.toml beside the old state', () => {
  test('exits 78 at once, says why on stderr, and leaves the reason for the watchdog and hydra health', () => {
    const dir = mkdtempSync(join(tmpdir(), 'boot-refusal-'))
    try {
      writeFileSync(join(dir, 'hydra.toml'), 'operator = "op"\n[people.op]\nids = ["discord:100000000000000001"]\n')
      writeFileSync(join(dir, 'specialists.json'), JSON.stringify({ ops: { channel: '1', kickoff: 'k' } }))
      const root = join(import.meta.dir, '..', '..')
      const p = Bun.spawnSync(['bun', join(root, 'daemon.ts')], {
        cwd: root, timeout: 30_000,
        env: { ...process.env, HYDRA_STATE_DIR: dir, DISCORD_BOT_TOKEN: 'dummy', SPAWN_CWD: dir },
      })
      expect(p.exitCode).toBe(78)
      expect(p.stderr.toString()).toContain('daemon: refusing to start: hydra.toml is in use, but old state it replaces is still in')
      expect(JSON.parse(readFileSync(join(dir, 'boot-refused.json'), 'utf8')).reason).toContain('specialists.json')
      // Nothing else started: no pid file, no socket.
      expect(existsSync(join(dir, 'daemon.pid'))).toBe(false)
      expect(existsSync(join(dir, 'daemon.sock'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
