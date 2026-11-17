// A listed server's `deny_tools`, from the settings hydra builds (`confinementSettings`) run by the real `claude -p` (no model: a stub API scripts one MCP tool call per run).
// The same call is refused with the rule and runs without it, so the refusal is the rule's. The server is a tiny stdio one (fake-mcp-server.ts) with two tools.
// Off unless asked, because it runs the real claude:
//   HYDRA_LIVE_CLAUDE=1 scripts/test.sh --isolate daemon/__tests__/write-confinement-deny-tools.live.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import { makeProbe, type Probe } from './confined-shell-probe.js'
import { confinementRules } from '../write-confinement.js'
import { confinementShortfall, readLoaded } from '../engines/claude-verify.js'

const LIVE = process.env.HYDRA_LIVE_CLAUDE === '1' && process.platform === 'darwin' && !!Bun.which('claude')

describe.skipIf(!LIVE)('deny_tools under the real claude and the real confinement settings', () => {
  let pr: Probe
  const server = (denyTools?: string[]) => ({ name: 'browser', command: process.execPath, args: [join(import.meta.dir, 'fake-mcp-server.ts')], ...(denyTools && { denyTools }) })
  beforeAll(() => { pr = makeProbe('deny-tools-live') })
  afterAll(() => { pr?.stop(); if (pr) rmSync(pr.fake, { recursive: true, force: true }) })

  test('control: with no deny_tools, the call to the server\'s tool runs', async () => {
    const out = await pr.run({ name: 'mcp__browser__unsafe_tool', input: {} }, undefined, { servers: [server()] })
    expect(out).toContain('RAN unsafe_tool')
  }, 90_000)
  test('with deny_tools naming it, the same call is refused and the tool never runs', async () => {
    const out = await pr.run({ name: 'mcp__browser__unsafe_tool', input: {} }, undefined, { servers: [server(['unsafe_tool'])] })
    expect(out).not.toContain('RAN')
    expect(out).toBe('TOOL NOT OFFERED: mcp__browser__unsafe_tool')   // a denied tool is not offered to the model at all
  }, 90_000)
  test('a tool of the same server that is not named still runs', async () => {
    const out = await pr.run({ name: 'mcp__browser__harmless', input: {} }, undefined, { servers: [server(['unsafe_tool'])] })
    expect(out).toContain('RAN harmless')
  }, 90_000)

  describe('the start check, on the real Claude Code\'s own debug file (the parser and the comparison the daemon\'s start check uses)', () => {
    const want = (denyTools?: string[]) => { const r = confinementRules({ denyCommands: [], cannotRead: pr.places(), servers: [{ name: 'browser', command: 'x', tokenEnv: [], profileArgs: [], profileEnv: {}, ...(denyTools && { denyTools }) }] }); return { ...r, servers: ['browser'] } }
    test('a launch with deny_tools set applied its rule: nothing is short', async () => {
      await pr.run({ name: 'mcp__browser__harmless', input: {} }, undefined, { servers: [server(['unsafe_tool'])] })
      expect(want(['unsafe_tool']).deny).toContain('mcp__browser__unsafe_tool')
      expect(confinementShortfall(want(['unsafe_tool']), readLoaded(pr.lastDebug()))).toEqual([])
    }, 90_000)
    test('a launch whose settings lacked the rule is caught: the check names the missing deny rule', async () => {
      await pr.run({ name: 'mcp__browser__harmless', input: {} }, undefined, { servers: [server()] })
      expect(confinementShortfall(want(['unsafe_tool']), readLoaded(pr.lastDebug())).join(' ')).toContain('it did not apply these deny rules: `mcp__browser__unsafe_tool`')
    }, 90_000)
  })
})
