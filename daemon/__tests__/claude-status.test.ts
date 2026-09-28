import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { blockedReason, readClaudeStatus } from '../engines/claude-status.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-status-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const put = (name: string, o: Record<string, unknown>) => writeFileSync(join(dir, name), JSON.stringify(o))
const DEAD_PID = 2 ** 22 + 12345 // beyond pid_max on macOS/Linux defaults

describe('readClaudeStatus', () => {
  test('finds the file by tmux name, not pid', () => {
    put('1.json', { pid: process.pid, sessionId: 'sid-a', status: 'idle', tmux: 'cedar:@5.%9', updatedAt: 1 })
    expect(readClaudeStatus('cedar', dir)).toEqual({ sessionId: 'sid-a', status: 'idle' })
  })
  test('other tmux names do not match; prefix is not enough', () => {
    put('1.json', { pid: process.pid, sessionId: 'sid-a', status: 'idle', tmux: 'cedar2:@5.%9' })
    expect(readClaudeStatus('cedar', dir)).toBeNull()
  })
  test('dead pid (kill -9 leftover) is ignored', () => {
    put('1.json', { pid: DEAD_PID, sessionId: 'sid-a', status: 'idle', tmux: 'cedar:@5.%9' })
    expect(readClaudeStatus('cedar', dir)).toBeNull()
  })
  test('waiting and busy are reported as-is', () => {
    put('1.json', { pid: process.pid, sessionId: 's', status: 'waiting', waitingFor: 'permission prompt', tmux: 'cedar:@5.%9' })
    expect(readClaudeStatus('cedar', dir)).toMatchObject({ status: 'waiting', waitingFor: 'permission prompt' })
    put('1.json', { pid: process.pid, sessionId: 's', status: 'busy', tmux: 'cedar:@5.%9' })
    expect(readClaudeStatus('cedar', dir)?.status).toBe('busy')
  })
  test('two live matches for one tmux name are ambiguous -> null; a dead twin does not count', () => {
    put('1.json', { pid: process.pid, sessionId: 'a', status: 'idle', tmux: 'cedar:@5.%9' })
    put('2.json', { pid: process.ppid, sessionId: 'b', status: 'busy', tmux: 'cedar:@5.%10' })
    expect(readClaudeStatus('cedar', dir)).toBeNull()
    rmSync(join(dir, '2.json'))
    put('3.json', { pid: DEAD_PID, sessionId: 'c', status: 'busy', tmux: 'cedar:@5.%10' })
    expect(readClaudeStatus('cedar', dir)?.sessionId).toBe('a')
  })
  test('missing dir, junk json, missing fields -> null', () => {
    expect(readClaudeStatus('cedar', join(dir, 'nope'))).toBeNull()
    writeFileSync(join(dir, 'x.json'), '{not json')
    put('y.json', { pid: process.pid, tmux: 'cedar:@5.%9' })
    put('z.json', { pid: process.pid, sessionId: 's', status: 'idle' })
    expect(readClaudeStatus('cedar', dir)).toBeNull()
  })
})

describe('blockedReason', () => {
  const st = (o: Record<string, unknown>) => ({ sessionId: 's', status: 'waiting', ...o })
  test('passes the raw reason through, unknown values included', () => {
    expect(blockedReason(st({ waitingFor: 'permission prompt' }))).toBe('permission prompt')
    expect(blockedReason(st({ waitingFor: 'some future state' }))).toBe('some future state')
  })
  test('null unless status is waiting (or unreadable)', () => {
    expect(blockedReason(st({ status: 'busy', waitingFor: 'stale' }))).toBeNull()
    expect(blockedReason(null)).toBeNull()
  })
  test('waiting with no reason says "waiting"', () => {
    expect(blockedReason(st({}))).toBe('waiting')
    expect(blockedReason(st({ waitingFor: '`\n ' }))).toBe('waiting')
  })
  test('strips backticks/newlines and caps length', () => {
    expect(blockedReason(st({ waitingFor: 'a`b\nc' }))).toBe('a b c')
    expect(blockedReason(st({ waitingFor: 'x'.repeat(500) }))?.length).toBe(120)
    expect(blockedReason(st({ waitingFor: '😀'.repeat(200) }))).toBe('😀'.repeat(120))
    expect(blockedReason(st({ waitingFor: 'a\u202eb\x1b[31mc' }))).toBe('a b [31mc')
  })
})
