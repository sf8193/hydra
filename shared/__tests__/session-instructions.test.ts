import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { SESSION_INSTRUCTIONS } from '../constants.js'

// The text moved out of bridge.ts so omp's extension can send it too. The fixture is that text, which a change to SESSION_INSTRUCTIONS updates on purpose (it began as bridge.ts's text at hydra c2d223b).
test('SESSION_INSTRUCTIONS is the text bridge.ts sent as MCP instructions', () => {
  expect(SESSION_INSTRUCTIONS).toBe(readFileSync(join(import.meta.dir, 'fixtures', 'session-instructions.txt'), 'utf8'))
})
