// A listed MCP server whose name the operator's own Claude Code config also declares: Claude Code's allowlist matches by name, so the operator's would be admitted too.
// `hydra config check` refuses it, run here as the real CLI (no claude needed, so it runs in CI) against a throwaway HOME whose ~/.claude.json (a real file, parsed by the real reader) declares the name.
// The launch's refusal of the same thing, through the real reader and a real file, is in write-confinement-lifecycle.test.ts ("a real ~/.claude.json").
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
  test('control: with no operator server of that name, the config loads (the refusals below are the clash\'s)', async () => {
    const r = await scenario().check()
    expect(r.out).not.toContain('already declares an MCP server')
    expect(r.out).toContain('hydra.toml: loads')
  })
  test('~/.claude.json declaring the listed name: refused, naming the file and the reason; exit 1', async () => {
    const t = scenario()
    writeFileSync(join(t.home, '.claude.json'), JSON.stringify(declares))
    const r = await t.check()
    expect(r.code).toBe(1)
    expect(r.out).toContain(`${join(t.home, '.claude.json')} already declares an MCP server named browser`)
    expect(r.out).toContain("Claude Code's allowlist matches by name")
  })
  test('the same name declared for this workdir\'s project in ~/.claude.json: refused', async () => {
    const t = scenario()
    writeFileSync(join(t.home, '.claude.json'), JSON.stringify({ projects: { [t.workdir]: declares } }))
    expect((await t.check()).out).toContain('already declares an MCP server named browser')
  })
  test('a .mcp.json in a folder above the workdir: refused', async () => {
    const t = scenario()
    writeFileSync(join(t.home, 'agents', '.mcp.json'), JSON.stringify(declares))
    expect((await t.check()).out).toContain(`${join(t.home, 'agents', '.mcp.json')} already declares an MCP server named browser`)
  })
  test('a ~/.claude.json that cannot be parsed: refused too (the check fails closed)', async () => {
    const t = scenario()
    writeFileSync(join(t.home, '.claude.json'), '{ not json')
    const r = await t.check()
    expect(r.code).toBe(1)
    expect(r.out).toContain('so hydra cannot tell whether it declares an MCP server named browser')
  })
})
