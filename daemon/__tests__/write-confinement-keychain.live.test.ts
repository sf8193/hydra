// A write-confined specialist's shell and the macOS keychain, from the settings hydra builds (`confinementSettings`) run by the real `claude`, not from a profile text.
//
// What it proves: with `~/Library/Keychains` among the places the shell may not read (hydra's own `readDenyRoots`, which always lists it), the Bash tool cannot read a
// keychain item, through `security find-generic-password` or through the git credential helper `git credential-osxkeychain`; with that one place left out it can (the mutation).
// What it does not: the operator's real login keychain (never opened here), and any store the keychain's Mach service serves without the caller opening a file.
//
// No login and no real keychain. `claude -p` talks to a stub API (this file) that asks for one Bash command per run. HOME is a temp folder holding its own
// `Library/Keychains/login.keychain-db`: the Security framework takes the default keychain from HOME, so the real search list and default are untouched
// (the test refuses to go on if the default is not the temp one). Off unless asked, because it runs the real claude:
//   HYDRA_LIVE_CLAUDE=1 bun run test --isolate daemon/__tests__/write-confinement-keychain.live.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { confinementSettings } from '../../app/write-confinement.js'
import { readDenyRoots } from '../../config/write-confinement.js'

const SECURITY = '/usr/bin/security'
const LIVE = process.env.HYDRA_LIVE_CLAUDE === '1' && process.platform === 'darwin' && existsSync(SECURITY) && !!Bun.which('claude') && !!Bun.which('git')
const SERVICE = `hydra-probe-${process.pid}`

