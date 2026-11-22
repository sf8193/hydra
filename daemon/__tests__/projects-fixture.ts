import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join, resolve } from 'path'
import { projectsRoot } from '../usage.js'
import { isUnder } from '../../shared/path-containment.js'
import { TEST_STATE_DIR } from '../../test-setup.js'

// Refuse to write anywhere but a throwaway root. The assertion in usage.test.ts
// only reports damage already done; this stops it happening. Compared against
// the dir the preload actually created — `tmpdir()` reads TMPDIR, so setting
// that to $HOME was enough to plant a fixture in the real ~/.claude/projects.
function assertIsolated(root: string): void {
  const allowed = resolve(TEST_STATE_DIR)
  if (isUnder(root, allowed)) return
  const r = resolve(root)
  throw new Error(
    `projects-fixture: refusing to plant in ${r} — outside the suite's own state dir (${allowed}). ` +
    `Run the suite via \`bun test\` from the repo root so bunfig.toml's preload applies.`,
  )
}

export const uniqueClaudeId = (prefix: string): string => `${prefix}-${randomUUID()}`

// transcriptPathFor() scans the projects root, so a fixture has to live there.
// test-setup.ts points CLAUDE_CONFIG_DIR at a throwaway dir, so this never
// touches the developer's real one. mkdtemp for the dir because it is atomic —
// a pid+timestamp name collides between two test files in the same millisecond.
export function plantTranscript(claudeSessionId: string, body: string): { path: string; dir: string; cleanup: () => void } {
  const root = projectsRoot()
  assertIsolated(root)
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, '-hydra-fixture-'))
  const path = join(dir, `${claudeSessionId}.jsonl`)
  writeFileSync(path, body)
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
