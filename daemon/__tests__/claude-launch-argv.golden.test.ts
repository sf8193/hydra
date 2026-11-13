// Golden: the Claude launch command for every non-scoped shape, byte for byte (after masking the one random UUID and
// the temp state dir). Written against the code before scoped specialists and kept green through them: an
// `access = "operator"` specialist and every non-specialist session must launch exactly as they always have.
import { expect, test } from 'bun:test'
import { ClaudeEngine } from '../engines/claude-engine.js'
import { STATE_DIR, CLAUDE_CONFIG, SOCK_PATH } from '../config.js'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { withFakeTmux } from './fake-tmux.js'

const base = { sessionId: 'g-s', tmuxName: 'g-t', cwd: '/work', originalCwd: '/work', model: 'claude-opus-4-1', prompt: "it's a prompt" }

/** The shell command tmux was asked to run, with run-specific values masked. */
function launchCommand(fake: ReturnType<typeof withFakeTmux>): string {
  const call = fake.calls().find(c => c.startsWith('new-session'))
  if (!call) throw new Error('no new-session call: ' + fake.calls().join('\n'))
  return call
    .replaceAll(STATE_DIR, '<state>').replaceAll(CLAUDE_CONFIG, '<claude-config>').replaceAll(SOCK_PATH, '<sock>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
}

async function launched(extra: Record<string, unknown>): Promise<string> {
  const fake = withFakeTmux()
  const write = process.stderr.write
  process.stderr.write = (() => true) as any
  try {
    mkdirSync(join(STATE_DIR, 'mods', 'hydra'), { recursive: true })
    writeFileSync(join(STATE_DIR, 'mods', 'hydra', 'plugin.json'), '{}')
    await new ClaudeEngine({} as any).launch({ ...base, ...extra } as any)
    return launchCommand(fake)
  } finally { process.stderr.write = write; fake.restore() }
}

test('fresh, resume and fork launches are pinned byte for byte', async () => {
  expect(await launched({})).toMatchSnapshot('fresh')
  expect(await launched({ resumeFrom: 'C-old' })).toMatchSnapshot('resume')
  expect(await launched({ forkFrom: { claudeSessionId: 'C-parent' } })).toMatchSnapshot('fork')
  expect(await launched({ tools: ['Read', 'Grep'], disallowedTools: ['Bash'] })).toMatchSnapshot('tools-and-disallowed')
})
