import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runGuard, guardEnv, type GuardInput } from '../guard.js'

const dir = mkdtempSync(join(tmpdir(), 'slack-guard-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const script = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p }
const input: GuardInput = { person: 'alice', roles: ['ops', 'people', 'anyone'], place: 'slack:#ops', conversation: 'slack:C1:1.000001', to: 'ops' }
const run = (command: string, timeoutMs = 2000) => runGuard({ command, timeoutMs }, input)

describe('the guard: the exit code is the verdict', () => {
  test('0 delivers; printed {"to"} redirects', async () => {
    expect(await run(script('ok.sh', 'exit 0'))).toEqual({ fate: 'deliver' })
    expect(await run(script('redir.sh', 'echo \'{"to": "billing"}\''))).toEqual({ fate: 'deliver', to: 'billing' })
  })

  test('10 drops, 75 is not now', async () => {
    expect(await run(script('drop.sh', 'exit 10'))).toEqual({ fate: 'drop' })
    expect(await run(script('later.sh', 'exit 75'))).toEqual({ fate: 'later' })
  })

  test('anything else fails open, with why: another exit, a missing command, junk or a bad "to" on stdout', async () => {
    expect(await run(script('two.sh', 'exit 2'))).toEqual({ fate: 'open', why: 'exited 2' })
    expect(await run(join(dir, 'no-such-guard.sh'))).toMatchObject({ fate: 'open', why: 'exited 127' })
    expect(await run(script('junk.sh', 'echo hello'))).toMatchObject({ fate: 'open', why: expect.stringContaining('other than JSON') })
    expect(await run(script('badto.sh', 'echo \'{"to": "../x"}\''))).toMatchObject({ fate: 'open', why: expect.stringContaining('unusable') })
    expect(await run(script('caps.sh', 'echo \'{"to": "Ops_Team"}\''))).toMatchObject({ fate: 'open', why: expect.stringContaining('unusable') })
    expect(await run(script('str.sh', 'echo \'"ops"\''))).toMatchObject({ fate: 'open', why: expect.stringContaining('not an object') })
  })

  test('a timeout fails open and kills everything the guard started', async () => {
    expect(await run(script('slow.sh', `sleep 5.${process.pid % 1000} & sleep 6; exit 0`), 300)).toEqual({ fate: 'open', why: 'timed out after 0.3s' })
    await Bun.sleep(100)
    const ps = Bun.spawnSync(['ps', '-axo', 'command']).stdout.toString()
    expect(ps).not.toContain(`sleep 5.${process.pid % 1000}`)
  })

  test('a child left holding stdout does not hold the verdict, nor hide the redirect printed before it', async () => {
    const t0 = Date.now()
    expect(await run(script('bg.sh', 'echo \'{"to": "billing"}\'\nsleep 5 &\nexit 0'), 3000)).toEqual({ fate: 'deliver', to: 'billing' })
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  test('a flood of output is cut off and fails open, without buffering it', async () => {
    const t0 = Date.now()
    expect(await run(script('flood.sh', 'yes'), 5000)).toEqual({ fate: 'open', why: 'printed more than 4096 bytes' })
    expect(Date.now() - t0).toBeLessThan(1500)
  })

  test('stdin is the JSON input; the text is there only when included, and the Slack tokens never are', async () => {
    const out = join(dir, 'stdin.json')
    const env = join(dir, 'env.txt')
    const guard = script('cat.sh', `cat > ${out}; env > ${env}`)
    process.env.SLOPBOT_SLACK_BOT_TOKEN = 'xoxb-secret'
    process.env.SLACK_BOT_TOKEN = 'xoxb-platform'
    try {
      await run(guard)
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(input)
      await runGuard({ command: guard, timeoutMs: 2000 }, { ...input, text: 'hello' })
      expect(JSON.parse(readFileSync(out, 'utf8')).text).toBe('hello')
      expect(readFileSync(env, 'utf8')).not.toContain('xoxb-secret')
      expect(readFileSync(env, 'utf8')).not.toContain('xoxb-platform')
      expect(readFileSync(env, 'utf8')).not.toContain('DISCORD_BOT_TOKEN')
    } finally { delete process.env.SLOPBOT_SLACK_BOT_TOKEN; delete process.env.SLACK_BOT_TOKEN }
  })

  test('the environment is an allowlist: a secret added to the daemon later never reaches a guard', () => {
    const env = guardEnv({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', HYDRA_STATE_DIR: '/s', HYDRA_API_KEY: 'k', MY_NEW_SECRET: 's', OPENAI_API_KEY: 'o', DISCORD_BOT_TOKEN: 'd' })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', HYDRA_STATE_DIR: '/s' })
  })
})
