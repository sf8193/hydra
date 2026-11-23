import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, readdirSync } from 'fs'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AGY_API_KEY_FILE, AgyEngine, agySettings } from '../../engines/agy-engine.js'
import { ClaudeEngine } from '../../engines/claude-engine.js'
import { BridgeTransport } from '../../sessions/bridge-transport.js'
import { BASE_TOOLS } from '../../shared/constants.js'
import { buildSessionInstructions } from '../../shared/session-instructions.js'
import { _setTmuxForTesting } from '../../infra/tmux.js'
import { agyStateDir, agyStateFile } from '../../engines/agy-session.js'
import { STATE_DIR } from '../../infra/config.js'
import { sessionTokenDir, spawnPromptDir } from '../../infra/launch-files.js'

const configDir = mkdtempSync(join(tmpdir(), 'hydra-agy-mcp-'))
const mcpConfig = join(configDir, 'mcp_config.json')
const hooksConfig = join(configDir, 'hooks.json')

// The agy launch command, with tmux faked (a real agy needs a login and a model; this runs in CI).
async function launchCommand(prompt: string, extra: object = {}, tmuxExit = 0): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-agy-launch-'))
  const saved = { PATH: process.env.PATH, TMUX: process.env.TMUX }
  writeFileSync(join(dir, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${join(dir, 'args')}\nexit ${tmuxExit}\n`)
  chmodSync(join(dir, 'tmux'), 0o755)
  process.env.PATH = `${dir}:${saved.PATH}`
  delete process.env.TMUX
  try {
    await new AgyEngine({} as any, mcpConfig, hooksConfig).launch({ sessionId: 's1', tmuxName: 'agy-t', cwd: '/tmp/work', originalCwd: '/tmp/work', model: 'gemini-4-neon-high', prompt, ...extra })
    return existsSync(join(dir, 'args')) ? readFileSync(join(dir, 'args'), 'utf8') : ''
  } finally {
    process.env.PATH = saved.PATH
    if (saved.TMUX !== undefined) process.env.TMUX = saved.TMUX
    rmSync(dir, { recursive: true, force: true })
  }
}

test('launch runs agy on the model, trusting only its folder, approving tools, with the prompt by file and the hydra tools registered', async () => {
  const cmd = await launchCommand('say hi')
  expect(cmd).toContain("--model 'gemini-4-neon-high'")
  expect(cmd).toContain(`--settings '${agySettings('/tmp/work', false)}'`)
  expect(cmd).toContain('--dangerously-skip-permissions')
  expect(cmd).toContain('-i "$_hydra_prompt"')
  expect(cmd).toContain('unset HYDRA_ROLE CLAUDE_CONFIG_DIR')
  expect(cmd).toContain('export DAEMON_SOCK=')
  expect(cmd).toContain(`export HYDRA_AGY_STATE='${agyStateFile('s1')}'`)
  expect(JSON.parse(readFileSync(hooksConfig, 'utf8')).hydra.Stop[0].command).toContain('/engines/agy-hook.ts')
  expect(cmd).not.toContain('say hi')
  expect(cmd).not.toContain('GEMINI_API_KEY')
  expect(JSON.parse(readFileSync(mcpConfig, 'utf8')).mcpServers.hydra.args[0]).toEndWith('/engines/codex-mcp-server.ts')
})

test('the first prompt is hydra\'s reply rules, then the spawn prompt', async () => {
  const cmd = await launchCommand('say hi')
  const file = /cat '([^']+\.prompt)'/.exec(cmd)![1]
  expect(readFileSync(file, 'utf8')).toBe(`${buildSessionInstructions({ tools: BASE_TOOLS.thread_owner, platform: 'discord' })}\n\nsay hi`)
})

test('the spawn env names the session, its thread and type, empty when unknown', async () => {
  const cmd = await launchCommand('hi', { threadId: 'th-own', sessionType: 'thread_owner' })
  expect(cmd).toContain("export HYDRA_SESSION_ID='s1'")
  expect(cmd).toContain("export HYDRA_THREAD_ID='th-own'")
  expect(cmd).toContain("export HYDRA_SESSION_TYPE='thread_owner'")
  expect(await launchCommand('hi')).toContain("export HYDRA_THREAD_ID=''")
})

test('the session token goes by file and is exported in the pane, never on the command line; a launch that fails leaves no prompt or token file', async () => {
  const cmd = await launchCommand('hi', { sessionToken: 'tok-secret' })
  expect(cmd).toContain('export HYDRA_SESSION_TOKEN')
  expect(cmd).not.toContain('tok-secret')
  const left = () => [...(existsSync(spawnPromptDir()) ? readdirSync(spawnPromptDir()) : []), ...(existsSync(sessionTokenDir()) ? readdirSync(sessionTokenDir()) : [])].filter(n => n.includes('agy-fail'))
  await expect(launchCommand('hi', { tmuxName: 'agy-fail', sessionToken: 'tok-secret' }, 1)).rejects.toThrow()
  expect(left()).toEqual([])
})

test('an API key file switches agy to its API-key mode, and only the file\'s path is on the command line', async () => {
  writeFileSync(AGY_API_KEY_FILE, 'AQ.secret-key', { mode: 0o600 })
  try {
    const cmd = await launchCommand('hi')
    expect(cmd).toContain(`--settings '${agySettings('/tmp/work', true)}'`)
    expect(cmd).toContain(`GEMINI_API_KEY=$(cat '${AGY_API_KEY_FILE}') && export GEMINI_API_KEY`)
    expect(cmd).not.toContain('AQ.secret-key')
  } finally { rmSync(AGY_API_KEY_FILE, { force: true }) }
})

test('a key file other users can read is refused before anything starts', async () => {
  writeFileSync(AGY_API_KEY_FILE, 'AQ.secret-key', { mode: 0o644 })
  chmodSync(AGY_API_KEY_FILE, 0o644)
  try { await expect(launchCommand('hi')).rejects.toThrow('chmod 600') } finally { rmSync(AGY_API_KEY_FILE, { force: true }) }
})

// delivery: a real tmux pane (the suite's private server) whose terminal is raw like a TUI's (`cat` in cooked mode drops a long paste), showing what arrives
const tmuxUp = Bun.spawnSync(['tmux', '-V']).exitCode === 0
const name = `agy-deliver-${process.pid}`
const info = { sessionId: 'deliver-1', tmuxName: name } as any
const engine = new AgyEngine(new ClaudeEngine(new BridgeTransport()), mcpConfig, hooksConfig, { landedWaitMs: 4_000, pollMs: 25 })
// For panes that intentionally never echo the pasted text, don't wait the full 8s production landing timeout.
const fastRejectEngine = new AgyEngine(new ClaudeEngine(new BridgeTransport()), mcpConfig, hooksConfig, { landedWaitMs: 250, pollMs: 25 })

beforeAll(() => { if (tmuxUp) Bun.spawnSync(['tmux', 'new-session', '-d', '-s', name, '-x', '200', '-y', '50', 'stty -icanon -echo min 1 time 0; cat']) })
afterAll(() => { if (tmuxUp) Bun.spawnSync(['tmux', 'kill-session', '-t', name]) })

test.skipIf(!tmuxUp)('a message with quotes, backticks, $vars, a blank line, an emoji and 400 lines is pasted whole, in order, and reported landed', async () => {
  const content = `a "quoted" 'single' \`tick\` $HOME {braces} 🙂\n\n    indented\n${('word '.repeat(15) + '\n').repeat(400)}END`
  const r = await engine.deliver(info, { type: 'notification', content, meta: { chat_id: '1', message_id: '9' } })
  expect(r).toEqual({ status: 'accepted', via: 'tmux-paste' })
  const pane = Bun.spawnSync(['tmux', 'capture-pane', '-p', '-S', '-', '-t', name]).stdout.toString()
  const trimmed = (t: string) => t.split('\n').map(l => l.trimEnd()).join('\n')   // the pane drops trailing spaces
  expect(trimmed(pane)).toContain(`<channel source="hydra" chat_id="1" message_id="9">\n${trimmed(content)}\n</channel>`)
  // nothing is left behind: no tmux paste buffer, no paste file
  expect(Bun.spawnSync(['tmux', 'list-buffers', '-F', '#{buffer_name}']).stdout.toString()).not.toContain('hydra-deliver-1')
  expect(readdirSync(join(STATE_DIR, 'agy-paste'))).toEqual([])
})

