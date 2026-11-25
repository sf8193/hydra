// A harness for what a write-confined specialist's tools can do, from hydra's own settings (`confinementSettings`) run by the real `claude -p`, not from a profile text.
// `claude -p` talks to a stub API served here that asks for exactly one tool call per run (Bash or Read), so no model is involved and nothing is declined.
// Everything it makes is in a throwaway HOME. Used by the *.live.test.ts files, which are off unless HYDRA_LIVE_CLAUDE=1.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { confinementSettings } from '../../engines/write-confinement.js'
import { readDenyRoots } from '../../config/write-confinement.js'

export type ToolCall = { name: string; input: Record<string, unknown> }

/** Beyond the one scripted call: servers the launch lists (their MCP config is written and passed, their tools loaded up front) and the settings' server rules. */
export type RunExtra = { /** Changes the settings object before it is written (a test of one setting). */ tweak?: (settings: any) => void; servers?: { name: string; command: string; args: string[]; denyTools?: string[] }[] }

export type Probe = {
  fake: string; home: string; state: string; workdir: string; configDir: string
  /** The env a subprocess gets: the throwaway HOME, so no tool reads the operator's own files. */
  env(): Record<string, string>
  /** The places hydra's own list denies this probe's specialist. */
  places(): string[]
  /** Runs one tool call as the one call of a real `claude -p` started with hydra's confinement settings; returns what the tool printed. */
  run(call: ToolCall, cannotRead?: string[], extra?: RunExtra): Promise<string>
  /** What the last run's Claude Code wrote to its --debug-file (what the start check reads). */
  lastDebug(): string
  stop(): void
}

const realpath = (p: string) => { try { return realpathSync(p) } catch { return p } }
const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
const message = (content: unknown[], stop: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })

export function makeProbe(prefix: string): Probe {
  const fake = realpath(mkdtempSync(join(tmpdir(), `${prefix}-`)))
  const home = join(fake, 'home'), state = join(home, 'state'), workdir = join(home, 'work'), configDir = join(fake, 'claude-config')
  for (const d of [state, workdir, configDir]) mkdirSync(d, { recursive: true, mode: 0o700 })
  const env = (): Record<string, string> => ({ PATH: process.env.PATH!, USER: process.env.USER ?? 'user', HOME: home })
  let next: ToolCall = { name: 'Bash', input: { command: 'true' } }
  let offered = new Set<string>()   // the tool names the last request offered the model
  const api = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req: Request): Promise<Response> {
      if (!new URL(req.url).pathname.includes('/messages') || req.method !== 'POST') return Response.json({})
      const body: any = await req.json().catch(() => ({}))
      const last = body.messages?.[body.messages.length - 1]
      const afterTool = Array.isArray(last?.content) && last.content.some((c: any) => c.type === 'tool_result')
      offered = new Set((body.tools ?? []).map((t: any) => t.name))
      const useTool = offered.has(next.name) && !afterTool
      const content: any[] = useTool ? [{ type: 'tool_use', id: 'toolu_1', name: next.name, input: { ...(next.name === 'Bash' ? { description: 'probe' } : {}), ...next.input } }] : [{ type: 'text', text: 'done' }]
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
    },
  })
  let lastDebugFile = ''
  const places = (): string[] => readDenyRoots({ home, stateDir: state, realpath }, workdir, [], [])
  return {
    fake, home, state, workdir, configDir, env, places,
    lastDebug: () => { try { return readFileSync(lastDebugFile, 'utf8') } catch { return '' } },
    async run(call, cannotRead = places(), extra = {}) {
      next = call
      lastDebugFile = join(fake, `debug-${Math.random().toString(36).slice(2)}.log`)
      const settings = join(fake, `settings-${Math.random().toString(36).slice(2)}.json`)
      const servers = (extra.servers ?? []).map(x => ({ name: x.name, command: x.command, tokenEnv: [], profileArgs: x.args, profileEnv: {}, ...(x.denyTools && { denyTools: x.denyTools }) }))
      const body = confinementSettings({ denyCommands: [], cannotRead, workdir, servers, builtins: [] }); extra.tweak?.(body)
      writeFileSync(settings, JSON.stringify(body))
      const mcp = join(fake, `mcp-${Math.random().toString(36).slice(2)}.json`)
      writeFileSync(mcp, JSON.stringify({ mcpServers: Object.fromEntries(servers.map(x => [x.name, { type: 'stdio', command: x.command, args: x.profileArgs, env: {} }])) }))
      const p = Bun.spawn(['claude', '-p', 'go', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--settings', settings, '--debug-file', lastDebugFile, ...(servers.length ? ['--mcp-config', mcp] : [])], {
        cwd: workdir, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
        env: { ...env(), ENABLE_CLAUDEAI_MCP_SERVERS: 'false', ENABLE_TOOL_SEARCH: 'false', ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`, ANTHROPIC_API_KEY: 'sk-ant-fake', CLAUDE_CONFIG_DIR: configDir },
      })
      const timer = setTimeout(() => p.kill(), 60_000)   // only the process this harness started, by its own handle
      const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      await p.exited
      clearTimeout(timer)
      for (const line of out.split('\n')) {
        try { const j = JSON.parse(line); if (j.tool_use_result?.stdout !== undefined) return `${j.tool_use_result.stdout}${j.tool_use_result.stderr ?? ''}` } catch { /* not a JSON line */ }
        try {
          const j = JSON.parse(line); const c = j.message?.content
          if (Array.isArray(c)) for (const x of c) if (x.type === 'tool_result') return typeof x.content === 'string' ? x.content : JSON.stringify(x.content)
        } catch { /* ditto */ }
      }
      // A tool the settings deny is not offered to the model at all: that is its refusal.
      if (!offered.has(call.name)) return `TOOL NOT OFFERED: ${call.name}`
      throw new Error(`the ${call.name} tool printed nothing in the run: ${out.slice(0, 600)}`)
    },
    stop() { api.stop(true) },
  }
}
