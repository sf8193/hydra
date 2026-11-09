import { describe, test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'

const hydra = join(import.meta.dir, '..', 'hydra.ts')

/** Runs the real CLI against a fake daemon under a scratch HOME, and returns the request it sent (or its error). */
async function cliRequest(command: string, argv: string[]): Promise<{ code: number; err: string; req?: Record<string, unknown> }> {
  const home = mkdtempSync('/tmp/hd-')   // short: a Unix socket path is capped near 104 bytes
  const dir = join(home, '.claude', 'channels', 'test')
  mkdirSync(dir, { recursive: true })
  let req: Record<string, unknown> | undefined
  const server = Bun.listen({
    unix: join(dir, 'daemon.sock'),
    socket: {
      data(s, data) {
        req = JSON.parse(data.toString().split('\n')[0])
        s.write(JSON.stringify({ ok: true, data: {} }) + '\n')
        s.end()
      },
    },
  })
  try {
    const p = Bun.spawn([process.execPath, hydra, '--daemon', 'test', command, ...argv], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' })
    const code = await p.exited
    return { code, err: await new Response(p.stderr).text(), req }
  } finally { server.stop(true); rmSync(home, { recursive: true }) }
}

const spawnRequest = (argv: string[]) => cliRequest('spawn', argv)

describe('hydra spawn: -- ends the options', () => {
  const opts = ['--initiator', 't', '--idempotency-key', 'k']

  test('a prompt that starts with "---" (YAML frontmatter) goes after -- and reaches the daemon whole', async () => {
    const prompt = '---\ntitle: kickoff\n---\nDo the thing. --json stays text.'
    const r = await spawnRequest([...opts, '--', prompt])
    expect(r.err).not.toContain('unknown flag')
    expect(r.code).toBe(0)
    expect((r.req?.params as { prompt: string }).prompt).toBe(prompt)
  }, 15_000)

  test('words after -- that look like flags are prompt, not options, including --json and --help', async () => {
    const r = await spawnRequest([...opts, '--', '--model', 'x', '--json', '--help'])
    expect(r.code).toBe(0)
    expect(r.req?.params).toMatchObject({ prompt: '--model x --json --help' })
    expect((r.req?.params as { model?: string }).model).toBeUndefined()
  }, 15_000)

  test('without --, a prompt starting with "--" is still an unknown flag', async () => {
    const r = await spawnRequest([...opts, '---\ntitle: x'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('unknown flag')
  }, 15_000)
})

describe('hydra deliver --idempotency-ttl', () => {
  const base = ['--session', 's', '--message', 'm']
  test('sent with the key; refused without one, or when it is not 1m to 7d', async () => {
    const ok = await cliRequest('deliver', [...base, '--idempotency-key', 'k', '--idempotency-ttl', '24h'])
    expect(ok.code).toBe(0)
    expect(ok.req?.params).toMatchObject({ idempotencyKey: 'k', idempotencyTtl: '24h' })
    const noKey = await cliRequest('deliver', [...base, '--idempotency-ttl', '24h'])
    expect(noKey).toMatchObject({ code: 1, req: undefined })
    expect(noKey.err).toContain('--idempotency-ttl needs --idempotency-key')
    const tooLong = await cliRequest('deliver', [...base, '--idempotency-key', 'k', '--idempotency-ttl', '8d'])
    expect(tooLong).toMatchObject({ code: 1, req: undefined })
    expect(tooLong.err).toContain('at most 7d')
    const noValue = await cliRequest('deliver', [...base, '--idempotency-key', 'k', '--idempotency-ttl'])
    expect(noValue).toMatchObject({ code: 1, req: undefined })
  }, 20_000)
})
