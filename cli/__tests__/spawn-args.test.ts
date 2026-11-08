import { describe, test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'

const hydra = join(import.meta.dir, '..', 'hydra.ts')

/** Runs the real CLI against a fake daemon under a scratch HOME, and returns the request it sent (or its error). */
async function spawnRequest(argv: string[]): Promise<{ code: number; err: string; req?: Record<string, unknown> }> {
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
    const p = Bun.spawn([process.execPath, hydra, '--daemon', 'test', 'spawn', ...argv], { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' })
    const code = await p.exited
    return { code, err: await new Response(p.stderr).text(), req }
  } finally { server.stop(true); rmSync(home, { recursive: true }) }
}

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
