// Whether a write-confined session's Bash can connect() to a unix socket: the daemon's socket carries `cli` messages (spawn, kill, deliver) and registration
// with no caller identity, so the only barrier is the sandbox. The settings are hydra's own (`confinementSettings`), run by the real `claude -p` against a stub API
// (as write-confinement-keychain.live.test.ts); throwaway unix sockets in temp folders stand in for daemon.sock, each counting what connects. Off unless asked:
//   HYDRA_LIVE_CLAUDE=1 scripts/test.sh --isolate daemon/__tests__/write-confinement-socket.live.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { confinementSettings } from '../write-confinement.js'
import { readDenyRoots } from '../../config/write-confinement.js'

const LIVE = process.env.HYDRA_LIVE_CLAUDE === '1' && process.platform === 'darwin' && !!Bun.which('claude') && !!Bun.which('nc')

describe.skipIf(!LIVE)('the Bash tool of a write-confined session and a unix socket', () => {
  const fake = realpathSync(mkdtempSync(join(tmpdir(), 'sock-live-')))
  const home = join(fake, 'home'), state = join(home, 'state'), workdir = join(home, 'work'), other = join(fake, 'elsewhere'), configDir = join(fake, 'claude-config')
  const realpath = (p: string) => { try { return realpathSync(p) } catch { return p } }
  const env = (): Record<string, string> => ({ PATH: process.env.PATH!, USER: process.env.USER ?? 'user', HOME: home })
  const socks = { state: join(state, 'daemon.sock'), workdir: join(workdir, 'w.sock'), other: join(other, 'o.sock') }
  const servers: Server[] = []
  const accepted: Record<string, number> = { state: 0, workdir: 0, other: 0 }

  let next = ''
  let api: ReturnType<typeof Bun.serve>
  const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
  const message = (content: unknown[], stop: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
  async function handle(req: Request): Promise<Response> {
    if (!new URL(req.url).pathname.includes('/messages') || req.method !== 'POST') return Response.json({})
    const body: any = await req.json().catch(() => ({}))
    const last = body.messages?.[body.messages.length - 1]
    const afterTool = Array.isArray(last?.content) && last.content.some((c: any) => c.type === 'tool_result')
    const useTool = (body.tools ?? []).some((t: any) => t.name === 'Bash') && !afterTool
    const content: any[] = useTool ? [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: next, description: 'probe' } }] : [{ type: 'text', text: 'done' }]
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

  async function bash(command: string, cannotRead: string[], allowUnixSockets: string[] = []): Promise<string> {
    next = command
    const settings = join(fake, `settings-${Math.random().toString(36).slice(2)}.json`)
    const base = confinementSettings({ denyCommands: [], cannotRead }) as { sandbox: Record<string, unknown> }
    if (allowUnixSockets.length) base.sandbox.network = { allowUnixSockets }
    writeFileSync(settings, JSON.stringify(base))
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
    throw new Error(`the Bash tool printed nothing: ${out.slice(0, 600)}`)
  }

  const places = (): string[] => readDenyRoots({ home, stateDir: state, realpath }, workdir, [], [])
  const dial = (sock: string) => `printf '{"type":"cli"}\\n' | nc -U -w 2 ${sock} 2>&1; echo rc=$?`
  const listen = (key: keyof typeof socks) => new Promise<void>(res => { const s = createServer(c => { accepted[key]++; c.on('data', () => {}); c.on('error', () => {}); c.end() }); servers.push(s); s.listen(socks[key], res) })

  beforeAll(async () => {
    for (const d of [state, workdir, other, configDir]) mkdirSync(d, { recursive: true, mode: 0o700 })
    for (const k of Object.keys(socks) as (keyof typeof socks)[]) await listen(k)
    api = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handle })
  })
  afterAll(() => { api?.stop(true); for (const s of servers) s.close(); rmSync(fake, { recursive: true, force: true }) })

  test('the sandboxed shell\'s TMPDIR is /tmp/claude-<uid>, and it writes in temp nowhere else', async () => {
    const out = await bash(`echo TMPDIR=$TMPDIR; for d in "$TMPDIR" /tmp /private/tmp /tmp/claude-$(id -u) /var/folders; do touch "$d/hb-probe-$$" 2>/dev/null && echo "writable $d" && rm -f "$d/hb-probe-$$"; done; echo uid=$(id -u)`, places())
    expect(out).toContain(`TMPDIR=/tmp/claude-${process.getuid!()}\n`)   // the temp folder daemon/write-confinement.ts confinedTemp names
    expect(out).toContain(`writable /tmp/claude-${process.getuid!()}`)
    expect(out).not.toContain('writable /tmp\n')
  }, 90_000)
  test('control: the harness reaches each socket from an unsandboxed shell (async: the servers live in this process)', async () => {
    for (const key of ['state', 'workdir', 'other'] as const) {
      const p = Bun.spawn(['sh', '-c', dial(socks[key])], { env: env(), stdout: 'pipe', stderr: 'pipe' })
      await p.exited
      expect(accepted[key]).toBeGreaterThan(0)
      accepted[key] = 0
    }
  })
  test('MUTATION: with the socket allowed in the sandbox settings (sandbox.network.allowUnixSockets), the same Bash does connect', async () => {
    const out = await bash(dial(socks.other), places(), [socks.other])
    process.stdout.write(`SOCKET-PROBE mutation: connected=${accepted.other > 0} output=${JSON.stringify(out.trim())}\n`)
    expect(accepted.other).toBeGreaterThan(0)
    accepted.other = 0
  }, 90_000)
  for (const key of ['state', 'workdir', 'other'] as const) {
    test(`from the sandboxed Bash, connect() to a socket in ${key}: reported`, async () => {
      const before = accepted[key]
      const out = await bash(dial(socks[key]), places())
      process.stdout.write(`SOCKET-PROBE ${key}: connected=${accepted[key] > before} output=${JSON.stringify(out.trim())}\n`)
      expect(accepted[key]).toBe(before)   // hydra's own settings: nothing connects, whichever folder the socket is in
      expect(out).not.toContain('rc=0')
    }, 90_000)
  }
})
