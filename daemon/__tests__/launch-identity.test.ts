// LaunchResult.identity omits ids the launch did not assign (peer c2-3 #5).
import { expect, test } from 'bun:test'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { withFakeTmux } from './fake-tmux.js'

const input = { sessionId: 'li-s', tmuxName: 'li-t', cwd: '/tmp', originalCwd: '/tmp', model: 'claude-opus-4-1', prompt: 'hi' }

test('Claude: a fresh launch assigns claudeSessionId; resume and fork learn none and omit the key', async () => {
  const fake = withFakeTmux()
  const write = process.stderr.write
  process.stderr.write = (() => true) as any
  try {
    const claude = new ClaudeEngine({} as any)
    const fresh = await claude.launch(input)
    expect(fresh.identity.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/)
    for (const extra of [{ resumeFrom: 'C-old' }, { forkFrom: { claudeSessionId: 'C-parent' } }]) {
      const r = await claude.launch({ ...input, ...extra })
      expect(r.identity).toEqual({})
      expect('claudeSessionId' in r.identity).toBe(false)
    }
  } finally { process.stderr.write = write; fake.restore() }
})
