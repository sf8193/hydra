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

// Every name a sourced .env file set, whether or not the process already had it: what the files contribute to a session's environment.
const sourced = new Set<string>()

/** The names the .env files given to sourceEnvFiles hold, in this process. */
export function sourcedEnvNames(): string[] {
  return [...sourced]
}

/** Empties sourcedEnvNames. For tests only. */
export function _resetSourcedEnvNamesForTesting(): void {
  sourced.clear()
}

// The KEY=VALUE pairs of one .env file, in order, or undefined when it cannot be read (said on stderr, unless it does not exist).
function readEnvFile(path: string): Array<[string, string]> | undefined {
  let body: string
  try { body = readFileSync(path, 'utf8') } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'ENOENT') process.stderr.write(`hydra: cannot read ${path} (${code}) — falling back to defaults\n`)
    return undefined
  }
  return body.split('\n').map(parseEnvLine).filter((p): p is [string, string] => p !== null)
}

/** Backfill process.env from .env files. A var already set to blank or
 *  whitespace counts as absent, so a blank inherited value self-heals. */
export function sourceEnvFiles(paths: string[]): void {
  for (const path of paths) for (const [k, v] of readEnvFile(path) ?? []) {
    sourced.add(k)
    if ((process.env[k] ?? '').trim() === '') process.env[k] = v
  }
}

/**
 * The boot loader again, for a file edited after boot: sets only the names this process has not loaded (`loaded` says which it has,
 * besides process.env), so a value already loaded is never changed and nothing is unset. Returns the names it set; never their values.
 */
export function sourceNewEnvNames(paths: string[], loaded: (name: string) => boolean): string[] {
  const added: string[] = []
  for (const path of paths) for (const [k, v] of readEnvFile(path) ?? []) {
    if (process.env[k] !== undefined || loaded(k) || added.includes(k)) continue
    process.env[k] = v
    sourced.add(k)
    added.push(k)
  }
  return added
}
