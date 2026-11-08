import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { oneLine, quietSend, shouldQuiet, spillIfLong, noteLine, SPILL_THRESHOLD } from '../quiet-send.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'quiet-'))
const big = () => Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n')

const nova = { name: 'nova', emoji: '💥', url: 'https://discord.com/channels/1/2' }
const glyph = { name: 'glyph', emoji: '🪶', url: 'https://discord.com/channels/1/3' }

test('the recipient line names the sender with emoji and link, then the summary', () => {
  expect(noteLine('from', nova, 'progress', 'long body\nmore', 'handoff branch fixed')).toBe('📨 from 💥 [nova](<https://discord.com/channels/1/2>) → handoff branch fixed')
})

test('the sender line names the recipient; a result or question leads with its glyph', () => {
  expect(noteLine('to', glyph, 'result', 'PR up')).toBe('📤 to 🪶 [glyph](<https://discord.com/channels/1/3>) → ✅ PR up')
  expect(noteLine('from', nova, 'question', 'main or wt/glyph?')).toBe('📨 from 💥 [nova](<https://discord.com/channels/1/2>) → ❓ main or wt/glyph?')
})

test('the emoji stays outside the link: Discord drops a masked link whose text holds an emoji', () => {
  expect(noteLine('from', nova, 'progress', 'x')).toContain('💥 [nova](')
})

test('without a thread URL the name is plain', () => {
  expect(noteLine('from', { name: 'nova', emoji: '💥' }, 'progress', 'x')).toBe('📨 from 💥 nova → x')
})

test('the line falls back to the first non-empty line without its markdown marker', () => {
  expect(noteLine('from', nova, 'result', '\n\n## **Cold score 5.4** (structure 6)\nrest')).toContain('→ ✅ Cold score 5.4 (structure 6)')
})

test('a summary that opens with the sender\'s own name drops it: the line already names the sender', () => {
  expect(oneLine('x', 'nova: handoff branch fixed', 'nova')).toBe('handoff branch fixed')
  expect(oneLine('x', '💥 Nova — handoff branch fixed', 'nova')).toBe('handoff branch fixed')
  expect(oneLine('x', 'novas are bright', 'nova')).toBe('novas are bright')
})

test('the name strip leaves hyphenated words and other sessions alone, and never empties the line', () => {
  expect(oneLine('x', 'nova-2 tests pass', 'nova')).toBe('nova-2 tests pass')
  expect(oneLine('x', 'Nova-style refactor landed', 'nova')).toBe('Nova-style refactor landed')
  expect(oneLine('x', 'nova:', 'nova')).toBe('nova:')
})

test('a summary cannot carry a link of its own: only the sender name is linked', () => {
  const line = noteLine('from', nova, 'progress', 'x', 'see [docs](https://evil.example) and [hi](!channel)')
  expect(line.match(/\]\(/g)).toHaveLength(1)
})

test('identifiers survive: underscores, hashes, backticks, angle brackets in words', () => {
  expect(oneLine('x', 'send_to_thread in my_file.ts, PR #479, `a > b`')).toBe('send_to_thread in my_file.ts, PR #479, `a > b`')
})

test('mentions in a summary cannot ping', () => {
  const line = oneLine('x', '@everyone <@123> <@&9> <!channel>')
  expect(line).not.toContain('@everyone')
  expect(line).not.toContain('<@')
  expect(line).not.toContain('<!')
})

test('a long summary is cut to one bounded line', () => {
  const line = oneLine('x'.repeat(500))
  expect(line.length).toBe(140)
  expect(line.endsWith('…')).toBe(true)
})

test('short text is delivered whole and writes nothing', () => {
  const dir = tmp()
  expect(spillIfLong('short', dir, 'a', 'b')).toEqual({ text: 'short' })
  expect(readdirSync(dir)).toEqual([])
})

