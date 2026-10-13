import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { createServer, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { BridgeTransport } from '../bridge-transport.js'
import { computeToolsForSession } from '../bridge-tools.js'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { OmpEngine } from '../engines/omp-engine.js'
import { SOCK_PATH } from '../config.js'

// Real omp in tmux against a stub daemon socket, on the suite's private tmux server.
// It calls the real model (a handful of turns), so it runs only with HYDRA_OMP_E2E=1 (omp logged in, HYDRA_OMP_BIN set).
const run = process.env.HYDRA_OMP_E2E === '1' && Bun.spawnSync(['tmux', '-V']).exitCode === 0
const until = async (cond: () => boolean, ms: number) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(100); return cond() }

test.skipIf(!run)('omp session: first turn, reply rules, one bridge, no second MCP', async () => {
  const transport = new BridgeTransport()
  const engine = new OmpEngine(new ClaudeEngine(transport))
  const cwd = mkdtempSync(join(tmpdir(), 'hydra-omp-'))
  const mcpMarker = join(cwd, 'second-mcp-started')
  // A cwd .mcp.json that would start a second MCP server (as hydra's own .mcp.json does for Discord).
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { second: { command: 'sh', args: ['-c', `touch ${mcpMarker}; sleep 600`] } } }))

  const toolCalls: Array<{ name: string; args: any }> = []
  const replies = () => toolCalls.filter(c => c.name === 'reply').map(c => String(c.args?.text ?? ''))
  const registers: string[] = []
  let sock: Socket | undefined

  try { unlinkSync(SOCK_PATH) } catch {}
  const server = createServer(s => {
    sock = s
    let buf = ''
    s.on('data', d => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
        if (m.type === 'register') {
          registers.push(m.sessionId)
          transport.set(m.sessionId, { sessionId: m.sessionId, socket: s, buf: '' })
          // The real tool surface of a thread session: every schema must be accepted by omp and the API.
          const tools = computeToolsForSession('thread_owner', new Set(['protocol_context', 'protocol_spawn']))
          s.write(JSON.stringify({ type: 'registered', sessionId: m.sessionId, tools }) + '\n')
        }
        if (m.type === 'tool_call') {
          toolCalls.push({ name: m.name, args: m.args })
          s.write(JSON.stringify({ type: 'tool_result', id: m.id, content: [{ type: 'text', text: 'sent' }] }) + '\n')
        }
      }
    })
  }).listen(SOCK_PATH)

  const info = { sessionId: 'omp-test-1', tmuxName: 'omp-test-1' } as any
  try {
    // Production-shaped model id (with [1m]) and a non-empty spawn prompt: the FIRST turn must be able to call `reply`.
    await engine.launch({ sessionId: info.sessionId, tmuxName: info.tmuxName, cwd, originalCwd: cwd, model: 'claude-sonnet-5-5[1m]', prompt: 'Call the reply tool with text "boot", then stop.' })
    expect(await until(() => replies().includes('boot'), 90_000)).toBe(true)
    expect(engine.isConnected(info)).toBe(true)

    // A later turn still has the reply rules (they ride in the system prompt, not the first message). The rule text is not in any tool description.
    await engine.deliver(info, { type: 'notification', content: 'Do your instructions say that your transcript output never reaches the sender\'s chat? Answer the sender with YES or NO only.', meta: { chat_id: '1', message_id: '2', user: 'sam' } })
    expect(await until(() => replies().some(t => /^\W*yes\W*$/i.test(t)), 90_000)).toBe(true)

    // A text-only answer (no reply tool) is what the reply guard relays: the engine reads omp's own session file and reports the turn complete with its text.
    const since = Date.now()
    await engine.deliver(info, { type: 'notification', content: 'Answer the sender with the single word PINEAPPLE in plain text. Do not use any tool.', meta: { chat_id: '1', message_id: '9', user: 'sam' } })
    expect(await until(() => engine.turn(info, since).confirmedComplete, 90_000)).toBe(true)
    expect(engine.turn(info, since).answer()).toContain('PINEAPPLE')
    // omp's own file also gives the context size.
    expect(engine.usage({ ...info, sessionMetadata: { model: 'claude-sonnet-5-5[1m]' } })?.percent).toBeGreaterThan(0)

    // A Task subagent re-runs the extension in the same process: still one registration.
    await engine.deliver(info, { type: 'notification', content: 'Use the task tool to start a subagent that only answers "ok", then call reply with text "sub-done".', meta: { chat_id: '1', message_id: '5', user: 'sam' } })
    expect(await until(() => replies().includes('sub-done'), 120_000)).toBe(true)
    expect(registers).toEqual([info.sessionId])

    // omp did not load the cwd .mcp.json, and no second Discord-style MCP connection came up.
    expect(existsSync(mcpMarker)).toBe(false)
    expect(engine.peek(info, 400)).not.toContain('Connected to MCP server')
  } finally {
    await engine.stop(info)
    server.close(); sock?.destroy()
    rmSync(cwd, { recursive: true, force: true })
  }
}, 600_000)
