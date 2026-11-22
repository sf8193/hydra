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

/** The names the .env files sourced in this process hold (sourceEnvText). */
export function sourcedEnvNames(): string[] {
  return [...sourced]
}

/** Empties sourcedEnvNames. For tests only. */
export function _resetSourcedEnvNamesForTesting(): void {
  sourced.clear()
}

/** Backfill process.env from one .env file's text. A var already set to blank or whitespace counts as absent, so a
 *  blank inherited value self-heals. Reading the files: sourceEnvFiles (infra/env-files.ts). */
export function sourceEnvText(body: string): void {
  for (const line of body.split('\n')) {
    const parsed = parseEnvLine(line)
    if (parsed) sourced.add(parsed[0])
    if (parsed && (process.env[parsed[0]] ?? '').trim() === '') process.env[parsed[0]] = parsed[1]
  }
}
