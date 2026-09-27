import { expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { sendTmuxKeys } from '../codex-key-queue.js'
import { tmuxNewSession } from '../../shared/spawn-env.js'

// Isolated real tmux server. Run separately from global child_process mocks.
const available = !('mock' in execFileSync) && Bun.spawnSync(['tmux', '-V']).exitCode === 0
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('timed out waiting for isolated pane')
    await Bun.sleep(5)
  }
}

for (const change of ['replacement', 'respawn'] as const) {
  test.skipIf(!available)(`literal submission never sends Enter after pane ${change}`, async () => {
    const dir = mkdtempSync('/tmp/gkr-')
    const saved = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX }
    process.env.TMUX_TMPDIR = dir
    delete process.env.TMUX
    const socket = join(dir, `tmux-${process.getuid!()}`, 'default')
    const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', stdio: 'pipe' })
    const oldLog = join(dir, 'old')
    const newLog = join(dir, 'new')
    const reader = (file: string) => `stty -echo -icanon; exec cat > ${quote(file)}`
    let sending: Promise<unknown> | undefined
    try {
      tmuxNewSession(['-d', '-s', 'isolated', '-n', 'anchor', 'sleep 30'])
      tmux('new-window', '-t', 'isolated', '-n', 'hydra-chat', reader(oldLog))
      await until(() => existsSync(oldLog))
      const target = 'isolated:hydra-chat'
      const oldPane = tmux('display-message', '-p', '-t', target, '#{pane_id}').trim()
      sending = sendTmuxKeys({ target, mode: 'literal', text: '/status' }).catch(error => error)
      await until(() => readFileSync(oldLog, 'utf8') === '/status')
      if (change === 'replacement') {
        tmux('kill-window', '-t', target)
        tmux('new-window', '-t', 'isolated', '-n', 'hydra-chat', reader(newLog))
        expect(tmux('display-message', '-p', '-t', target, '#{pane_id}').trim()).not.toBe(oldPane)
      } else {
        tmux('respawn-pane', '-k', '-t', oldPane, reader(newLog))
        expect(tmux('display-message', '-p', '-t', target, '#{pane_id}').trim()).toBe(oldPane)
      }
      await until(() => existsSync(newLog))
      expect(await sending).toBeInstanceOf(Error)
      await Bun.sleep(100)
      expect(readFileSync(newLog, 'utf8')).toBe('')
    } finally {
      if (sending) await sending
      try { tmux('kill-server') } catch {}
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 8000)
}
