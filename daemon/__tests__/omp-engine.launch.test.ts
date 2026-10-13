import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OmpEngine } from '../engines/omp-engine.js'

// The omp launch command, with tmux faked (the real-omp proof needs HYDRA_OMP_E2E=1 and a model; this runs in CI).
async function launchCommand(prompt: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-omp-launch-'))
  const saved = { PATH: process.env.PATH, TMUX: process.env.TMUX }
  writeFileSync(join(dir, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${join(dir, 'args')}\n`)
  chmodSync(join(dir, 'tmux'), 0o755)
  process.env.PATH = `${dir}:${saved.PATH}`
  delete process.env.TMUX
  try {
    await new OmpEngine({} as any).launch({ sessionId: 's1', tmuxName: 'omp-t', cwd: '/tmp', originalCwd: '/tmp', model: 'claude-sonnet-5-5[1m]', prompt })
    return readFileSync(join(dir, 'args'), 'utf8')
  } finally {
    process.env.PATH = saved.PATH
    if (saved.TMUX !== undefined) process.env.TMUX = saved.TMUX
    rmSync(dir, { recursive: true, force: true })
  }
}

test('launch names the model without [1m], loads only hydra\'s extension config, and keeps Claude\'s config out', async () => {
  const cmd = await launchCommand('hello')
  expect(cmd).toContain("--model 'anthropic/claude-sonnet-5-5'")
  expect(cmd).not.toContain('[1m]')
  expect(cmd).toContain('hydra-omp.yml')
  expect(cmd).toContain('--approval-mode yolo')
  expect(cmd).toContain('hydra-bridge.ts')
  expect(cmd).toContain('--no-session')
  expect(cmd).toContain('unset HYDRA_ROLE CLAUDE_CONFIG_DIR')
})

test('the spawn prompt goes in the environment, and only when there is one', async () => {
  expect(await launchCommand('say hi')).toContain("export HYDRA_SPAWN_PROMPT='say hi'")
  expect(await launchCommand('')).not.toContain('HYDRA_SPAWN_PROMPT')
})
