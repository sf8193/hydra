// The token variables a hydra.toml on disk names, scrubbed from every spawn before the file is loaded. The names and the
// scan: config/token-vars.ts.

import { readFileSync } from 'fs'
import type { SpawnVarRefusal } from '../shared/spawn-env.js'
import { scrubTokenVarsNamedIn } from '../config/token-vars.js'

/** scrubTokenVarsNamedIn, for the file at `path`; a missing or unreadable file names nothing. */
export function scrubTokenVarsInFile(path: string): SpawnVarRefusal[] {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return [] }
  return scrubTokenVarsNamedIn(text)
}
