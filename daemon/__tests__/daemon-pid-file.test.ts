import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { createServer } from 'net'
import { join } from 'path'
import { tmpdir } from 'os'

// A second daemon started while one is running finds it and exits. It must leave the
// running daemon's pid file alone: it used to overwrite it at startup and delete it on exit.
test('a second daemon that finds one running exits and leaves the running daemon\'s pid file in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-pid-'))
  const live = createServer(() => {})
  try {
    writeFileSync(join(dir, 'daemon.pid'), '424242\n')
    await new Promise<void>(r => live.listen(join(dir, 'daemon.sock'), r))
    const child = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'daemon.ts')], {
      env: { ...process.env, HYDRA_STATE_DIR: dir, DISCORD_BOT_TOKEN: 'dummy' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const code = await child.exited
    const err = await new Response(child.stderr).text()
    expect(err).toContain('another daemon is already listening')
    expect(code).toBe(1)
    expect(existsSync(join(dir, 'daemon.pid'))).toBe(true)
    expect(readFileSync(join(dir, 'daemon.pid'), 'utf8').trim()).toBe('424242')
  } finally {
    live.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