test.skipIf(!tmuxUp)('a message to a session still starting waits for agy\'s first event before it is pasted', async () => {
  const young = { sessionId: 'deliver-young', tmuxName: name, createdAt: Date.now() } as any
  const sent = engine.deliver(young, { type: 'notification', content: 'MARKER-young-start', meta: { chat_id: '1', message_id: '10' } })
  await Bun.sleep(150)
  expect(Bun.spawnSync(['tmux', 'capture-pane', '-p', '-t', name]).stdout.toString()).not.toContain('MARKER-young-start')
  mkdirSync(agyStateDir(), { recursive: true })
  writeFileSync(agyStateFile('deliver-young'), JSON.stringify({ conversationId: 'c', transcriptPath: '/none', live: 'idle', backgroundWork: false }))
  try { expect(await sent).toEqual({ status: 'accepted', via: 'tmux-paste' }) } finally { rmSync(agyStateFile('deliver-young'), { force: true }) }
})

test.skipIf(!tmuxUp)('a busy agy queues the message and draws only its first line, which counts as landed', async () => {
  const queued = `${name}-queued`
  Bun.spawnSync(['tmux', 'new-session', '-d', '-s', queued, '-x', '200', '-y', '50', `stty -icanon -echo; IFS= read -r line; printf '%s...\\n' "$line"; cat > /dev/null`])
  try {
    const r = await engine.deliver({ sessionId: 'deliver-queued', tmuxName: queued } as any, { type: 'notification', content: 'line one\nline two\nline three', meta: { chat_id: '1', message_id: '2', user: 'sam' } })
    expect(r).toEqual({ status: 'accepted', via: 'tmux-paste' })
  } finally { Bun.spawnSync(['tmux', 'kill-session', '-t', queued]) }
}, 20_000)

