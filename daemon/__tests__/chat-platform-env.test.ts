// An unknown CHAT_PLATFORM stops boot with a message that names the choices, instead of running as Discord with a Slack-shaped state dir.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = join(import.meta.dir, '..', '..')
const load = (platform: string | undefined) => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-platform-'))
  try {
    const env: Record<string, string | undefined> = { ...process.env, HYDRA_STATE_DIR: dir, DISCORD_BOT_TOKEN: 'dummy', DEFAULT_SESSION_CHANNEL: '000000000000000000', CHAT_PLATFORM: platform }
    if (platform === undefined) delete env.CHAT_PLATFORM
    const p = Bun.spawnSync(['bun', '-e', "import { PLATFORM } from './infra/config.ts'; console.log('platform=' + PLATFORM)"], { cwd: root, env: env as Record<string, string>, timeout: 30_000 })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('CHAT_PLATFORM', () => {
  test('an unknown value refuses to boot and names the platforms', () => {
    const r = load('teams')
    expect(r.code).toBe(1)
    expect(r.err).toContain("CHAT_PLATFORM must be one of discord, slack, got 'teams'")
  }, 30_000)
  test('unset is discord', () => {
    const r = load(undefined)
    expect(r.out).toContain('platform=discord')
  }, 30_000)
})
