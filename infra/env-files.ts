import { readFileSync } from 'fs'
import { sourceEnvText } from '../shared/env-parse.js'

/** Backfill process.env from .env files, in order (sourceEnvText). A missing file is skipped; an unreadable one is said. */
export function sourceEnvFiles(paths: string[]): void {
  for (const path of paths) {
    let body: string
    try { body = readFileSync(path, 'utf8') } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== 'ENOENT') process.stderr.write(`hydra: cannot read ${path} (${code}) — falling back to defaults\n`)
      continue
    }
    sourceEnvText(body)
  }
}