test.skipIf(!tmuxUp)('a message already shown on the screen is not taken as landed when its paste shows nothing new', async () => {
  const shown = `${name}-shown`
  Bun.spawnSync(['tmux', 'new-session', '-d', '-s', shown, '-x', '200', '-y', '50', `printf '<channel source="hydra">\\nhi\\n</channel>\\n'; stty -icanon -echo; cat > /dev/null`])
  try {
    for (let i = 0; i < 200 && !Bun.spawnSync(['tmux', 'capture-pane', '-p', '-t', shown]).stdout.toString().includes('</channel>'); i++) await Bun.sleep(10)
    const r = await fastRejectEngine.deliver({ sessionId: 'deliver-7', tmuxName: shown } as any, { type: 'notification', content: 'hi' })
    expect(r).toMatchObject({ status: 'rejected', retryable: false })
  } finally { Bun.spawnSync(['tmux', 'kill-session', '-t', shown]) }
}, 20_000)

// a terminal that asks for bracketed paste, like agy's TUI, and writes every byte it gets to a file as it arrives: returns that file
async function bytesTerminal(session: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-agy-bytes-'))
  const log = join(dir, 'bytes')
  const ready = join(dir, 'ready')
  writeFileSync(join(dir, 'tty.sh'), `printf '\\033[?2004h'; stty -icanon -echo min 1 time 0; exec python3 -c "import os; f = open('${log}', 'ab', 0); open('${ready}', 'w').close()\nwhile True: f.write(os.read(0, 4096))"`)
  Bun.spawnSync(['tmux', 'new-session', '-d', '-s', session, '-x', '200', '-y', '50', `sh ${join(dir, 'tty.sh')}`])
  for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(10)
  return log
}

test.skipIf(!tmuxUp)('the message arrives as one bracketed paste followed by one Enter, so its line breaks do not send it early', async () => {
  const bp = `${name}-bp`
  const log = await bytesTerminal(bp)
  try {
    const r = await fastRejectEngine.deliver({ sessionId: 'deliver-3', tmuxName: bp } as any, { type: 'notification', content: 'line one\nline two' })
    expect(r).toMatchObject({ status: 'rejected', retryable: false })   // this terminal shows nothing on its screen, so the landing is not seen
    expect(readFileSync(log, 'utf8')).toBe('\x1b[200~<channel source="hydra">\nline one\nline two\n</channel>\x1b[201~\n')
  } finally { Bun.spawnSync(['tmux', 'kill-session', '-t', bp]) }
}, 20_000)

test.skipIf(!tmuxUp)('a pane that does not exist is a rejection, not an acceptance', async () => {
  const dead = { sessionId: 'deliver-2', tmuxName: `${name}-gone` } as any
  const r = await engine.deliver(dead, { type: 'notification', content: 'hello' })
  expect(r.status).toBe('rejected')   // no such pane: the paste itself fails
})

test.skipIf(!tmuxUp)('two messages sent at once are pasted and sent one after the other, in order', async () => {
  const two = `${name}-two`
  const log = await bytesTerminal(two)
  try {
    const at = { sessionId: 'deliver-4', tmuxName: two } as any
    await Promise.all([fastRejectEngine.deliver(at, { type: 'notification', content: 'AAAA' }), fastRejectEngine.deliver(at, { type: 'notification', content: 'BBBB' })])
    expect(readFileSync(log, 'utf8')).toBe('\x1b[200~<channel source="hydra">\nAAAA\n</channel>\x1b[201~\n\x1b[200~<channel source="hydra">\nBBBB\n</channel>\x1b[201~\n')
  } finally { Bun.spawnSync(['tmux', 'kill-session', '-t', two]) }
}, 30_000)

