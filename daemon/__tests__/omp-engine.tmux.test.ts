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
// A wait that fails says what the omp pane showed: the real model, and the real API, are the flaky part.
let pane: () => string = () => ''
const must = async (cond: () => boolean, ms: number) => { if (!(await until(cond, ms))) throw new Error(`timed out waiting for: ${cond}\n--- omp pane ---\n${pane()}`) }

// A stub of the daemon's bridge socket: registers every omp session with the real thread tool surface, records its tool calls.
function stubDaemon(transport: BridgeTransport) {
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
  return { replies, registers, close: () => { server.close(); sock?.destroy() } }
}

test.skipIf(!run)('omp session: first turn, reply rules, one bridge, no second MCP', async () => {
  const transport = new BridgeTransport()
  const engine = new OmpEngine(new ClaudeEngine(transport))
  const cwd = mkdtempSync(join(tmpdir(), 'hydra-omp-'))
  const mcpMarker = join(cwd, 'second-mcp-started')
  // A cwd .mcp.json that would start a second MCP server (as hydra's own .mcp.json does for Discord).
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { second: { command: 'sh', args: ['-c', `touch ${mcpMarker}; sleep 600`] } } }))

  const daemon = stubDaemon(transport)
  const { replies, registers } = daemon

  const info = { sessionId: 'omp-test-1', tmuxName: 'omp-test-1' } as any
  pane = () => engine.peek(info, 60)
  try {
    // Production-shaped model id (with [1m]) and a non-empty spawn prompt: the FIRST turn must be able to call `reply`.
    await engine.launch({ sessionId: info.sessionId, tmuxName: info.tmuxName, cwd, originalCwd: cwd, model: 'claude-sonnet-5-5[1m]', prompt: 'Call the reply tool with chat_id "1" and text "boot", then stop.' })
    await must(() => replies().includes('boot'), 90_000)
    expect(engine.isConnected(info)).toBe(true)

    // A later turn still has the reply rules (they ride in the system prompt, not the first message). The rule text is not in any tool description.
    await engine.deliver(info, { type: 'notification', content: 'Do your instructions say that your transcript output never reaches the sender\'s chat? Answer the sender with YES or NO only.', meta: { chat_id: '1', message_id: '2', user: 'sam' } })
    await must(() => replies().some(t => /^\W*yes\W*$/i.test(t)), 90_000)

    // A text-only answer (no reply tool) is what the reply guard relays: the engine reads omp's own session file and reports the turn complete with its text.
    const since = Date.now()
    await engine.deliver(info, { type: 'notification', content: 'Answer the sender with the single word PINEAPPLE in plain text. Do not use any tool.', meta: { chat_id: '1', message_id: '9', user: 'sam' } })
    await must(() => engine.turn(info, since).confirmedComplete, 90_000)
    expect(engine.turn(info, since).answer()).toContain('PINEAPPLE')
    // omp's own file also gives the context size.
    expect(engine.usage({ ...info, sessionMetadata: { model: 'claude-sonnet-5-5[1m]' } })?.percent).toBeGreaterThan(0)
    // and the spend Raindrop reads.
    expect(engine.usageTotals(info, undefined)?.totals.outputTokens).toBeGreaterThan(0)

    // A Task subagent re-runs the extension in the same process: still one registration.
    await engine.deliver(info, { type: 'notification', content: 'Use the task tool to start a subagent that only answers "ok", then call reply with text "sub-done".', meta: { chat_id: '1', message_id: '5', user: 'sam' } })
    await must(() => replies().includes('sub-done'), 120_000)
    expect(registers).toEqual([info.sessionId])

    // omp did not load the cwd .mcp.json, and no second Discord-style MCP connection came up.
    expect(existsSync(mcpMarker)).toBe(false)
    expect(engine.peek(info, 400)).not.toContain('Connected to MCP server')
  } finally {
    await engine.stop(info)
    daemon.close()
    rmSync(cwd, { recursive: true, force: true })
  }
}, 600_000)

test.skipIf(!run)('a resumed omp session continues the dead session\'s conversation', async () => {
  const transport = new BridgeTransport()
  const engine = new OmpEngine(new ClaudeEngine(transport))
  const cwd = mkdtempSync(join(tmpdir(), 'hydra-omp-'))
  const daemon = stubDaemon(transport)
  const first = { sessionId: 'omp-res-1', tmuxName: 'omp-res-1' } as any
  const second = { sessionId: 'omp-res-2', tmuxName: 'omp-res-2' } as any
  const base = { cwd, originalCwd: cwd, model: 'claude-sonnet-5-5[1m]' }
  pane = () => `${engine.peek(first, 40)}\n=====\n${engine.peek(second, 40)}`
  try {
    await engine.launch({ ...base, sessionId: first.sessionId, tmuxName: first.tmuxName, prompt: 'The secret word is MANGO. Call the reply tool with chat_id "1" and text "noted", then stop.' })
    await must(() => daemon.replies().includes('noted'), 90_000)
    await engine.stop(first)

    await engine.launch({ ...base, sessionId: second.sessionId, tmuxName: second.tmuxName, resumeOmp: { fromSessionId: first.sessionId },
      prompt: 'What was the secret word? Call the reply tool with chat_id "1" and just that word as the text.' })
    await must(() => daemon.replies().some(t => t.toUpperCase().includes('MANGO')), 90_000)
    // The resumed session reads its own (copied) file: its turn and context are visible under the new id.
    await must(() => engine.turn(second, 0).confirmedComplete, 60_000)
  } finally {
    await engine.stop(first)
    await engine.stop(second)
    daemon.close()
    rmSync(cwd, { recursive: true, force: true })
  }
}, 600_000)