test('long text is saved in full; two sends in the same millisecond do not collide', () => {
  const dir = tmp()
  const text = big()
  expect(text.length).toBeGreaterThan(SPILL_THRESHOLD)
  const a = spillIfLong(text, dir, 'cedar', 'atlas', 42)
  const b = spillIfLong(text + 'x', dir, 'cedar', 'atlas', 42)
  expect(a.path).not.toBe(b.path)
  expect(readFileSync(a.path!, 'utf8')).toBe(text)
  expect(a.text.startsWith('line 0\nline 1')).toBe(true)
  expect(a.text.endsWith(`[full text: ${a.path}]`)).toBe(true)
})

test('spill files older than a week are removed on the next spill', () => {
  const dir = tmp()
  const old = join(dir, 'old.md')
  writeFileSync(old, 'x')
  const past = new Date(Date.now() - 8 * 24 * 3600 * 1000)
  utimesSync(old, past, past)
  spillIfLong(big(), dir, 'a', 'b')
  expect(readdirSync(dir).includes('old.md')).toBe(false)
})

const a = { name: 'a', emoji: '⚡' }
const b = { name: 'b', emoji: '🟦' }

test('quietSend posts the line to each side and returns what the session is shown', async () => {
  const lines: string[] = []
  const echoes: string[] = []
  const out = await quietSend({ from: a, to: b, type: 'progress', text: 'hello', dir: tmp() }, { postLine: async l => { lines.push(l) }, postEcho: async l => { echoes.push(l) }, log: () => {} })
  expect(out).toEqual({ delivered: 'hello', posted: true, echoed: true, headline: 'hello' })
  expect(lines).toEqual(['📨 from ⚡ a → hello'])
  expect(echoes).toEqual(['📤 to 🟦 b → hello'])
})

test('an echo failure is logged and changes nothing else', async () => {
  const logs: string[] = []
  const out = await quietSend({ from: a, to: b, type: 'progress', text: 'hello', dir: tmp() }, { postLine: async () => {}, postEcho: async () => { throw new Error('Missing Access') }, log: m => logs.push(m) })
  expect(out.posted).toBe(true)
  expect(out.echoed).toBe(false)
  expect(logs[0]).toContain('Missing Access')
})

test('a note failure never stops delivery: posted is false and the session still gets its text', async () => {
  const logs: string[] = []
  const out = await quietSend({ from: a, to: b, type: 'result', text: big(), dir: tmp() }, { postLine: async () => { throw new Error('Unknown Channel') }, log: m => logs.push(m) })
  expect(out.posted).toBe(false)
  expect(out.delivered).toContain('[full text: ')
  expect(logs[0]).toContain('Unknown Channel')
})

test('a spill failure delivers the full text and still posts the note', async () => {
  const blocker = join(tmp(), 'file')
  writeFileSync(blocker, 'x')
  const lines: string[] = []
  const logs: string[] = []
  const out = await quietSend({ from: a, to: b, type: 'result', text: big(), dir: join(blocker, 'sub') }, { postLine: async l => { lines.push(l) }, log: m => logs.push(m) })
  expect(out).toEqual({ delivered: big(), posted: true, echoed: false, headline: 'line 0' })
  expect(lines).toEqual(['📨 from ⚡ a → ✅ line 0'])
  expect(logs[0]).toContain('spill failed')
})

test('a spilled message puts its path on the one-line note', async () => {
  const lines: string[] = []
  const out = await quietSend({ from: a, to: b, type: 'result', text: big(), dir: tmp() }, { postLine: async l => { lines.push(l) }, log: () => {} })
  expect(lines[0]).toMatch(/^📨 from ⚡ a → ✅ line 0 · `.+\.md`$/)
  expect(out.delivered).toContain('[full text: ')
})

test('shouldQuiet: quiet unless a protocol participant or the send carries files', () => {
  expect(shouldQuiet({ protocolParticipant: false, hasFiles: false })).toBe(true)
  expect(shouldQuiet({ protocolParticipant: true, hasFiles: false })).toBe(false)
  expect(shouldQuiet({ protocolParticipant: false, hasFiles: true })).toBe(false)
})
