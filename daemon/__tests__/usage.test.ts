import { describe, test, expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { projectDirName, projectDirNames, projectsRoot, transcriptPathFor } from '../../infra/usage.js'
import { plantTranscript, uniqueClaudeId } from './projects-fixture.js'
import { claudeConfigDir } from '../../shared/constants.js'
import { TEST_STATE_DIR } from '../../test-setup.js'

const line = (usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...extra, message: { role: 'assistant', usage } }) + '\n'

describe('usage: locating the transcript', () => {
  test.each([
    ['/Users/kevin/RubymineProjects/hydra', '-Users-kevin-RubymineProjects-hydra'],
    ['/Users/kevin/RubymineProjects/.worktrees/hydra-atlas', '-Users-kevin-RubymineProjects--worktrees-hydra-atlas'],
  ])('%p encodes to %p', (cwd, dir) => {
    expect(projectDirName(cwd)).toBe(dir)
  })

  // A fork spawned into a worktree runs at spawnCwd, so its transcript is NOT
  // under a dir derived from the worktree path. Only a scan finds it.
  test('finds a transcript whose directory bears no relation to the session cwd', () => {
    const id = uniqueClaudeId('fork')
    const planted = plantTranscript(id, line({ output_tokens: 1 }))
    try {
      expect(transcriptPathFor(id)).toBe(planted.path)
      expect(planted.dir).not.toContain(projectDirName('/Users/kevin/RubymineProjects/.worktrees/hydra-atlas'))
    } finally { planted.cleanup() }
  })

  // Total, so a session with no transcript still reaches `unresolved` — the
  // count that names CLAUDE_CONFIG_DIR. The root failure is reported separately,
  // once per tick, because it is one fleet-wide condition and not 25.
  test('an unreadable projects root resolves to undefined, and is separately visible', () => {
    const saved = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), `absent-${randomUUID()}`)
    try {
      expect(transcriptPathFor('anything')).toBeUndefined()
      expect(() => projectDirNames(), 'the tick probes this to name the cause').toThrow()
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })

  test('an id with no transcript anywhere resolves to undefined, not a bogus path', () => {
    const decoy = plantTranscript(uniqueClaudeId('decoy'), line({ output_tokens: 1 }))
    // An empty id would otherwise probe for a file literally named '.jsonl'.
    writeFileSync(join(decoy.dir, '.jsonl'), '')
    try {
      expect(transcriptPathFor(uniqueClaudeId('never-written'))).toBeUndefined()
      expect(transcriptPathFor('')).toBeUndefined()
    } finally { decoy.cleanup() }
  })
})

describe('usage: the suite never writes into a real Claude config dir', () => {
  // The assertions below only report damage already done; this refuses first.
  // The id arrives from the bridge as an unvalidated cast and becomes a path
  // segment here, so a traversal must not resolve — planted outside the root so
  // the check is what stops it, not the file simply being absent.
  test('a session id that traverses out of the projects root finds nothing', () => {
    const planted = plantTranscript(uniqueClaudeId('inside'), '')
    try {
      const escapeTarget = join(claudeConfigDir(), 'escape.jsonl')
      writeFileSync(escapeTarget, '')
      try {
        // join(projectsRoot(), <fixtureDir>, '../../escape.jsonl') lands on it.
        expect(existsSync(escapeTarget), 'the traversal target must really exist').toBe(true)
        expect(transcriptPathFor('../../escape')).toBeUndefined()
      } finally { rmSync(escapeTarget, { force: true }) }
    } finally { planted.cleanup() }
  })

  // readdirSync returns the link name and join+existsSync follow it, so an
  // entry planted inside the root can still point at a file outside it. This is
  // the one path-read the PR added that wasn't using its own containment helper.
  test('a symlinked project dir pointing outside the root is not followed', () => {
    const root = projectsRoot()
    const outside = mkdtempSync(join(tmpdir(), 'outside-root-'))
    const link = join(root, '-hydra-symlink-probe')
    try {
      const id = uniqueClaudeId('escapee')
      writeFileSync(join(outside, `${id}.jsonl`), JSON.stringify({ cwd: '/Users/kevin/private' }) + '\n')
      mkdirSync(root, { recursive: true })
      symlinkSync(outside, link)

      expect(existsSync(join(link, `${id}.jsonl`)), 'the link really does reach it').toBe(true)
      expect(transcriptPathFor(id), 'but the reader must not').toBeUndefined()
    } finally {
      rmSync(link, { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('an id outside the session-id shape is refused before it becomes a path', () => {
    expect(transcriptPathFor('..')).toBeUndefined()
    expect(transcriptPathFor('a/b')).toBeUndefined()
  })

  // A sibling, not a real directory: reproducing the original $HOME bug would
  // mean planting in $HOME, which is the thing being prevented. testStateDirRefusal
  // covers that direction without writing anything.
  test('planting outside the isolated root throws instead of writing', () => {
    const saved = process.env.CLAUDE_CONFIG_DIR
    try {
      process.env.CLAUDE_CONFIG_DIR = `${TEST_STATE_DIR}-EVIL`
      expect(() => plantTranscript(uniqueClaudeId('escape'), '')).toThrow(/outside the suite's own state dir/)
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })

  // Deleting the isolation in test-setup.ts left the suite green while planting
  // fixtures in the developer's live ~/.claude/projects. 19 leaked copies of one
  // fixture id made a scan return an arbitrary file and a test pass by accident.
  test('projectsRoot resolves under the throwaway state dir, not the real home', () => {
    const stateDir = process.env.HYDRA_STATE_DIR
    expect(stateDir, 'test-setup must have isolated the state dir').toBeTruthy()
    expect(projectsRoot().startsWith(stateDir!), `projectsRoot ${projectsRoot()} escaped ${stateDir}`).toBe(true)
    expect(projectsRoot().endsWith(`${sep}projects`), 'the real directory Claude writes is "projects"').toBe(true)
  })

  test('a planted fixture lands under that root', () => {
    const planted = plantTranscript(uniqueClaudeId('iso'), line({ output_tokens: 1 }))
    try {
      expect(planted.path.startsWith(projectsRoot())).toBe(true)
      expect(planted.path.startsWith(claudeConfigDir()), 'never outside the isolated config dir').toBe(true)
    } finally { planted.cleanup() }
  })
})

// A real transcript writes ONE content block per line, every line repeating the
// turn's whole usage envelope. So the tool_use blocks land on exactly the lines
// the envelope dedupe throws away. Reading tool names after the dedupe sees
// almost no tools at all.
// Exported so the turn-assembly half can be exercised without touching fs; the
// export claimed that and nothing imported it.
