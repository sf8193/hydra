// The worked example in docs/slack.md ("A worked example: an ops specialist in #ops") is what an operator copies to set up a confined
// specialist, so it must load through the real loader, clean: no error and no warning. Extracted from the doc, not copied here.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { formatIssues, loadHydraConfig } from '../load.js'
import { testLoadEnv } from './load-env.js'

const DOC = readFileSync(join(import.meta.dir, '..', '..', 'docs', 'slack.md'), 'utf8')

/** The first ```toml block after the heading that starts with `heading`. */
function blockAfter(heading: string): string {
  const at = DOC.indexOf(heading)
  if (at < 0) throw new Error(`docs/slack.md has no heading "${heading}"`)
  const open = DOC.indexOf('```toml\n', at)
  const close = DOC.indexOf('\n```', open + 8)
  if (open < 0 || close < 0) throw new Error(`no toml block after "${heading}"`)
  return DOC.slice(open + 8, close + 1)
}

describe('docs/slack.md: the ops specialist example', () => {
  const text = blockAfter('### A worked example: an ops specialist in `#ops`')
  const env = testLoadEnv({ home: '/home/op', sessionNames: ['spark'] })

  test('loads through the real loader with no error and no warning', () => {
    const r = loadHydraConfig(text, env)
    if (!r.ok) throw new Error(formatIssues(r.errors))
    expect(formatIssues(r.warnings)).toBe('')
  })
  test('is the confined specialist, its server, its place, and a home to escalate to', () => {
    const r = loadHydraConfig(text, env)
    if (!r.ok) throw new Error(formatIssues(r.errors))
    expect(r.config.specialists.ops).toMatchObject({ access: 'workdir', tools: ['Read', 'Grep', 'Glob'], mcp: ['datadog'], listens: ['slack:#ops'], allow: ['staff'], home: 'slack:#ops-escalations', workdir: '/home/op/specialists/ops' })
    expect(r.config.mcpServers?.datadog).toEqual({ name: 'datadog', command: '/usr/local/bin/datadog-mcp', tokenEnv: ['DD_API_KEY'], tools: ['search_logs', 'get_monitor'] })
    expect(r.config.places['slack:#ops']).toMatchObject({ listen: 'all', linkPreviews: false })
  })
  test('with a state .env that lacks the server\'s token variable it still loads, and says which variable to add (the one warning an operator will meet)', () => {
    const r = loadHydraConfig(text, testLoadEnv({ home: '/home/op', sessionNames: ['spark'], envFileHas: v => v !== 'DD_API_KEY' }))
    if (!r.ok) throw new Error(formatIssues(r.errors))
    expect(r.warnings.map(w => w.message)).toEqual([expect.stringContaining('needs DD_API_KEY')])
  })
  test('is refused where its folder is not its own: the same file, with the workdir a git work tree', () => {
    const r = loadHydraConfig(text, testLoadEnv({ home: '/home/op', sessionNames: ['spark'], isGitWorkTree: () => true }))
    expect(r.ok).toBe(false)
  })
  test('widening it is refused: Bash in tools, the escalation home listened on by an operator-access specialist', () => {
    expect(loadHydraConfig(text.replace('tools = ["Read", "Grep", "Glob"]', 'tools = ["Read", "Bash"]'), env).ok).toBe(false)
    const withListener = text + '\n[specialists.byte2]\nworkdir = "~/agents/b"\nlistens = ["slack:#ops-escalations"]\nallow = []\n'
    const r = loadHydraConfig(withListener, env)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(formatIssues(r.errors)).toContain('specialists.ops.home')
  })
})
