import { expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { BridgeTransport } from '../bridge-transport.js'
import { AGY_API_KEY_FILE, AgyEngine } from '../engines/agy-engine.js'
import { AGY_HOOKS_CONFIG, AGY_MCP_CONFIG } from '../engines/agy-config.js'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { SOCK_PATH } from '../config.js'

// Real agy in tmux against a stub daemon socket, on the suite's private tmux server.
// It calls the real model (a few turns), so it runs only with HYDRA_AGY_E2E=1 and HYDRA_AGY_E2E_KEY=<file holding a Gemini API key>
// (agy on the private tmux server has no login). It registers the hydra tool server and hooks in the real ~/.gemini/config files and puts them back.
const key = process.env.HYDRA_AGY_E2E === '1' ? process.env.HYDRA_AGY_E2E_KEY : undefined
const run = !!key && Bun.spawnSync(['tmux', '-V']).exitCode === 0 && existsSync(process.env.HYDRA_AGY_BIN ?? `${process.env.HOME}/.local/bin/agy`)
const until = async (cond: () => boolean, ms: number) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(100); return cond() }
let pane: () => string = () => ''
const must = async (cond: () => boolean, ms: number) => { if (!(await until(cond, ms))) throw new Error(`timed out waiting for: ${cond}\n--- agy pane ---\n${pane()}`) }

test.skipIf(!run)('agy session: first turn with the reply rules, a pasted message answered through the reply tool, a plain-text answer read from the transcript', async () => {
  const engine = new AgyEngine(new ClaudeEngine(new BridgeTransport()))
  const cwd = mkdtempSync(join(tmpdir(), 'hydra-agy-'))
  const info = { sessionId: 'agy-test-1', tmuxName: 'agy-test-1' } as any
  const toolCalls: Array<{ name: string; args: any }> = []
  const registers: any[] = []
  const replies = () => toolCalls.filter(c => c.name === 'reply').map(c => String(c.args?.text ?? ''))
  try { unlinkSync(SOCK_PATH) } catch {}
  const server = createServer(s => {
    let buf = ''
    s.on('data', d => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
        if (m.type === 'register') registers.push(m)
        if (m.type === 'tool_call') { toolCalls.push({ name: m.name, args: m.args }); s.write(JSON.stringify({ type: 'tool_result', id: m.id, content: [{ type: 'text', text: 'sent' }] }) + '\n') }
      }
    })
  }).listen(SOCK_PATH)
  const saved = [AGY_MCP_CONFIG, AGY_HOOKS_CONFIG].map(file => [file, existsSync(file) ? readFileSync(file, 'utf8') : null] as const)
  copyFileSync(key!, AGY_API_KEY_FILE)
  pane = () => engine.peek(info, 60)
  try {
    await engine.launch({ sessionId: info.sessionId, tmuxName: info.tmuxName, cwd, originalCwd: cwd, model: 'gemini-4-neon-low', prompt: 'Call the reply tool with chat_id "1" and text "boot", then stop.' })
    await must(() => replies().includes('boot'), 120_000)
    expect(registers.map(r => [r.sessionId, r.connectionRole])).toEqual([[info.sessionId, 'control']])
    expect(engine.isConnected(info)).toBe(true)

    // The reply rules were in the first prompt: this answer needs them.
    expect(await engine.deliver(info, { type: 'notification', content: 'Do your instructions say that your transcript output never reaches the sender\'s chat? Answer the sender with YES or NO only.', meta: { chat_id: '1', message_id: '2', user: 'sam' } })).toEqual({ status: 'accepted', via: 'tmux-paste' })
    await must(() => replies().some(t => /^\W*yes\W*$/i.test(t)), 120_000)

    // A text-only answer (no reply tool) is what the reply guard relays: agy's hook says it has stopped, and its transcript holds the answer.
    const since = Date.now()
    await engine.deliver(info, { type: 'notification', content: 'Answer the sender with the single word PINEAPPLE in plain text. Do not use any tool.', meta: { chat_id: '1', message_id: '9', user: 'sam' } })
    await must(() => engine.turn(info, since).confirmedComplete, 120_000)
    expect(engine.turn(info, since).answer()).toContain('PINEAPPLE')
    expect(engine.turn(info, since).live).toBe('idle')
    expect(engine.usage({ ...info, sessionMetadata: { model: 'gemini-4-neon-low' } })?.percent).toBeGreaterThan(0)
    expect(engine.usageTotals(info, undefined)?.totals.outputTokens).toBeGreaterThan(0)
  } finally {
    await engine.stop(info)
    server.close()
    rmSync(AGY_API_KEY_FILE, { force: true })
    for (const [file, text] of saved) if (text === null) rmSync(file, { force: true }); else writeFileSync(file, text)
    rmSync(cwd, { recursive: true, force: true })
  }
}, 600_000)
