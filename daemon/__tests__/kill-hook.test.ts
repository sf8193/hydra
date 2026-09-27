import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runKillHook } from '../session-lifecycle.js'

test('on-kill hook runs with the dead session identity in env; missing hook is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kill-hook-'))
  try {
    const out = join(dir, 'out')
    const hook = join(dir, 'on-kill')
    writeFileSync(hook, `#!/bin/sh\necho "$HYDRA_SESSION_NAME|$HYDRA_KILL_REASON|$HYDRA_ENGINE|$HYDRA_CODEX_HOME_NAME" > ${out}\n`)
    chmodSync(hook, 0o755)
    const info = { tmuxName: 'glyph', sessionId: 's1', threadId: 't1', engine: 'codex', codexHomeName: 'glyph' } as any

    runKillHook(info, 'missing', join(dir, 'nope'))  // must not throw
    runKillHook(info, 'session ended', hook)
    for (let i = 0; i < 50 && !existsSync(out); i++) await Bun.sleep(20)
    expect(readFileSync(out, 'utf8').trim()).toBe('glyph|session ended|codex|glyph')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