describe.skipIf(!LIVE)('the Bash tool of a write-confined session and a keychain', () => {
  const fake = realpathSync(mkdtempSync(join(tmpdir(), 'kc-live-')))
  const home = join(fake, 'home')
  const keychain = join(home, 'Library', 'Keychains', 'login.keychain-db')
  const workdir = join(home, 'work')
  const configDir = join(fake, 'claude-config')
  const realpath = (p: string) => { try { return realpathSync(p) } catch { return p } }
  const env = (): Record<string, string> => ({ PATH: process.env.PATH!, USER: process.env.USER ?? 'user', HOME: home })
  const sh = (cmd: string, stdin?: string) => Bun.spawnSync(['sh', '-c', cmd], { env: env(), stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin) })
  const unlock = () => Bun.spawnSync([SECURITY, 'unlock-keychain', '-p', 'pw', keychain], { env: env() })

  // The stub Anthropic API: the first turn asks for the Bash command in `next`, the second ends the turn.
  let next = { command: '', extra: {} as Record<string, unknown> }
  let api: ReturnType<typeof Bun.serve>
  const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
  const message = (content: unknown[], stop: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
  async function handle(req: Request): Promise<Response> {
    if (!new URL(req.url).pathname.includes('/messages') || req.method !== 'POST') return Response.json({})
    const body: any = await req.json().catch(() => ({}))
    const last = body.messages?.[body.messages.length - 1]
    const afterTool = Array.isArray(last?.content) && last.content.some((c: any) => c.type === 'tool_result')
    const useTool = (body.tools ?? []).some((t: any) => t.name === 'Bash') && !afterTool
    const content: any[] = useTool ? [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: next.command, description: 'probe', ...next.extra } }] : [{ type: 'text', text: 'done' }]
    const m = message(content, useTool ? 'tool_use' : 'end_turn')
    if (!body.stream) return Response.json(m)
    const ev: [string, unknown][] = [['message_start', { type: 'message_start', message: { ...m, content: [], stop_reason: null } }]]
    content.forEach((c, i) => {
      if (c.type === 'text') ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }], ['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: c.text } }])
      else ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }], ['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }])
      ev.push(['content_block_stop', { type: 'content_block_stop', index: i }])
    })
    ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }])
    return new Response(sse(ev), { headers: { 'content-type': 'text/event-stream' } })
  }

  /** Runs `command` as the one Bash call of a real `claude -p` session started with hydra's confinement settings; returns what the tool printed. */
  async function bash(command: string, cannotRead: string[], extra: Record<string, unknown> = {}): Promise<string> {
    next = { command, extra }
    unlock()
    const settings = join(fake, `settings-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(settings, JSON.stringify(confinementSettings({ denyCommands: [], cannotRead })))
    const p = Bun.spawn(['claude', '-p', 'go', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--settings', settings], {
      cwd: workdir, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      env: { ...env(), ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`, ANTHROPIC_API_KEY: 'sk-ant-fake', CLAUDE_CONFIG_DIR: configDir },
    })
    const timer = setTimeout(() => p.kill(), 60_000)   // only the process this test started, by its own handle
    const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    await p.exited
    clearTimeout(timer)
    for (const line of out.split('\n')) {
      try { const j = JSON.parse(line); if (j.tool_use_result?.stdout !== undefined) return `${j.tool_use_result.stdout}${j.tool_use_result.stderr ?? ''}` } catch { /* not a JSON line */ }
      try { const j = JSON.parse(line); const c = j.message?.content; if (Array.isArray(c)) for (const x of c) if (x.type === 'tool_result' && typeof x.content === 'string') return x.content } catch { /* ditto */ }
    }
    throw new Error(`the Bash tool printed nothing in the run: ${out.slice(0, 600)}`)
  }

  const places = (): string[] => readDenyRoots({ home, stateDir: join(home, 'state'), realpath }, workdir, [], [])
  const FIND = `security find-generic-password -s ${SERVICE} -w 2>&1; echo rc=$?`
  const HELPER = `printf 'protocol=https\\nhost=example.test\\n\\n' | git credential-osxkeychain get 2>&1; echo rc=$?`

  beforeAll(() => {
    for (const d of [join(home, 'Library', 'Keychains'), workdir, configDir]) mkdirSync(d, { recursive: true })
    // Isolation is asserted BEFORE anything is created: under the temp HOME the Security framework must find no default keychain at all (a read-only query).
    // If it found one, HOME was not honoured and the answer would be the operator's own, and the test stops here.
    const before = Bun.spawnSync([SECURITY, 'default-keychain'], { env: env() })
    expect([before.exitCode === 0, before.stdout.toString().trim()]).toEqual([false, ''])
    expect(Bun.spawnSync([SECURITY, 'create-keychain', '-p', 'pw', keychain], { env: env() }).exitCode).toBe(0)
    // Now the default keychain and every keychain in the search list are under the temp root: the real one is not reachable from this HOME.
    expect(Bun.spawnSync([SECURITY, 'default-keychain'], { env: env() }).stdout.toString()).toContain(keychain)
    const listed = [...Bun.spawnSync([SECURITY, 'list-keychains', '-d', 'user'], { env: env() }).stdout.toString().matchAll(/"([^"]+)"/g)].map(m => m[1])
    expect(listed.length).toBeGreaterThan(0)
    for (const p of listed) expect(p.startsWith(fake)).toBe(true)
    expect(unlock().exitCode).toBe(0)
    expect(Bun.spawnSync([SECURITY, 'add-generic-password', '-a', 'me', '-s', SERVICE, '-w', 'keychain-secret'], { env: env() }).exitCode).toBe(0)
    expect(sh(`git credential-osxkeychain store`, 'protocol=https\nhost=example.test\nusername=u\npassword=git-secret\n\n').exitCode).toBe(0)
    api = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handle })
  })
  afterAll(() => {
    api?.stop(true)
    Bun.spawnSync([SECURITY, 'delete-keychain', keychain], { env: env() })   // the temp one, by its exact path
    rmSync(fake, { recursive: true, force: true })
  })

  test('the places hydra denies a write-confined shell include the keychain folder', () => {
    expect(places()).toContain(join(home, 'Library', 'Keychains'))
  })

  const without = () => places().filter(p => !p.endsWith('/Library/Keychains'))
  test('MUTATION: with the keychain folder left out of the denied places, Bash reads the item with `security` and a credential from the git helper', async () => {
    expect(await bash(FIND, without())).toContain('keychain-secret')
    const helper = await bash(HELPER, without())
    expect(helper).toContain('password=git-secret')
  }, 90_000)
  test('with it in the list (hydra\'s own list), `security find-generic-password` fails and prints no secret', async () => {
    const out = await bash(FIND, places())
    expect(out).not.toContain('keychain-secret')
    expect(out).not.toMatch(/rc=0\b/)
    expect(out).toMatch(/SecKeychain/)   // the framework's own refusal, so the run did reach `security`
  }, 90_000)
  test('with it in the list, `git credential-osxkeychain get` returns no credential', async () => {
    const out = await bash(HELPER, places())
    expect(out).not.toContain('git-secret')
    expect(out).not.toContain('password=')
    expect(out.trim()).toBe('rc=0')   // the helper ran and exited cleanly with nothing to say: not a missing git, not a failed pipe
  }, 90_000)
  test('asking to retry outside the sandbox (dangerouslyDisableSandbox) changes nothing', async () => {
    const out = await bash(FIND, places(), { dangerouslyDisableSandbox: true })
    expect(out).not.toContain('keychain-secret')
  }, 90_000)
})
