import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { RULES, hits, violations, type Rule } from '../../scripts/check-rules.js'

const file = (path: string, ...lines: string[]) => ({ path, text: lines.join('\n') })
const rule = (id: string) => RULES.find(r => r.id === id)!
/** The real rule with its own ALLOWED list. */
const withAllowed = (id: string, allowed: string[]): Rule[] => [{ ...rule(id), allowed }]

describe('check-rules', () => {
  test('the rules, and each name rule has a fix that names where the capability goes', () => {
    expect(RULES.map(r => r.id)).toEqual(['platform-name-branch', 'engine-name-branch', 'io-in-core'])
    for (const r of RULES.filter(r => r.id !== 'io-in-core')) {
      expect(r.principle).toBe('capabilities, not names')
      expect(r.fix).toMatch(/give the (gateway|engine) a capability .*(gateways\/gateway\.ts|engines\/engine-adapter\.ts)/)
    }
  })

  test('a new hit fails, and the error names the file, line, rule, principle and fix', () => {
    const v = violations([file('app/x.ts', 'const a = 1', "if (gateway.platform === 'slack') return")], withAllowed('platform-name-branch', []))
    expect(v).toHaveLength(1)
    expect(v[0]).toStartWith("app/x.ts:2: platform-name-branch (capabilities, not names): gateway.platform === 'slack'. To fix: give the gateway a capability")
    expect(v[0]).toContain(`add "x.ts: gateway.platform === 'slack'" to its ALLOWED`)
  })

  test('each way of branching on a name is a hit: either side, !=, a case label, PLATFORM, a wrapped line', () => {
    const engine = (...lines: string[]) => hits([file('app/x.ts', ...lines)], withAllowed('engine-name-branch', [])).map(h => h.entry)
    expect(engine("if (info.engine !== 'codex') {}")).toEqual(["x.ts: info.engine !== 'codex'"])
    expect(engine('if ("claude" == selected?.engine) {}')).toEqual(['x.ts: "claude" == selected?.engine'])
    expect(engine("switch (info.engine) { case 'agy': break }")).toEqual(["x.ts: case 'agy':"])
    expect(engine('const ok = info.engine', "  === 'omp'")).toEqual(["x.ts: info.engine === 'omp'"])
    expect(engine("if ((info.engine ?? 'claude') === 'claude') {}")).toEqual(["x.ts: (info.engine ?? 'claude') === 'claude'"])
    const platform = hits([file('app/x.ts', "if (PLATFORM != 'discord') {}")], withAllowed('platform-name-branch', []))
    expect(platform.map(h => h.entry)).toEqual(["x.ts: PLATFORM != 'discord'"])
  })

  test('not hits: an owner folder, tests, scripts, comments, a name as data, another subject', () => {
    const quiet = [
      file('gateways/slack.ts', "if (platform === 'slack') {}"),
      file('engines/boot.ts', "if (engine === 'codex') {}"),
      file('routing/route.ts', "const isSlackPlace = (p) => p.platform === 'slack'"),
      file('app/__tests__/x.test.ts', "if (engine === 'codex') {}"),
      file('app/y.test.ts', "if (engine === 'codex') {}"),
      file('scripts/x.ts', "if (engine === 'codex') {}"),
      file('app/x.ts', "// if (engine === 'codex') {}", "/* engine === 'claude' */", "const e = { engine: 'codex' }", "if (kind === 'slack') {}"),
    ]
    expect(violations(quiet, RULES.map(r => ({ ...r, allowed: [] })))).toEqual([])
  })

  test('an allowed hit passes; an entry that no longer matches fails, so the list only shrinks', () => {
    const allowed = withAllowed('engine-name-branch', ["x.ts: info.engine === 'claude'"])
    expect(violations([file('app/x.ts', "if (info.engine === 'claude') {}")], allowed)).toEqual([])
    const gone = violations([file('app/x.ts', 'if (adapter.canFork) {}')], allowed)
    expect(gone).toHaveLength(1)
    expect(gone[0]).toStartWith(`engine-name-branch: "x.ts: info.engine === 'claude'" is in ALLOWED 1 time(s) but matches 0. Delete the extra entry`)
  })

  test('a second hit of an allowed entry fails once, naming both lines', () => {
    const v = violations([file('app/x.ts', "if (info.engine === 'claude') {}", "if (info.engine === 'claude') {}")], withAllowed('engine-name-branch', ["x.ts: info.engine === 'claude'"]))
    expect(v).toEqual([`app/x.ts:1, app/x.ts:2: engine-name-branch (capabilities, not names): info.engine === 'claude' appears 2 times, ALLOWED has it 1; one of these is new. To fix: ${rule('engine-name-branch').fix}`])
  })

  test('moving a file to another folder keeps its entries; a move into an owner folder makes them stale', () => {
    const allowed = withAllowed('engine-name-branch', ["x.ts: info.engine === 'claude'"])
    const line = "if (info.engine === 'claude') {}"
    expect(violations([file('daemon/x.ts', line)], allowed)).toEqual([])
    expect(violations([file('app/x.ts', line)], allowed)).toEqual([])
    expect(violations([file('app/use-cases/x.ts', line)], allowed)).toEqual([])
    expect(violations([file('engines/x.ts', line)], allowed)[0]).toContain('Delete the extra entry')
  })

  describe('io-in-core', () => {
    const io = (path: string, ...lines: string[]) => hits([file(path, ...lines)], withAllowed('io-in-core', [])).map(h => h.entry)

    test('a new hit fails, naming the principle and the move', () => {
      const v = violations([file('shared/x.ts', "import { readFileSync } from 'fs'")], withAllowed('io-in-core', []))
      expect(v).toEqual([`shared/x.ts:1: io-in-core (tier 0 does no I/O): from 'fs'. To fix: ${rule('io-in-core').fix}. If it must stay, add "x.ts: from 'fs'" to its ALLOWED in scripts/check-rules.ts and say why in the PR`])
      expect(rule('io-in-core').fix).toContain('move the I/O to infra/ (tier 1)')
    })

    test('each way in is a hit: fs, fs/promises, child_process, net, node:, a dynamic import, require, Bun.spawn/write/file', () => {
      expect(io('shared/x.ts',
        "import { readFileSync } from 'fs'",
        'import { readFile } from "fs/promises"',
        "import * as cp from 'child_process'",
        "import { createServer } from 'node:net'",
        "const fs = await import('node:fs')",
        "const cp2 = require('child_process')",
        "Bun.spawn(['ls']); Bun.spawnSync(['ls']); Bun.write('f', ''); Bun.file('f')",
        "Bun.serve({}); Bun.connect({}); Bun.listen({}); await Bun.$`ls`; await fetch(url)",
      )).toEqual([
        "x.ts: from 'fs'", 'x.ts: from "fs/promises"', "x.ts: from 'child_process'", "x.ts: from 'node:net'",
        "x.ts: import('node:fs')", "x.ts: require('child_process')",
        'x.ts: Bun.spawn', 'x.ts: Bun.spawnSync', 'x.ts: Bun.write', 'x.ts: Bun.file',
        'x.ts: Bun.serve', 'x.ts: Bun.connect', 'x.ts: Bun.listen', 'x.ts: Bun.$', 'x.ts: fetch(',
      ])
    })

    test('an earlier type-only import hides nothing after it', () => {
      expect(io('shared/x.ts', "import type { A } from './a.js'", "import { readFileSync } from 'fs'")).toEqual(["x.ts: from 'fs'"])
      expect(io('shared/x.ts', "import type { Stats } from 'fs'", "import { readFileSync } from 'fs'")).toEqual(["x.ts: from 'fs'"])
    })

    test('only tier 0 is checked: shared/, config/, routing/ and the tier-0 root file; every other tier may do I/O', () => {
      const line = "import { readFileSync } from 'fs'"
      for (const path of ['shared/x.ts', 'shared/engines/x.ts', 'config/x.ts', 'routing/x.ts', 'throttled-queue.ts']) expect(io(path, line)).toHaveLength(1)
      for (const path of ['infra/x.ts', 'gateways/x.ts', 'sessions/x.ts', 'app/x.ts', 'daemon.ts', 'cli/x.ts', 'shared/__tests__/x.test.ts']) expect(io(path, line)).toEqual([])
    })

    test('not hits: a type-only import, a path module, a comment, a module named like one, an injected fetch', () => {
      expect(io('shared/x.ts',
        "import type { Stats } from 'fs'",
        "import { join } from 'path'",
        "// import { readFileSync } from 'fs'",
        "import { x } from './fs-names.js'",
        'const r = await this.o.fetch(url); doFetch(url)',
      )).toEqual([])
    })
  })

  test('the repo today matches the allowlist exactly', () => {
    const root = join(import.meta.dir, '..', '..')
    const paths = execFileSync('git', ['ls-files', '*.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
    expect(violations(paths.map(path => ({ path, text: readFileSync(join(root, path), 'utf8') })))).toEqual([])
  })
})
