import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OmpEngine } from '../engines/omp-engine.js'
import { ompSessionDir } from '../engines/omp-session.js'

// The omp launch command, with tmux faked (the real-omp proof needs HYDRA_OMP_E2E=1 and a model; this runs in CI).
async function launchCommand(prompt: string, extra: object = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-omp-launch-'))
  const saved = { PATH: process.env.PATH, TMUX: process.env.TMUX }
  writeFileSync(join(dir, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${join(dir, 'args')}\n`)
  chmodSync(join(dir, 'tmux'), 0o755)
  process.env.PATH = `${dir}:${saved.PATH}`
  delete process.env.TMUX
  try {
    await new OmpEngine({} as any).launch({ sessionId: 's1', tmuxName: 'omp-t', cwd: '/tmp', originalCwd: '/tmp', model: 'claude-sonnet-5-5[1m]', prompt, ...extra })
    return existsSync(join(dir, 'args')) ? readFileSync(join(dir, 'args'), 'utf8') : ''
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
  expect(cmd).toContain(`--session-dir '${ompSessionDir('s1')}'`)
  expect(cmd).not.toContain('--no-session')
  expect(cmd).toContain('unset HYDRA_ROLE CLAUDE_CONFIG_DIR')
})

test('the spawn prompt goes in the environment, and only when there is one', async () => {
  expect(await launchCommand('say hi')).toContain("export HYDRA_SPAWN_PROMPT='say hi'")
  expect(await launchCommand('')).not.toContain('HYDRA_SPAWN_PROMPT')
})

test('a resume copies the dead session\'s file into the new session\'s directory and continues it with -c', async () => {
  const old = ompSessionDir('dead-session')
  rmSync(old, { recursive: true, force: true }); rmSync(ompSessionDir('s1'), { recursive: true, force: true })
  mkdirSync(old, { recursive: true })
  writeFileSync(join(old, '2026-10-13_x.jsonl'), '{"type":"session","id":"x"}\n')
  writeFileSync(join(old, '.2026-10-13_x.jsonl.lock.os'), '')
  const cmd = await launchCommand('hello', { resumeOmp: { fromSessionId: 'dead-session' } })
  expect(cmd).toMatch(/ -c 2>>/)
  expect(readdirSync(ompSessionDir('s1'))).toEqual(['2026-10-13_x.jsonl'])
  expect(readFileSync(join(ompSessionDir('s1'), '2026-10-13_x.jsonl'), 'utf8')).toBe('{"type":"session","id":"x"}\n')
  expect(readdirSync(old).sort()).toEqual(['.2026-10-13_x.jsonl.lock.os', '2026-10-13_x.jsonl'])
  expect(await launchCommand('hello')).not.toMatch(/ -c 2>>/)
})

test('a resume with no session file (directory gone, or only omp\'s lock file) fails before omp starts, so the caller falls back to a fresh session', async () => {
  rmSync(ompSessionDir('gone-session'), { recursive: true, force: true })
  await expect(launchCommand('hello', { resumeOmp: { fromSessionId: 'gone-session' } })).rejects.toThrow('no session file to resume')
  mkdirSync(ompSessionDir('empty-session'), { recursive: true })
  writeFileSync(join(ompSessionDir('empty-session'), '.x.jsonl.lock.os'), '')
  await expect(launchCommand('hello', { resumeOmp: { fromSessionId: 'empty-session' } })).rejects.toThrow('no session file to resume')
})

test('recoveryPlan resumes the dead session by id, is not generic, and cannot fork', () => {
  const engine = new OmpEngine({} as any)
  expect(engine.recoveryPlan({ tmuxName: 't', sessionId: 'dead-1' })).toEqual({ generic: false, resume: { kind: 'at-launch', resumeOmp: { fromSessionId: 'dead-1' } }, fork: null })
  expect(engine.recoveryPlan({ tmuxName: 't' })).toEqual({ generic: false, resume: null, fork: null })
})
