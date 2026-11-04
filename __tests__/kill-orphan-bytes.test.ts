import { test, expect } from 'bun:test'
import { copyFileSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { join } from 'path'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

// start-byte.sh and stop-byte.sh run under `set -euo pipefail`, so a reaper that
// returns nonzero ends the caller with no output.
function runReaper(pgrep: string, ps = '#!/bin/sh\n'): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kill-orphans-'))
  const sock = join(dir, 'daemon.sock')
  copyFileSync(join(ROOT, 'kill-orphan-bytes.sh'), join(dir, 'kill.sh'))
  writeFileSync(join(dir, 'pgrep'), pgrep, { mode: 0o755 })
  writeFileSync(join(dir, 'ps'), ps.replace('$SOCK', sock), { mode: 0o755 })
  const proc = Bun.spawnSync(
    ['bash', '-c', 'set -euo pipefail; . ./kill.sh; _kill_orphan_bytes killing ""; echo reached'],
    { cwd: dir, env: { PATH: `${dir}:/usr/bin:/bin`, SOCK: sock, LOG: join(dir, 'byte.log') } },
  )
  return { code: proc.exitCode, out: new TextDecoder().decode(proc.stdout) }
}

test('_kill_orphan_bytes succeeds when pgrep finds nothing', () => {
  const { code, out } = runReaper('#!/bin/sh\nexit 1\n')
  expect(code).toBe(0)
  expect(out).toContain('reached')
})

test('_kill_orphan_bytes succeeds when an orphan exits before kill reaches it', () => {
  const { code, out } = runReaper('#!/bin/sh\necho 99999999\n', '#!/bin/sh\necho "claude DAEMON_SOCK=$SOCK"\n')
  expect(code).toBe(0)
  expect(out).toContain('reached')
})