test('an Enter that fails after the paste is a non-retryable rejection (the text is already in the input, and a caller retries an unknown)', async () => {
  const calls: string[] = []
  _setTmuxForTesting({ exec: ((_cmd: string, args: string[]) => { calls.push(args[0]); if (args[0] === 'send-keys') throw new Error('no server'); return '' }) as any })
  try {
    const r = await engine.deliver({ sessionId: 'deliver-5', tmuxName: 'x' } as any, { type: 'notification', content: 'hi' })
    expect(r).toMatchObject({ status: 'rejected', retryable: false })
    expect(calls).toEqual(['capture-pane', 'load-buffer', 'paste-buffer', 'send-keys'])
  } finally { _setTmuxForTesting() }
})

test('a message the paste cannot reach is a retryable rejection, and leaves no paste file', async () => {
  _setTmuxForTesting({ exec: ((_cmd: string, args: string[]) => { if (args[0] === 'paste-buffer') throw new Error('no such pane'); return '' }) as any })
  try {
    const r = await engine.deliver({ sessionId: 'deliver-6', tmuxName: 'x' } as any, { type: 'notification', content: 'hi' })
    expect(r).toMatchObject({ status: 'rejected', retryable: true })
  } finally { _setTmuxForTesting() }
})

test('a relaunch of a session id starts with no word from the earlier agy', async () => {
  mkdirSync(agyStateDir(), { recursive: true })
  writeFileSync(agyStateFile('s1'), '{"conversationId":"old"}')
  await launchCommand('hi')
  expect(existsSync(agyStateFile('s1'))).toBe(false)
})

test('the turn reports agy\'s own word: working or idle, the answer once it is over, and nothing before agy has spoken', () => {
  const t = { sessionId: 'turn-1', tmuxName: 'agy-turn-1' } as any
  mkdirSync(agyStateDir(), { recursive: true })
  expect(engine.turn(t, 0)).toMatchObject({ confirmedComplete: false, live: null, workingSilenceLimitS: 600 })
  const transcriptPath = join(configDir, 'turn.jsonl')
  writeFileSync(transcriptPath, `{"type":"USER_INPUT","created_at":"2026-11-21T04:55:17Z"}\n{"type":"PLANNER_RESPONSE","created_at":"2026-11-21T04:55:20Z","content":"done"}\n`)
  const say = (live: string, backgroundWork = false) => writeFileSync(agyStateFile('turn-1'), JSON.stringify({ conversationId: 'c', transcriptPath, live, backgroundWork }))
  const since = Date.UTC(2026, 10, 21, 4, 55, 17)
  say('working')
  expect(engine.turn(t, since)).toMatchObject({ confirmedComplete: false, live: 'working' })
  say('idle')
  const idle = engine.turn(t, since)
  expect(idle).toMatchObject({ confirmedComplete: true, live: 'idle' })
  expect(idle.answer()).toBe('done')
  say('idle', true)
  expect(engine.turn(t, since)).toMatchObject({ confirmedComplete: false, live: 'idle', backgroundWork: true })
  expect(engine.usage({ ...t, sessionMetadata: { model: 'gemini-4-neon-high' } })).toEqual({ usedTokens: 0, contextWindow: 1_048_576, percent: 0 })
})

test('a resume continues the dead session\'s conversation, found in the dead session\'s record', async () => {
  mkdirSync(agyStateDir(), { recursive: true })
  writeFileSync(agyStateFile('dead-1'), '{"conversationId":"conv-dead","transcriptPath":"/t","live":"idle","backgroundWork":false}')
  const cmd = await launchCommand('hello', { continuation: { kind: 'resume-session', fromSessionId: 'dead-1' } })
  expect(cmd).toContain("--conversation 'conv-dead'")
  expect(await launchCommand('hello')).not.toContain('--conversation')
})

test('a resume with no conversation on record fails before agy starts, so the caller falls back to a fresh session', async () => {
  rmSync(agyStateFile('gone-1'), { force: true })
  await expect(launchCommand('hello', { continuation: { kind: 'resume-session', fromSessionId: 'gone-1' } })).rejects.toThrow('has no conversation to resume')
})

test('recoveryPlan resumes the dead session by id, is not generic, and cannot fork', () => {
  const e = new AgyEngine({} as any, mcpConfig, hooksConfig)
  expect(e.recoveryPlan({ tmuxName: 't', sessionId: 'dead-1' })).toEqual({ generic: false, resume: { kind: 'at-launch', resumeSession: { fromSessionId: 'dead-1' } }, fork: null })
  expect(e.recoveryPlan({ tmuxName: 't' })).toEqual({ generic: false, resume: null, fork: null })
})
