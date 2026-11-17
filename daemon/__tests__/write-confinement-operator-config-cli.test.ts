// A listed MCP server whose name the operator's own Claude Code config also declares: the launch's allowlist admits a listed server by its exact command, so the operator's
// (another command) does not start and `hydra config check` does not refuse it (#774; the live proof is write-confinement-mcp.live.test.ts). Run here as the real CLI (no claude
// needed, so it runs in CI) against a throwaway HOME whose files (real files, parsed by the real reader) declare the name. Only a managed MCP config is refused: its path is fixed
// (outside any HOME), so that refusal is covered in write-confinement.test.ts and write-confinement-lifecycle.test.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

/** A throwaway HOME of its own for each test (nothing carries over from another's ~/.claude.json), with the config below in its state folder. */
const scenario = () => {
  const fake = realpathSync(mkdtempSync(join(tmpdir(), 'clash-cli-'))); made.push(fake)
  const home = join(fake, 'home'), state = join(home, 'state'), workdir = join(home, 'agents', 'ops'), configDir = join(home, '.claude')
  for (const d of [state, workdir, configDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(state, 'hydra.toml'), `
operator = "op"
[people.op]
addresses = ["slack:U0OP"]
[slack.apps.default]
bot_token_env = "CONNECTOR_SLACK_BOT_TOKEN"
[mcp_servers.browser]
command = "/usr/bin/true"
profile_args = ["--user-data-dir", "{profile_dir}"]
[specialists.ops]
workdir = "${workdir}"
reachable_by = []
can_only_write_to = "workdir"
mcp_servers = ["browser"]
[[rules]]
place = "slack:app-dm:*"
target = "specialist:ops"
`)
  const check = async (): Promise<{ code: number; out: string }> => {
    const p = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'cli', 'hydra.ts'), 'config', 'check', 'slack', '--state-dir', state], {
      cwd: fake, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      env: { PATH: process.env.PATH!, USER: process.env.USER ?? 'user', HOME: home, CLAUDE_CONFIG_DIR: configDir, HYDRA_STATE_DIR: state },
    })
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    return { code: await p.exited, out: o + e }
  }
  return { home, workdir, check }
}
const declares = { mcpServers: { browser: { command: '/usr/bin/false' } } }

describe('hydra config check, the real CLI, a throwaway HOME each', () => {
  const loads = async (t: ReturnType<typeof scenario>) => { const r = await t.check(); expect(r.out).not.toContain('already declares an MCP server'); expect(r.out).toContain('hydra.toml: loads'); expect(r.code).toBe(0) }
  test('control: with no operator server of that name, the config loads', async () => { await loads(scenario()) })
  test('~/.claude.json declaring the listed name loads', async () => {
    const t = scenario()
    writeFileSync(join(t.home, '.claude.json'), JSON.stringify(declares))
    await loads(t)
  })
  test('the same name declared for this workdir\'s project in ~/.claude.json loads', async () => {
    const t = scenario()
    writeFileSync(join(t.home, '.claude.json'), JSON.stringify({ projects: { [t.workdir]: declares } }))
    await loads(t)
  })
  test('a .mcp.json in a folder above the workdir loads', async () => {
    const t = scenario()
    writeFileSync(join(t.home, 'agents', '.mcp.json'), JSON.stringify(declares))
    await loads(t)
  })
})
