import { readFileSync } from 'fs'

/** Parse a single .env line into [key, value], handling `export`, quotes, and inline comments. */
export function parseEnvLine(line: string): [string, string] | null {
  const m = line.trim().match(/^(?:export\s+)?(\w+)=(.*)$/)
  if (!m) return null
  let val = m[2]
  if (val.startsWith('"')) {
    val = val.slice(1)
    const end = val.indexOf('"')
    if (end !== -1) val = val.slice(0, end)
  } else if (val.startsWith("'")) {
    val = val.slice(1)
    const end = val.indexOf("'")
    if (end !== -1) val = val.slice(0, end)
  } else {
    val = val.replace(/\s+#.*$/, '').trimEnd()
  }
  return [m[1], val]
}

/** Backfill process.env from .env files. A var already set to blank or
 *  whitespace counts as absent, so a blank inherited value self-heals. */
export function sourceEnvFiles(paths: string[]): void {
  for (const path of paths) {
    let body: string
    try { body = readFileSync(path, 'utf8') } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== 'ENOENT') process.stderr.write(`hydra: cannot read ${path} (${code}) — falling back to defaults\n`)
      continue
    }
    for (const line of body.split('\n')) {
      const parsed = parseEnvLine(line)
      if (parsed && (process.env[parsed[0]] ?? '').trim() === '') process.env[parsed[0]] = parsed[1]
    }
  }
}
