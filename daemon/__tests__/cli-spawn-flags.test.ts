// An unrecognized --flag to `hydra spawn` must hard-error, not silently ride into the prompt text.

import { describe, test, expect } from 'bun:test'
import { join } from 'path'

const CLI = join(import.meta.dir, '..', '..', 'cli', 'hydra.ts')

async function run(...args: string[]) {
  const p = Bun.spawn(['bun', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()])
  return { code, stderr }
}

describe('hydra spawn: unknown flags', () => {
  test('an unrecognized --flag hard-errors; a recognized one (--force-cleanup) does not', async () => {
    // --daemon nonexistent: flag parsing happens (and must fail here) before resolveSocket
    // ever looks for a real daemon, on this machine or any other.
    const bad = await run('spawn', 'do the thing', '--initiator', 'x', '--idempotency-key', 'y', '--bogus-flag', '--daemon', 'nonexistent')
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('unknown flag --bogus-flag')

    // Control: --force-cleanup passes flag parsing and fails only at "daemon not found" —
    // proving it was recognized, not silently folded into the prompt.
    const ok = await run('spawn', 'do the thing', '--initiator', 'x', '--idempotency-key', 'y', '--force-cleanup', '--daemon', 'nonexistent')
    expect(ok.stderr).not.toContain('unknown flag')
    expect(ok.stderr).toContain('daemon "nonexistent" not found')
  })
})
